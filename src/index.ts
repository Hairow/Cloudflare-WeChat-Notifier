/**
 * Cloudflare Workers 入口
 * ---------------------------------------------------------------------------
 * 本文件是 Worker 的 exported default handler，Cloudflare 运行时根据事件类型
 * 调用对应的命名导出方法：
 *
 *   fetch     — 处理所有 HTTP 请求（Webhook / API / 管理页面）
 *   queue     — 处理 Cloudflare Queue 消息（异步投递消费）
 *   scheduled — 处理 Cron 定时任务（过期补偿 + 保活提醒）
 *
 * ## 请求生命周期
 *
 *   外部系统
 *     │  POST /webhook/:source
 *     ▼
 *   fetch()
 *     │  createAppContext(env)          ← 校验绑定、组装依赖
 *     │  createApp(context)             ← 创建 Hono 路由
 *     │  app.fetch(request, env, ctx)   ← Hono 匹配路由、执行中间件
 *     │  → 入库 + 入队 → 返回 202
 *     ▼
 *   queue()
 *     │  createAppContext(env)
 *     │  handleQueueBatch(batch, ctx)   ← 批量消费、逐条处理
 *     │  → IlinkClient.sendMessage()    ← 调用 iLink API 发消息
 *     │  → ack（成功）或 retry（失败重试）
 *     ▼
 *   scheduled()  (每 15 分钟)
 *     │  handleScheduled(controller, ctx)
 *     │  → 补偿过期 queued 投递
 *     │  → 入队保活提醒（如到期）
 *     ▼
 *
 * ## 错误处理策略
 *
 *   fetch 层：
 *     createAppContext 失败 → AppError（500 missing_binding / invalid_binding）
 *     路由层抛出 AppError / IlinkApiError → toFailureResponse() 统一转换
 *     未预期异常 → 500 internal_error
 *
 *   queue 层：
 *     消息解析失败 → ack（丢弃，不再重试）
 *     发送失败 → retry（最多 3 次，延迟 = attempts × 5 秒）
 *     永久失败 → ack（标记为 failed，停止重试）
 *
 *   scheduled 层：
 *     补偿/保活异常 → catch 并记录日志，不中断后续执行
 */

import type { CloudflareBindings } from "./bindings";
import { createApp } from "./app";
import { createAppContext } from "./container";
import type { AppContext } from "./contracts";
import { isAppError, isIlinkApiError, toErrorDetails, toErrorMessage } from "./lib/errors";
import { handleQueueBatch } from "./queue/consumer";

// ==========================================================================
// 常量
// ==========================================================================

/** 过期补偿：每次最多补偿条数 */
const STALE_QUEUED_COMPENSATION_LIMIT = 20;

/** 过期补偿：卡在 queued 状态超过此分钟数视为异常 */
const STALE_QUEUED_OLDER_THAN_MINUTES = 10;

// ==========================================================================
// Scheduled Handler（Cron 定时任务）
// ==========================================================================

/**
 * 定时任务处理器，由 wrangler.jsonc 中的 cron 触发（每 15 分钟）。
 *
 * 执行两个任务：
 *   1. 过期补偿：扫描 D1 中卡在 queued 超过 10 分钟且 attempts=0 的记录，重新入队
 *   2. 保活提醒：遍历所有 ready/needs_activation Bot，自动激活后再按时间桶去重发送保活消息
 *
 *
 * @param controller - Cloudflare ScheduledController，含 cron 表达式和调度时间
 * @param context    - 应用上下文
 */
export const handleScheduled = async (controller: ScheduledController, context: AppContext): Promise<void> => {
  // ---- 任务 1：过期投递补偿 ----
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

  // ---- 任务 2：保活提醒 ----
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
    totalBots: keepalive.perBot.length,
    perBot: keepalive.perBot.map((b) => ({
      botId: b.botId,
      label: b.label,
      enqueued: b.enqueued,
      reason: b.reason,
      deliveryId: b.deliveryId,
      lastDeliveryId: b.lastDeliveryId,
      nextDueAt: b.nextDueAt
    }))
  });

};

// ==========================================================================
// 错误响应构造（HTTP 层）
// ==========================================================================

/**
 * 将异常转换为 JSON 错误响应。
 *
 * 分类规则：
 *   AppError      → 使用 error.status 作为 HTTP 状态码，code 作为业务码
 *   IlinkApiError → 固定 502 Bad Gateway
 *   其他异常      → 固定 500 Internal Server Error
 */
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

// ==========================================================================
// Worker 默认导出（ExportedHandler）
// ==========================================================================

/**
 * Cloudflare Workers 默认导出对象。
 * 使用 `satisfies ExportedHandler<CloudflareBindings>` 确保类型正确，
 * 同时保留各 handler 的精确类型推断。
 *
 * ## 三个 Handler
 *
 *   fetch()
 *     HTTP 请求入口。每次请求创建全新的 AppContext 和 Hono App，
 *     由 Hono 进行路由匹配、鉴权中间件和业务处理。
 *     外层 try/catch 捕获 createAppContext 错误、路由未匹配和未预期异常，
 *     统一转换为 JSON 错误响应。
 *
 *   queue()
 *     Cloudflare Queues 消费者入口。Worker 收到 Queue 消息时调用，
 *     batch 包含一批消息（最多 messages 条），逐条处理并决定 ack/retry。
 *
 *   scheduled()
 *     Cron 定时任务入口。根据 wrangler.jsonc 中定义的 cron 表达式触发，
 *     执行过期补偿和保活检查。
 */
export default {
  async fetch(request, env, executionContext): Promise<Response> {
    try {
      // 步骤 1：创建应用上下文（含绑定校验）
      const context = createAppContext(env as CloudflareBindings);

      // 步骤 2：创建 Hono 路由应用
      const app = createApp(context);

      // 步骤 3：交给 Hono 处理请求
      return app.fetch(request, env, executionContext);
    } catch (error) {
      // 步骤 4（异常路径）：统一转换为错误响应
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
