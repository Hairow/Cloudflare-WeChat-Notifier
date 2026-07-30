/**
 * Cloudflare Queue 消费者
 * ---------------------------------------------------------------------------
 * 本文件是 Worker 的 Queue handler 核心逻辑，负责消费 Cloudflare Queue 中的
 * 投递消息，调用 iLink API 发送消息到微信，并根据结果决定 ack 或 retry。
 *
 * ## 消费流程
 *
 *   Cloudflare Queue 推送消息批次
 *     │
 *     ▼
 *   handleQueueBatch(batch, context)
 *     │
 *     ├─ 校验 deliveryId 是否存在 ──→ 缺失 → ack（丢弃无效消息）
 *     │
 *     ├─ processQueuedDelivery(deliveryId, attempts)
 *     │   │
 *     │   ├─ 成功 → ack     （消息从队列移除，投递状态更新为 delivered）
 *     │   ├─ 失败 → retry   （消息重新入队，带延迟，投递状态更新为 retrying）
 *     │   └─ 永久失败 → ack （超过最大重试次数，投递状态更新为 failed）
 *     │
 *     └─ catch 异常 → handleQueueProcessingError()
 *         │
 *         ├─ 可重试 → retry （如 iLink 5xx、网络超时）
 *         └─ 不可重试 → ack（如 Token 无效、上下文过期）
 *
 * ## 重试策略
 *
 *   重试由 processQueuedDelivery / handleQueueProcessingError 内部决定，
 *   消费者只根据返回的 outcome 字段执行对应操作：
 *
 *     outcome = "ack"   → message.ack()
 *     outcome = "retry" → message.retry({ delaySeconds: N })
 *
 *   延迟公式：attempts × 5 秒（首次 5s，第二次 10s，第三次 15s）
 *   最大重试次数：3 次（超过后标记为 failed 并 ack）
 *
 * ## 日志策略
 *
 *   所有事件通过 logQueueEvent 输出结构化 JSON 日志，包含：
 *     - component: "queue-consumer"  — 便于 log 筛选
 *     - event: 事件名               — 区分不同生命周期阶段
 *     - deliveryId / attempts        — 追踪单条消息的处理进度
 *
 *   日志级别：
 *     log   — 正常事件（开始处理、成功 ack）
 *     warn  — 需要关注但非致命（重试、缺少 deliveryId）
 *     error — 异常事件（投递失败、未知异常）
 */

import type { AppContext, QueueDeliveryMessage } from "../contracts";

// ==========================================================================
// 结构化日志
// ==========================================================================

/**
 * 输出结构化的 Queue 消费日志。
 * 所有日志都带 component="queue-consumer" 标签，
 * 方便在 Cloudflare Dashboard 或 wrangler tail 中按组件筛选。
 *
 * @param level   - 日志级别：log / warn / error
 * @param event   - 事件名，如 delivery_started / delivery_acked / delivery_retrying
 * @param details - 附加字段，自动展开到日志根层级
 */
const logQueueEvent = (
  level: "log" | "warn" | "error",
  event: string,
  details: Record<string, unknown>
): void => {
  console[level](`[queue] ${event}`, {
    component: "queue-consumer",
    event,
    ...details
  });
};

// ==========================================================================
// 批量消息处理
// ==========================================================================

/**
 * 处理一个 Queue 消息批次。
 *
 * Cloudflare Queues 会按批次推送消息给 Worker，本函数逐条处理批次中的每条消息。
 * 每条消息的处理结果独立决定 ack/retry，互不影响。
 *
 * ## 三条处理路径
 *
 *   【路径 1】deliveryId 缺失
 *     → warn 日志 + ack（无效消息直接丢弃，不阻塞批次）
 *
 *   【路径 2】正常处理成功
 *     → processQueuedDelivery() 返回 outcome="ack"
 *     → ack（如果投递成功，状态已更新为 delivered；如果永久失败，标记为 failed）
 *
 *   【路径 3】正常处理失败或未预期异常
 *     → processQueuedDelivery() 返回 outcome="retry"
 *       → retry + 延迟秒数（消息重新入队，等待下次消费）
 *     → 或 processQueuedDelivery() 本身抛出异常
 *       → handleQueueProcessingError() 决定 ack 还是 retry
 *
 * ## retry 延迟机制
 *
 *   message.retry({ delaySeconds }) 会让 Cloudflare Queue 在指定秒数后
 *   重新投递该消息。延迟由服务层根据当前 attempts 计算（attempts × 5 秒）。
 *   若未指定 delaySeconds，Queue 使用默认退避策略。
 *
 * @param batch   - Cloudflare Queue 推送的消息批次，包含 messages 数组和 queue 名
 * @param context - 应用上下文，提供 delivery 服务
 */
