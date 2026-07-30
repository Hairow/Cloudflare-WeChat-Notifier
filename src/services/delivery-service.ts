import type {
  BotListItem,
  CompensateStaleQueuedResult,
  DeleteDeliveriesResult,
  DeliveryListQuery,
  DeliveryListResult,
  DeliveryLog,
  EnqueueDeliveryResult,
  IncomingMessagePayload,
  KeepaliveConfig,
  QueueProcessResult,
  ReplayDeliveryResult,
  ReplayDeliveriesResult,
  ReplayFailedRetMinusTwoResult,
  ScheduledKeepalivePerBotResult,
  ScheduledKeepaliveResult
} from "../contracts";
import { IlinkClient } from "../ilink/client";
import { AppError, isIlinkApiError, toErrorMessage } from "../lib/errors";
import { createTraceId } from "../lib/id";
import { BotStateRepository } from "../storage/bot-state-repository";
import { DeliveryLogRepository } from "../storage/delivery-log-repository";

const RETRYABLE_ATTEMPTS = 3;
const MS_PER_HOUR = 60 * 60 * 1000;
const REPLAYABLE_STATUS_MESSAGE = "仅支持重发 failed 状态的投递记录。";

export class DefaultDeliveryService {
  public constructor(
    private readonly queue: Queue<{ deliveryId: string }>,
    private readonly deliveryLogRepository: DeliveryLogRepository,
    private readonly botRepository: BotStateRepository,
    private readonly ilinkClient: IlinkClient
  ) {}

  /**
   * 将消息写入 D1 并投入 Cloudflare Queue，关联到指定 Bot。
   */
  public async enqueueDelivery(botId: string, source: string, payload: IncomingMessagePayload): Promise<EnqueueDeliveryResult> {
    const result = await this.deliveryLogRepository.createQueued({
      botId,
      source,
      traceId: payload.traceId ?? createTraceId(),
      dedupeKey: payload.dedupeKey ?? null,
      text: payload.text,
      meta: payload.meta ?? null
    });

    if (result.duplicate) {
      return {
        deliveryId: result.delivery.deliveryId,
        botId: result.delivery.botId,
        duplicate: true,
        status: result.delivery.status
      };
    }

    try {
      await this.queue.send(
        {
          deliveryId: result.delivery.deliveryId
        },
        {
          contentType: "json"
        }
      );
    } catch (error) {
      const message = `消息入队失败: ${toErrorMessage(error)}`;
      await this.deliveryLogRepository.markFailed(result.delivery.deliveryId, 0, message, null);
      throw error;
    }

    return {
      deliveryId: result.delivery.deliveryId,
      botId: result.delivery.botId,
      duplicate: false,
      status: "queued"
    };
  }

  public async listDeliveries(query: DeliveryListQuery): Promise<DeliveryListResult> {
    const total = await this.deliveryLogRepository.count(query);
    const totalPages = Math.max(1, Math.ceil(total / query.limit));
    const page = Math.min(Math.max(query.page, 1), totalPages);
    const items = await this.deliveryLogRepository.list({ ...query, page });
    return {
      items,
      limit: query.limit,
      page,
      total,
      totalPages,
      status: query.status,
      source: query.source,
      botId: query.botId
    };
  }

  public async getDelivery(deliveryId: string): Promise<DeliveryLog | null> {
    return this.deliveryLogRepository.getById(deliveryId);
  }

  public async replayDelivery(deliveryId: string): Promise<ReplayDeliveryResult> {
    const delivery = await this.deliveryLogRepository.getById(deliveryId);
    if (!delivery) {
      throw new AppError(404, "delivery_not_found", "未找到对应的投递记录。");
    }

    return this.replayFailedDelivery(delivery);
  }

