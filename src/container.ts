/**
 * 依赖注入容器（Container / Composition Root）
 * ---------------------------------------------------------------------------
 * 本文件是应用的"组装点"，负责：
 *   1. 校验 Cloudflare 环境绑定（vars / secrets / bindings）
 *   2. 解析环境变量（布尔值、整数、默认值）
 *   3. 创建所有 Repository、Client、Service 实例
 *   4. 组装 AppContext 并返回，供路由层和队列消费者使用
 *
 * ## 设计思路
 *
 *   手动 DI，不使用框架：
 *     Cloudflare Workers 环境轻量且无反射能力，
 *     直接 new 有助于类型安全、代码可追踪、冷启动友好。
 *
 *   先校验再组装：
 *     createAppContext 在请求到来时调用（每次 fetch/queue/scheduled），
 *     第一时间校验必需绑定，失败直接抛出 AppError(500)。
 *     既避免了运行时 NPE，也快速暴露配置遗漏问题。
 *
 *   面向接口：
 *     路由层只认识 AppContext / AdminService / DeliveryService 等接口，
 *     具体实现（DefaultAdminService / DefaultDeliveryService）仅在此文件引用，
 *     易于单元测试时替换为 mock。
 *
 * ## 对象图
 *
 *   CloudflareBindings (env)
 *     ├── 环境变量（vars/secrets） → RuntimeConfig
 *     ├── DB (D1) → BotStateRepository / LoginSessionRepository / DeliveryLogRepository
 *     ├── NOTIFICATION_QUEUE → DefaultDeliveryService
 *     └── ILINK_BASE_URL → IlinkClient
 *
 *   AppContext
 *     ├── config: RuntimeConfig
 *     └── services
 *           ├── admin:    DefaultAdminService(ilinkClient, botRepo, sessionRepo)
 *           ├── delivery: DefaultDeliveryService(queue, deliveryRepo, botRepo, ilinkClient)
 *           └── health:   DefaultHealthService(db, queue, botRepo)
 */

import type { AppContext } from "./contracts";
import type { CloudflareBindings } from "./bindings";
import { IlinkClient } from "./ilink/client";
import { AppError } from "./lib/errors";
import { DefaultAdminService } from "./services/admin-service";
import { DefaultDeliveryService } from "./services/delivery-service";
import { DefaultHealthService } from "./services/health-service";
import { BotStateRepository } from "./storage/bot-state-repository";
import { DeliveryLogRepository } from "./storage/delivery-log-repository";
import { LoginSessionRepository } from "./storage/login-session-repository";

/** 保活消息默认文本 */
const DEFAULT_KEEPALIVE_TEXT = "【保活提醒】请和微信 ClawBot 进行一次交互，保持 iLink 上下文可用。";

// ==========================================================================
// 环境变量校验与解析
// ==========================================================================

/**
 * 校验必需绑定，缺失时立即抛出 AppError(500)。
 * 在 Worker 入口处快速失败，避免请求处理到一半才发现配置缺失。
 */
const requireBinding = (value: string | undefined, name: string): string => {
  if (!value) {
    throw new AppError(500, "missing_binding", `缺少必需绑定: ${name}`);
  }

  return value;
};

/**
 * 解析布尔类型的环境变量。
 * Cloudflare 环境变量均为字符串，需要手动转换。
 * 支持：1/true/yes/on → true，0/false/no/off → false，未设置 → fallback。
 * 非法值抛出 AppError(500)。
 */
const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new AppError(500, "invalid_binding", "KEEPALIVE_ENABLED 必须是 true/false。");
};

/**
 * 解析保活间隔小时数。
 * 默认 24 小时，允许 1-720 之间的整数。
 * 非法值抛出 AppError(500)。
 */
const parseIntervalHours = (value: string | undefined): number => {
  if (value === undefined || value.trim() === "") {
    return 24;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 720) {
    throw new AppError(500, "invalid_binding", "KEEPALIVE_INTERVAL_HOURS 必须是 1-720 之间的整数。");
  }

  return parsed;
};

// ==========================================================================
// 容器入口
// ==========================================================================

/**
 * 创建应用上下文。
 *
 * 在每次 Worker 调用（fetch / queue / scheduled）时被执行，
 * 完成环境校验、对象创建和依赖组装。
 *
 * ## 调用方
 *   - index.ts 的 fetch handler（HTTP 请求）
 *   - index.ts 的 queue handler（队列消费）
 *   - index.ts 的 scheduled handler（定时任务）
 *
 * ## 依赖链路
 *
 *   env.ADMIN_TOKEN          ─→ RuntimeConfig.adminToken
 *   env.WEBHOOK_SHARED_TOKEN ─→ RuntimeConfig.webhookSharedToken
 *   env.KEEPALIVE_*          ─→ RuntimeConfig.keepalive
 *
 *   env.DB + encSecret       ─→ BotStateRepository
 *                           ─→ LoginSessionRepository
 *                           ─→ DeliveryLogRepository
 *
 *   env.ILINK_BASE_URL       ─→ IlinkClient
 *
 *   ilinkClient + repos      ─→ DefaultAdminService
 *   queue + repos + client   ─→ DefaultDeliveryService
 *   db + queue + botRepo     ─→ DefaultHealthService
 *
 * @param env - Cloudflare Workers 环境绑定对象
 * @returns 完整的应用上下文，可直接传入 createApp() 或队列/定时处理器
 */
export const createAppContext = (env: CloudflareBindings): AppContext => {
  // ---- 1. 校验必需绑定 ----
  const adminToken = requireBinding(env.ADMIN_TOKEN, "ADMIN_TOKEN");
  const webhookSharedToken = requireBinding(env.WEBHOOK_SHARED_TOKEN, "WEBHOOK_SHARED_TOKEN");
  const encryptionSecret = requireBinding(env.BOT_STATE_ENC_KEY, "BOT_STATE_ENC_KEY");

  // ---- 2. 创建数据访问层（Repository） ----
  const botRepository = new BotStateRepository(env.DB, encryptionSecret);
  const loginSessionRepository = new LoginSessionRepository(env.DB);
  const deliveryLogRepository = new DeliveryLogRepository(env.DB);

  // ---- 3. 创建外部服务客户端 ----
  const ilinkClient = new IlinkClient({
    baseUrl: env.ILINK_BASE_URL
  });

  // ---- 4. 组装并返回 ----
  return {
    config: {
      adminToken,
      webhookSharedToken,
      keepalive: {
        enabled: parseBoolean(env.KEEPALIVE_ENABLED, true),
        source: "keepalive",
        intervalHours: parseIntervalHours(env.KEEPALIVE_INTERVAL_HOURS),
        text: env.KEEPALIVE_TEXT?.trim() || DEFAULT_KEEPALIVE_TEXT
      }
    },
    services: {
      admin: new DefaultAdminService(ilinkClient, botRepository, loginSessionRepository),
      delivery: new DefaultDeliveryService(env.NOTIFICATION_QUEUE, deliveryLogRepository, botRepository, ilinkClient),
      health: new DefaultHealthService(env.DB, env.NOTIFICATION_QUEUE, botRepository)
    }
  };
};
