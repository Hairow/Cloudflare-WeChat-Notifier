import type { AppContext, QueueDeliveryMessage } from "../contracts";

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

export const handleQueueBatch = async (batch: MessageBatch<QueueDeliveryMessage>, context: AppContext): Promise<void> => {
  for (const message of batch.messages) {
    const deliveryId = message.body?.deliveryId;
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
      const result = await context.services.delivery.processQueuedDelivery(deliveryId, message.attempts);
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
      logQueueEvent("error", "delivery_processing_exception", {
        queue: batch.queue,
        messageId: message.id,
        deliveryId,
        attempts: message.attempts,
        error
      });

      const result = await context.services.delivery.handleQueueProcessingError(deliveryId, message.attempts, error);
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