  public async replayDeliveries(deliveryIds: string[]): Promise<ReplayDeliveriesResult> {
    const items: ReplayDeliveryResult[] = [];

    for (const deliveryId of deliveryIds) {
      const delivery = await this.deliveryLogRepository.getById(deliveryId);
      if (!delivery) {
        items.push({
          deliveryId,
          status: "failed",
          replayed: false,
          error: "未找到对应的投递记录。"
        });
        continue;
      }

      if (delivery.status !== "failed") {
        items.push({
          deliveryId,
          status: delivery.status,
          replayed: false,
          error: REPLAYABLE_STATUS_MESSAGE
        });
        continue;
      }

      try {
        items.push(await this.replayFailedDelivery(delivery));
      } catch (error) {
        items.push({
          deliveryId,
          status: "failed",
          replayed: false,
          error: toErrorMessage(error)
        });
      }
    }

    return { items };
  }

  public async deleteCompletedDeliveries(deliveryIds: string[]): Promise<DeleteDeliveriesResult> {
    const deleted = await this.deliveryLogRepository.deleteCompletedByIds(deliveryIds);
    return {
      selected: deliveryIds.length,
      deleted,
      skipped: deliveryIds.length - deleted
    };
  }

  public async replayFailedRetMinusTwo(query: { limit: number; source?: string }): Promise<ReplayFailedRetMinusTwoResult> {
    const deliveries = await this.deliveryLogRepository.listFailedRetMinusTwo(query);
    const items: ReplayDeliveryResult[] = [];

    for (const delivery of deliveries) {
      try {
        await this.deliveryLogRepository.markQueuedForReplay(delivery.deliveryId);
        await this.sendDeliveryToQueue(delivery.deliveryId);
        items.push({
          deliveryId: delivery.deliveryId,
          status: "queued",
          replayed: true,
          error: null
        });
      } catch (error) {
        const message = toErrorMessage(error);
        await this.deliveryLogRepository.markFailed(delivery.deliveryId, 0, message, null);
        items.push({
          deliveryId: delivery.deliveryId,
          status: "failed",
          replayed: false,
          error: message
        });
      }
    }

    return {
      items,
      limit: query.limit,
      source: query.source
    };
  }

  public async compensateStaleQueued(query: {
    limit: number;
    olderThanMinutes: number;
    source?: string;
  }): Promise<CompensateStaleQueuedResult> {
    const cutoff = new Date(Date.now() - query.olderThanMinutes * 60 * 1000).toISOString();
    const deliveries = await this.deliveryLogRepository.listStaleQueuedAttemptsZero({
      limit: query.limit,
      beforeIso: cutoff,
      source: query.source
    });
    const items: ReplayDeliveryResult[] = [];

    for (const delivery of deliveries) {
      try {
        await this.deliveryLogRepository.markQueuedForReplay(delivery.deliveryId);
        await this.sendDeliveryToQueue(delivery.deliveryId);
        items.push({
          deliveryId: delivery.deliveryId,
          status: "queued",
          replayed: true,
          error: null
        });
      } catch (error) {
        const message = toErrorMessage(error);
        await this.deliveryLogRepository.markFailed(delivery.deliveryId, 0, message, null);
        items.push({
          deliveryId: delivery.deliveryId,
          status: "failed",
          replayed: false,
          error: message
        });
      }
    }

    return {
      items,
      limit: query.limit,
      olderThanMinutes: query.olderThanMinutes,
      source: query.source
    };
  }

