import type { CloudflareBindings } from "./bindings";
import { createApp } from "./app";
import { createAppContext } from "./container";
import type { AppContext } from "./contracts";
import { isAppError, isIlinkApiError, toErrorDetails, toErrorMessage } from "./lib/errors";
import { handleQueueBatch } from "./queue/consumer";

const STALE_QUEUED_COMPENSATION_LIMIT = 20;
const STALE_QUEUED_OLDER_THAN_MINUTES = 10;

export const handleScheduled = async (controller: ScheduledController, context: AppContext): Promise<void> => {
  const compensation = await context.services.delivery.compensateStaleQueued({
    limit: STALE_QUEUED_COMPENSATION_LIMIT,
    olderThanMinutes: STALE_QUEUED_OLDER_THAN_MINUTES
  });

  console.log("[scheduled] stale_queued_compensation", {
    component: "scheduled-compensation",
    event: "stale_queued_compensation",
    cron: controller.cron,
    scheduledTime: new Date(controller.scheduledTime).toISOString(),
    limit: compensation.limit,
    olderThanMinutes: compensation.olderThanMinutes,
    total: compensation.items.length,
    replayed: compensation.items.filter((item) => item.replayed).length,
    failed: compensation.items.filter((item) => !item.replayed).length,
    deliveryIds: compensation.items.map((item) => item.deliveryId)
  });

  const keepalive = await context.services.delivery.enqueueKeepaliveIfDue(
    context.config.keepalive,
    new Date(controller.scheduledTime)
  );

  console.log("[scheduled] keepalive", {
    component: "scheduled-keepalive",
    event: "keepalive",
    cron: controller.cron,
    scheduledTime: new Date(controller.scheduledTime).toISOString(),
    enabled: context.config.keepalive.enabled,
    intervalHours: context.config.keepalive.intervalHours,
    source: context.config.keepalive.source,
    enqueued: keepalive.enqueued,
    reason: keepalive.reason,
    deliveryId: keepalive.deliveryId,
    lastDeliveryId: keepalive.lastDeliveryId,
    lastCreatedAt: keepalive.lastCreatedAt,
    nextDueAt: keepalive.nextDueAt
  });
};

const toFailureResponse = (error: unknown): Response => {
  const status = isAppError(error) ? error.status : isIlinkApiError(error) ? 502 : 500;
  const code = isAppError(error) ? error.code : isIlinkApiError(error) ? "upstream_error" : "internal_error";
  const message = toErrorMessage(error);

  return Response.json(
    {
      code: status,
      error: code,
      message,
      details: toErrorDetails(error)
    },
    {
      status
    }
  );
};

export default {
  async fetch(request, env, executionContext): Promise<Response> {
    try {
      const context = createAppContext(env as CloudflareBindings);
      const app = createApp(context);
      return app.fetch(request, env, executionContext);
    } catch (error) {
      return toFailureResponse(error);
    }
  },

  async queue(batch, env): Promise<void> {
    const context = createAppContext(env as CloudflareBindings);
    await handleQueueBatch(batch as MessageBatch<{ deliveryId: string }>, context);
  },

  async scheduled(controller, env): Promise<void> {
    const context = createAppContext(env as CloudflareBindings);
    await handleScheduled(controller, context);
  }
} satisfies ExportedHandler<CloudflareBindings>;