export const handleQueueBatch = async (batch: MessageBatch<QueueDeliveryMessage>, context: AppContext): Promise<void> => {
  for (const message of batch.messages) {
    const deliveryId = message.body?.deliveryId;

    // ---- 校验有效荷载 ----
    if (!deliveryId) {
      logQueueEvent("warn", "delivery_missing_id", {
        queue: batch.queue,
        messageId: message.id,
        attempts: message.attempts
      });
      message.ack();
      continue;
    }

    logQueueEvent("log", "delivery_started", {
      queue: batch.queue,
      messageId: message.id,
      deliveryId,
      attempts: message.attempts
    });

    try {
      // ---- 调用服务层处理投递 ----
      const result = await context.services.delivery.processQueuedDelivery(deliveryId, message.attempts);

      // 需要重试：重新入队，带延迟
      if (result.outcome === "retry") {
        logQueueEvent("warn", "delivery_retrying", {
          queue: batch.queue,
          messageId: message.id,
          deliveryId,
          attempts: message.attempts,
          delaySeconds: result.delaySeconds ?? null,
          deliveryStatus: result.deliveryStatus ?? null,
          error: result.error ?? null,
          responseCode: result.responseCode ?? null
        });
        message.retry(result.delaySeconds ? { delaySeconds: result.delaySeconds } : undefined);
        continue;
      }

      // 成功确认（delivered 或永久 failed）：消息从队列移除
      logQueueEvent(result.deliveryStatus === "failed" ? "error" : "log", "delivery_acked", {
        queue: batch.queue,
        messageId: message.id,
        deliveryId,
        attempts: message.attempts,
        deliveryStatus: result.deliveryStatus ?? null,
        error: result.error ?? null,
        responseCode: result.responseCode ?? null
      });
      message.ack();
    } catch (error) {
      // ---- 未预期异常 ----
      // processQueuedDelivery 本身抛出了未捕获的异常（非 IlinkApiError、非 AppError），
      // 交给 handleQueueProcessingError 根据异常类型决定重试策略
      logQueueEvent("error", "delivery_processing_exception", {
        queue: batch.queue,
        messageId: message.id,
        deliveryId,
        attempts: message.attempts,
        error
      });

      const result = await context.services.delivery.handleQueueProcessingError(deliveryId, message.attempts, error);

      // 异常可重试
      if (result.outcome === "retry") {
        logQueueEvent("warn", "delivery_exception_retrying", {
          queue: batch.queue,
          messageId: message.id,
          deliveryId,
          attempts: message.attempts,
          delaySeconds: result.delaySeconds ?? null,
          deliveryStatus: result.deliveryStatus ?? null,
          error: result.error ?? null,
          responseCode: result.responseCode ?? null
        });
        message.retry(result.delaySeconds ? { delaySeconds: result.delaySeconds } : undefined);
        continue;
      }

      // 异常不可重试（如网络中断且超过最大重试）：标记失败并 ack
      logQueueEvent("error", "delivery_exception_acked", {
        queue: batch.queue,
        messageId: message.id,
        deliveryId,
        attempts: message.attempts,
        deliveryStatus: result.deliveryStatus ?? null,
        error: result.error ?? null,
        responseCode: result.responseCode ?? null
      });
      message.ack();
    }
  }
};