  /**
   * 检查所有 Bot 的保活状态并执行保活。
   * 多 Bot 模式下遍历所有 ready 的 Bot，逐个发送保活消息。
   */
  public async enqueueKeepaliveIfDue(config: KeepaliveConfig, now = new Date()): Promise<ScheduledKeepaliveResult> {
    const perBot: ScheduledKeepalivePerBotResult[] = [];

    if (!config.enabled) {
      const bots = await this.botRepository.listAllBrief();
      for (const bot of bots) {
        perBot.push({
          botId: bot.botId,
          label: bot.label,
          enqueued: false,
          reason: "disabled",
          deliveryId: null,
          lastDeliveryId: null,
          lastCreatedAt: null,
          nextDueAt: null
        });
      }
      return { enqueued: false, perBot };
    }

    // 获取所有 ready 状态的 Bot
    const readyBots = await this.botRepository.listAll();
    const readyIds = new Set(readyBots.filter((b) => b.status === "ready").map((b) => b.botId));
    const allBots = await this.botRepository.listAllBrief();

    for (const botInfo of allBots) {
      if (!readyIds.has(botInfo.botId)) {
        perBot.push({
          botId: botInfo.botId,
          label: botInfo.label,
          enqueued: false,
          reason: "skipped",
          deliveryId: null,
          lastDeliveryId: null,
          lastCreatedAt: null,
          nextDueAt: null
        });
        continue;
      }

      const latest = (await this.listDeliveries({ limit: 1, page: 1, source: config.source, botId: botInfo.botId })).items[0] ?? null;
      const intervalMs = config.intervalHours * MS_PER_HOUR;
      const nextDueAt = latest ? new Date(new Date(latest.createdAt).getTime() + intervalMs) : null;

      if (nextDueAt && nextDueAt.getTime() > now.getTime()) {
        perBot.push({
          botId: botInfo.botId,
          label: botInfo.label,
          enqueued: false,
          reason: "not_due",
          deliveryId: null,
          lastDeliveryId: latest.deliveryId,
          lastCreatedAt: latest.createdAt,
          nextDueAt: nextDueAt.toISOString()
        });
        continue;
      }

      const intervalBucket = Math.floor(now.getTime() / intervalMs);
      const result = await this.enqueueDelivery(botInfo.botId, config.source, {
        text: config.text,
        traceId: `keepalive-${botInfo.botId}-${intervalBucket}`,
        dedupeKey: `interval-${intervalBucket}`,
        meta: {
          kind: "keepalive",
          intervalHours: config.intervalHours,
          scheduledAt: now.toISOString()
        }
      });

      perBot.push({
        botId: botInfo.botId,
        label: botInfo.label,
        enqueued: !result.duplicate,
        reason: result.duplicate ? "duplicate" : "queued",
        deliveryId: result.deliveryId,
        lastDeliveryId: latest?.deliveryId ?? null,
        lastCreatedAt: latest?.createdAt ?? null,
        nextDueAt: new Date(now.getTime() + intervalMs).toISOString()
      });
    }

    return {
      enqueued: perBot.some((b) => b.enqueued),
      perBot
    };
  }

  /**
   * 队列消费者：处理单条投递。
   * 从 delivery.botId 查找对应 Bot，不再使用全局单例。
   */
  public async processQueuedDelivery(deliveryId: string, attempts: number): Promise<QueueProcessResult> {
    const delivery = await this.deliveryLogRepository.getById(deliveryId);
    if (!delivery) {
      return {
        outcome: "ack",
        deliveryStatus: "not_found"
      };
    }

    const bot = await this.botRepository.getById(delivery.botId);
    if (!bot) {
      const message = `未找到 botId=${delivery.botId} 的 Bot，可能已被删除。`;
      await this.deliveryLogRepository.markFailed(deliveryId, attempts, message, null);
      return {
        outcome: "ack",
        deliveryStatus: "failed",
        error: message,
        responseCode: null
      };
    }

    if (!bot.contextToken || bot.status === "logged_in" || bot.status === "needs_activation") {
      const message = "bot 尚未激活，请先调用 /admin/bot/:botId/activate。";
      await this.botRepository.updateStatus(delivery.botId, "needs_activation", message);
      await this.deliveryLogRepository.markFailed(deliveryId, attempts, message, null);
      return {
        outcome: "ack",
        deliveryStatus: "failed",
        error: message,
        responseCode: null
      };
    }

    try {
      await this.ilinkClient.sendMessage(bot, delivery.text);
      await this.botRepository.setLastError(delivery.botId, null);
      await this.deliveryLogRepository.markDelivered(deliveryId, attempts, 200);
      return {
        outcome: "ack",
        deliveryStatus: "delivered",
        error: null,
        responseCode: 200
      };
    } catch (error) {
      const message = toErrorMessage(error);
      if (isIlinkApiError(error)) {
        if (error.category === "retryable" && attempts <= RETRYABLE_ATTEMPTS) {
          await this.deliveryLogRepository.markRetrying(deliveryId, attempts, message, error.httpStatus ?? null);
          return {
            outcome: "retry",
            delaySeconds: attempts * 5,
            deliveryStatus: "retrying",
            error: message,
            responseCode: error.httpStatus ?? null
          };
        }

        if (error.category === "unauthorized") {
          await this.botRepository.updateStatus(delivery.botId, "needs_login", message);
        } else if (error.category === "context") {
          await this.botRepository.updateStatus(delivery.botId, "needs_activation", message);
        } else {
          await this.botRepository.setLastError(delivery.botId, message);
        }

        await this.deliveryLogRepository.markFailed(deliveryId, attempts, message, error.httpStatus ?? null);
        return {
          outcome: "ack",
          deliveryStatus: "failed",
          error: message,
          responseCode: error.httpStatus ?? null
        };
      }

      if (attempts <= RETRYABLE_ATTEMPTS) {
        await this.deliveryLogRepository.markRetrying(deliveryId, attempts, message, null);
        return {
          outcome: "retry",
          delaySeconds: attempts * 5,
          deliveryStatus: "retrying",
          error: message,
          responseCode: null
        };
      }

      await this.botRepository.setLastError(delivery.botId, message);
      await this.deliveryLogRepository.markFailed(deliveryId, attempts, message, null);
      return {
        outcome: "ack",
        deliveryStatus: "failed",
        error: message,
        responseCode: null
      };
    }
  }

