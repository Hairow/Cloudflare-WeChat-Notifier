import type { CloudflareBindings } from "./bindings";
import { createApp } from "./app";
import { createAppContext } from "./container";
import { isAppError, isIlinkApiError, toErrorDetails, toErrorMessage } from "./lib/errors";
import { handleQueueBatch } from "./queue/consumer";

const STALE_QUEUED_COMPENSATION_LIMIT = 20;
const STALE_QUEUED_OLDER_THAN_MINUTES = 10;

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
    const result = await context.services.delivery.compensateStaleQueued({
      limit: STALE_QUEUED_COMPENSATION_LIMIT,
      olderThanMinutes: STALE_QUEUED_OLDER_THAN_MINUTES
    });

    console.log("[scheduled] stale_queued_compensation", {
      component: "scheduled-compensation",
      event: "stale_queued_compensation",
      cron: controller.cron,
      scheduledTime: new Date(controller.scheduledTime).toISOString(),
      limit: result.limit,
      olderThanMinutes: result.olderThanMinutes,
      total: result.items.length,
      replayed: result.items.filter((item) => item.replayed).length,
      failed: result.items.filter((item) => !item.replayed).length,
      deliveryIds: result.items.map((item) => item.deliveryId)
    });
  }
} satisfies ExportedHandler<CloudflareBindings>;
