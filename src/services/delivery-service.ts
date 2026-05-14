import type {
  CompensateStaleQueuedResult,
  DeliveryListQuery,
  DeliveryListResult,
  DeliveryLog,
  EnqueueDeliveryResult,
  IncomingMessagePayload,
  KeepaliveConfig,
  QueueProcessResult,
  ReplayDeliveryResult,
  ReplayFailedRetMinusTwoResult,
  ScheduledKeepaliveResult
} from "../contracts";
import { IlinkClient } from "../ilink/client";
import { AppError, isIlinkApiError, toErrorMessage } from "../lib/errors";
import { createTraceId } from "../lib/id";
import { BotStateRepository } from "../storage/bot-state-repository";
import { DeliveryLogRepository } from "../storage/delivery-log-repository";

const RETRYABLE_ATTEMPTS = 3;
const RET_MINUS_TWO_PREFIX = "iLink ret=-2";
const MS_PER_HOUR = 60 * 60 * 1000;

export class DefaultDeliveryService {
  public constructor(
    private readonly queue: Queue<{ deliveryId: string }>,
    private readonly deliveryLogRepository: DeliveryLogRepository,
    private readonly botRepository: BotStateRepository,
    private readonly ilinkClient: IlinkClient
  ) {}

  public async enqueueDelivery(source: string, payload: IncomingMessagePayload): Promise<EnqueueDeliveryResult> {
    const result = await this.deliveryLogRepository.createQueued({
      source,
      traceId: payload.traceId ?? createTraceId(),
      dedupeKey: payload.dedupeKey ?? null,
      text: payload.text,
      meta: payload.meta ?? null
    });

    if (result.duplicate) {
      return {
        deliveryId: result.delivery.deliveryId,
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
      duplicate: false,
      status: "queued"
    };
  }

  public async listDeliveries(query: DeliveryListQuery): Promise<DeliveryListResult> {
    const items = await this.deliveryLogRepository.list(query);
    return {
      items,
      limit: query.limit,
      status: query.status,
      source: query.source
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

    if (delivery.status !== "failed" || !delivery.error?.startsWith(RET_MINUS_TWO_PREFIX)) {
      throw new AppError(409, "delivery_not_replayable", "仅支持重放 failed 且错误为 iLink ret=-2 的投递记录。", {
        status: delivery.status,
        error: delivery.error
      });
    }

    await this.deliveryLogRepository.markQueuedForReplay(deliveryId);
    await this.sendDeliveryToQueue(deliveryId);

    return {
      deliveryId,
      status: "queued",
      replayed: true,
      error: null
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

  public async enqueueKeepaliveIfDue(config: KeepaliveConfig, now = new Date()): Promise<ScheduledKeepaliveResult> {
    if (!config.enabled) {
      return {
        enqueued: false,
        reason: "disabled",
        deliveryId: null,
        lastDeliveryId: null,
        lastCreatedAt: null,
        nextDueAt: null
      };
    }

    const latest = (await this.listDeliveries({ limit: 1, source: config.source })).items[0] ?? null;
    const intervalMs = config.intervalHours * MS_PER_HOUR;
    const nextDueAt = latest ? new Date(new Date(latest.createdAt).getTime() + intervalMs) : null;

    if (nextDueAt && nextDueAt.getTime() > now.getTime()) {
      return {
        enqueued: false,
        reason: "not_due",
        deliveryId: null,
        lastDeliveryId: latest.deliveryId,
        lastCreatedAt: latest.createdAt,
        nextDueAt: nextDueAt.toISOString()
      };
    }

    const intervalBucket = Math.floor(now.getTime() / intervalMs);
    const result = await this.enqueueDelivery(config.source, {
      text: config.text,
      traceId: `keepalive-${intervalBucket}`,
      dedupeKey: `interval-${intervalBucket}`,
      meta: {
        kind: "keepalive",
        intervalHours: config.intervalHours,
        scheduledAt: now.toISOString()
      }
    });

    return {
      enqueued: !result.duplicate,
      reason: result.duplicate ? "duplicate" : "queued",
      deliveryId: result.deliveryId,
      lastDeliveryId: latest?.deliveryId ?? null,
      lastCreatedAt: latest?.createdAt ?? null,
      nextDueAt: new Date(now.getTime() + intervalMs).toISOString()
    };
  }

  public async processQueuedDelivery(deliveryId: string, attempts: number): Promise<QueueProcessResult> {
    const delivery = await this.deliveryLogRepository.getById(deliveryId);
    if (!delivery) {
      return {
        outcome: "ack",
        deliveryStatus: "not_found"
      };
    }

    const bot = await this.botRepository.getCurrent();
    if (!bot) {
      const message = "未找到已登录 bot，请重新登录。";
      await this.deliveryLogRepository.markFailed(deliveryId, attempts, message, null);
      return {
        outcome: "ack",
        deliveryStatus: "failed",
        error: message,
        responseCode: null
      };
    }

    if (!bot.contextToken || bot.status === "logged_in" || bot.status === "needs_activation") {
      const message = "bot 尚未激活，请先调用 /admin/bot/activate。";
      await this.botRepository.updateStatus("needs_activation", message);
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
      await this.botRepository.setLastError(null);
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
          await this.botRepository.updateStatus("needs_login", message);
        } else if (error.category === "context") {
          await this.botRepository.updateStatus("needs_activation", message);
        } else {
          await this.botRepository.setLastError(message);
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

      await this.botRepository.setLastError(message);
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