  public async handleQueueProcessingError(deliveryId: string, attempts: number, error: unknown): Promise<QueueProcessResult> {
    const message = `队列处理异常: ${toErrorMessage(error)}`;

    try {
      const delivery = await this.deliveryLogRepository.getById(deliveryId);
      if (!delivery) {
        return {
          outcome: "ack",
          deliveryStatus: "not_found"
        };
      }

      if (attempts <= RETRYABLE_ATTEMPTS) {
        await this.deliveryLogRepository.markRetrying(deliveryId, attempts, message, null);
        return {
          outcome: "retry",
          delaySeconds: Math.max(attempts, 1) * 5,
          deliveryStatus: "retrying",
          error: message,
          responseCode: null
        };
      }

      await this.deliveryLogRepository.markFailed(deliveryId, attempts, message, null);
      return {
        outcome: "ack",
        deliveryStatus: "failed",
        error: message,
        responseCode: null
      };
    } catch {
      return attempts <= RETRYABLE_ATTEMPTS
        ? {
            outcome: "retry",
            delaySeconds: Math.max(attempts, 1) * 5,
            deliveryStatus: "retrying",
            error: message,
            responseCode: null
          }
        : {
            outcome: "ack",
            deliveryStatus: "failed",
            error: message,
            responseCode: null
          };
    }
  }

  private async replayFailedDelivery(delivery: DeliveryLog): Promise<ReplayDeliveryResult> {
    if (delivery.status !== "failed") {
      throw new AppError(409, "delivery_not_replayable", REPLAYABLE_STATUS_MESSAGE, {
        status: delivery.status,
        error: delivery.error
      });
    }

    await this.deliveryLogRepository.markQueuedForReplay(delivery.deliveryId);
    await this.sendDeliveryToQueue(delivery.deliveryId);

    return {
      deliveryId: delivery.deliveryId,
      status: "queued",
      replayed: true,
      error: null
    };
  }

  private async sendDeliveryToQueue(deliveryId: string): Promise<void> {
    try {
      await this.queue.send(
        {
          deliveryId
        },
        {
          contentType: "json"
        }
      );
    } catch (error) {
      const message = `消息重新入队失败: ${toErrorMessage(error)}`;
      await this.deliveryLogRepository.markFailed(deliveryId, 0, message, null);
      throw new AppError(502, "delivery_replay_enqueue_failed", message);
    }
  }
}
