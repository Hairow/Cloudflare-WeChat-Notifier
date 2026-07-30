/**
 * Hono 路由定义与中间件
 * ---------------------------------------------------------------------------
 * 本文件通过 `createApp(context)` 创建 Hono 应用实例，定义了所有 HTTP 端点、
 * 鉴权中间件、错误处理和参数校验逻辑。
 *
 * ## 架构分层
 *
 *   createAppContext(env)         ← container.ts：校验绑定、创建依赖
 *     │
 *   createApp(context)            ← 本文件：创建 Hono 实例
 *     │
 *     ├── onError                 ← 全局错误拦截器
 *     ├── notFound                ← 404 兜底
 *     │
 *     ├── /admin/* 中间件          ← ADMIN_TOKEN 鉴权（Bearer 或 ?token=）
 *     ├── /api/* 中间件            ← ADMIN_TOKEN 鉴权（仅 Bearer）
 *     ├── /webhook/* 中间件        ← X-Webhook-Token 鉴权
 *     │
 *     └── 路由处理函数             ← 调用 context.services.* 完成业务
 *
 * ## 鉴权策略
 *
 *   /admin/*：支持两种方式传入 ADMIN_TOKEN
 *     - Authorization: Bearer <token>（API 调用）
 *     - ?token=<token>（浏览器管理页面直接访问）
 *
 *   /api/*：仅支持 Authorization: Bearer <token>
 *
 *   /webhook/*：通过 X-Webhook-Token 请求头传入 WEBHOOK_SHARED_TOKEN
 *
 * ## 错误处理
 *
 *   三层拦截：
 *     1. Hono onError — 捕获路由处理函数中抛出的所有异常
 *     2. 中间件 — 鉴权失败直接 throw AppError(401)
 *     3. 校验函数 — 参数不合法 throw AppError(400)
 *     4. notFound — 未匹配任何路由返回 404 JSON
 */

import { Hono } from "hono";
import * as QRCode from "qrcode";
import type { AppContext, DeliveryListQuery, DeliveryStatus } from "./contracts";
import { renderDashboardPage } from "./lib/dashboard-page";
import { AppError, isAppError, isIlinkApiError, toErrorDetails, toErrorMessage } from "./lib/errors";
import { renderDeliveryLogPage } from "./lib/delivery-log-page";
import { getQrcodeRenderContent } from "./lib/ilink-qrcode";
import { renderQrcodeLoginPage } from "./lib/qrcode-page";
import { parseJsonBody, validateIncomingMessage, validateSource } from "./lib/validation";

// ==========================================================================
// 工具函数：Token 提取
// ==========================================================================

/**
 * 从 Authorization 请求头中提取 Bearer Token。
 * 仅匹配 "Bearer <token>" 格式，其他格式返回 null。
 *
 * @param authorizationHeader - Authorization 请求头的值
 * @returns Token 字符串，或 null
 */
const extractBearerToken = (authorizationHeader: string | null): string | null => {
  if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
    return null;
  }

  return authorizationHeader.slice("Bearer ".length).trim();
};

// ==========================================================================
// 常量：校验约束
// ==========================================================================

/** 合法的投递状态值集合，用于查询参数校验 */
const ALLOWED_DELIVERY_STATUSES = new Set<DeliveryStatus>(["queued", "retrying", "delivered", "failed"]);

/** 批量操作（重放/删除）最大允许条数 */
const MAX_BATCH_DELIVERY_IDS = 100;

/** UUID 格式正则（8-4-4-4-12，大小写不敏感） */
const DELIVERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ==========================================================================
// 参数解析与校验
// ==========================================================================

/**
 * 从请求中提取 ADMIN_TOKEN。
 * 优先从 Authorization: Bearer <token> 获取，
 * 其次从查询参数 ?token=<token> 获取（方便浏览器管理页面直接访问）。
 *
 * @param request - HTTP 请求对象
 * @returns Token 字符串，或 null
 */
const extractAdminToken = (request: Request): string | null => {
  const bearerToken = extractBearerToken(request.headers.get("Authorization"));
  if (bearerToken) {
    return bearerToken;
  }

  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token")?.trim();
  return queryToken || null;
};

/**
 * 解析投递日志列表查询参数。
 * 从 URL 查询字符串提取 limit、page、status、source，
 * 并对每个参数做范围校验，非法值直接抛出 AppError(400)。
 *
 * @param request - HTTP 请求对象
 * @returns 校验后的查询参数对象
 */
const parseDeliveryListQuery = (request: Request): DeliveryListQuery => {
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  const rawPage = url.searchParams.get("page");
  const rawStatus = url.searchParams.get("status");
  const rawSource = url.searchParams.get("source")?.trim();

  // limit：默认 20，允许 1-100
  let limit = 20;
  if (rawLimit) {
    limit = Number.parseInt(rawLimit, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new AppError(400, "invalid_limit", "limit 必须是 1-100 之间的整数。");
    }
  }

  // page：默认 1，必须为正整数
  let page = 1;
  if (rawPage) {
    page = Number.parseInt(rawPage, 10);
    if (!/^[1-9]\d*$/.test(rawPage) || !Number.isSafeInteger(page)) {
      throw new AppError(400, "invalid_page", "page 必须是大于等于 1 的整数。");
    }
  }

  // status：可选，但必须为合法枚举值
  if (rawStatus && !ALLOWED_DELIVERY_STATUSES.has(rawStatus as DeliveryStatus)) {
    throw new AppError(400, "invalid_status", "status 仅支持 queued、retrying、delivered、failed。");
  }

  // source：可选，校验格式
  if (rawSource) {
    validateSource(rawSource);
  }

  return {
    limit,
    page,
    status: rawStatus ? (rawStatus as DeliveryStatus) : undefined,
    source: rawSource || undefined
  };
};

/**
 * 解析页面自动刷新间隔（秒）。
 * 管理页面支持定时 AJAX 刷新，此函数从 ?refresh=N 查询参数提取值。
 * 非法值抛出 AppError(400)。
 *
 * @param request  - HTTP 请求对象
 * @param fallback - 未指定时的默认刷新秒数
 * @returns 合法的刷新间隔秒数
 */
const parseRefreshSeconds = (request: Request, fallback: number): number => {
  const url = new URL(request.url);
  const refreshRaw = url.searchParams.get("refresh");
  if (!refreshRaw) {
    return fallback;
  }

  const refreshSeconds = Number.parseInt(refreshRaw, 10);
  if (!Number.isInteger(refreshSeconds) || refreshSeconds < 0 || refreshSeconds > 300) {
    throw new AppError(400, "invalid_refresh", "refresh 必须是 0-300 之间的整数秒。");
  }

  return refreshSeconds;
};

/**
 * 解析投注重放查询参数（limit + source）。
 * 用于 POST /admin/deliveries/replay-ret2 接口。
 *
 * @param request - HTTP 请求对象
 * @returns limit（1-100）和可选的 source
 */
const parseReplayQuery = (request: Request): { limit: number; source?: string } => {
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  const rawSource = url.searchParams.get("source")?.trim();

  let limit = 20;
  if (rawLimit) {
    limit = Number.parseInt(rawLimit, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new AppError(400, "invalid_limit", "limit 必须是 1-100 之间的整数。");
    }
  }

  if (rawSource) {
    validateSource(rawSource);
  }

  return {
    limit,
    source: rawSource || undefined
  };
};

/**
 * 解析过期补偿查询参数（limit + olderThanMinutes + source）。
 * 用于 POST /admin/deliveries/compensate-queued 接口。
 * olderThanMinutes 默认 10，允许 1-1440。
 *
 * @param request - HTTP 请求对象
 * @returns 包含 limit、olderThanMinutes 和可选 source 的参数对象
 */
const parseQueuedCompensationQuery = (request: Request): { limit: number; olderThanMinutes: number; source?: string } => {
  const url = new URL(request.url);
  const rawOlderThanMinutes = url.searchParams.get("olderThanMinutes");
  const replayQuery = parseReplayQuery(request);

  let olderThanMinutes = 10;
  if (rawOlderThanMinutes) {
    olderThanMinutes = Number.parseInt(rawOlderThanMinutes, 10);
    if (!Number.isInteger(olderThanMinutes) || olderThanMinutes < 1 || olderThanMinutes > 1440) {
      throw new AppError(400, "invalid_older_than_minutes", "olderThanMinutes 必须是 1-1440 之间的整数。");
    }
  }

  return {
    ...replayQuery,
    olderThanMinutes
  };
};

/**
 * 从 JSON 请求体中解析并校验批量操作的 deliveryIds 数组。
 *
 * 校验规则：
 *   - 请求体必须为 JSON 对象，含 deliveryIds 字段
 *   - deliveryIds 为字符串数组，长度 1-100
 *   - 自动去重、trim
 *   - 每个 ID 必须匹配 UUID 格式
 *
 * 非法值抛出 AppError(400)。
 *
 * @param request - HTTP 请求对象
 * @returns 去重后的 deliveryId 数组
 */
const parseBatchDeliveryIds = async (request: Request): Promise<string[]> => {
  const input = await parseJsonBody(request);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new AppError(400, "invalid_delivery_ids", "deliveryIds 必须是非空 UUID 数组。");
  }

  const deliveryIdsInput = (input as Record<string, unknown>).deliveryIds;
  if (
    !Array.isArray(deliveryIdsInput) ||
    deliveryIdsInput.length === 0 ||
    deliveryIdsInput.length > MAX_BATCH_DELIVERY_IDS ||
    deliveryIdsInput.some((deliveryId) => typeof deliveryId !== "string")
  ) {
    throw new AppError(400, "invalid_delivery_ids", "deliveryIds 必须是 1-100 条 UUID 组成的数组。");
  }

  // 去重并 trim
  const deliveryIds = Array.from(new Set(deliveryIdsInput.map((deliveryId) => (deliveryId as string).trim())));
  if (deliveryIds.some((deliveryId) => !DELIVERY_ID_PATTERN.test(deliveryId))) {
    throw new AppError(400, "invalid_delivery_ids", "deliveryIds 必须是 1-100 条 UUID 组成的数组。");
  }

  return deliveryIds;
};

// ==========================================================================
// createApp — Hono 应用工厂
// ==========================================================================

/**
 * 创建 Hono 应用实例。
 *
 * 接收已组装好的 AppContext，注册中间件和路由后返回 Hono 实例。
 * Worker 入口（index.ts）将此实例的 fetch 委托给 Hono。
 *
 * ## 路由一览
 *
 *   GET    /                                      — 根路径，返回服务运行中消息
 *   GET    /healthz                               — 健康检查
 *
 *   —— 管理页面（HTML）——
 *   GET    /admin/dashboard                       — 总览页（bot 状态 + 测试 + 最近日志）
 *   GET    /admin/bot/login/qrcode/page           — 二维码登录页（含 SVG 渲染）
 *   GET    /admin/deliveries/page                 — 投递日志中心页
 *
 *   —— Bot 管理（JSON API）——
 *   POST   /admin/bot/login/qrcode                — 创建登录二维码会话
 *   GET    /admin/bot/login/status/:sessionId     — 查询扫码状态
 *   POST   /admin/bot/activate                    — 激活 Bot
 *   GET    /admin/bot/status                      — 查询 Bot 当前状态
 *
 *   —— 投递日志管理（JSON API）——
 *   GET    /admin/deliveries                      — 分页查询投递日志
 *   POST   /admin/deliveries/replay-ret2          — 重放所有 ret=-2 的失败投递
 *   POST   /admin/deliveries/compensate-queued    — 补偿过期 queued 投递
 *   POST   /admin/deliveries/batch/replay         — 批量重放
 *   POST   /admin/deliveries/batch/delete         — 批量删除
 *   POST   /admin/deliveries/:deliveryId/replay   — 重放单条
 *   GET    /admin/deliveries/:deliveryId           — 查询单条详情
 *
 *   —— 消息入站——
 *   POST   /api/send                              — 管理员手动发送（source=admin）
 *   POST   /webhook/:source                       — 外部系统 Webhook 入站
 *
 * @param context - 已组装好的应用上下文（配置 + 服务）
 * @returns 配置好路由的 Hono 实例
 */
export const createApp = (context: AppContext): Hono => {
  const app = new Hono();

  // ==============================
  // 全局错误拦截器
  // ==============================

  /**
   * Hono onError 钩子。
   * 捕获所有路由处理函数和中间件中抛出的异常，按异常类型返回不同的 JSON 错误响应：
   *
   *   AppError      → 使用 error.status / error.code 作为响应码
   *   IlinkApiError → retryable 类返回 502，其他返回 500
   *   其他异常      → 统一 500 internal_error
   */
  app.onError((error, c) => {
    if (isAppError(error)) {
      return new Response(
        JSON.stringify({
          code: error.status,
          error: error.code,
          message: error.message,
          details: error.details ?? null
        }),
        {
          status: error.status,
          headers: {
            "Content-Type": "application/json; charset=utf-8"
          }
        }
      );
    }

    if (isIlinkApiError(error)) {
      const status = error.category === "retryable" ? 502 : 500;
      return new Response(
        JSON.stringify({
          code: status,
          error: "upstream_error",
          message: error.message,
          details: toErrorDetails(error)
        }),
        {
          status,
          headers: {
            "Content-Type": "application/json; charset=utf-8"
          }
        }
      );
    }

    return new Response(
      JSON.stringify({
        code: 500,
        error: "internal_error",
        message: toErrorMessage(error),
        details: toErrorDetails(error)
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json; charset=utf-8"
        }
      }
    );
  });

  // ==============================
  // 404 兜底
  // ==============================

  /** 未匹配到任何路由时返回 JSON 格式的 404，而非默认的纯文本 */
  app.notFound(() =>
    new Response(
      JSON.stringify({
        code: 404,
        error: "not_found",
        message: "Route not found."
      }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json; charset=utf-8"
        }
      }
    )
  );

  // ==============================
  // 鉴权中间件（三层）
  // ==============================

  /**
   * /admin/* 鉴权中间件。
   * 从 Authorization Bearer 或 ?token= 查询参数中提取 ADMIN_TOKEN，
   * 与 context.config.adminToken 比对，不匹配则返回 401。
   * 支持双通道是为了方便 API 调用（Bearer）和浏览器管理页面（?token=）。
   */
  app.use("/admin/*", async (c, next) => {
    const token = extractAdminToken(c.req.raw);
    if (token !== context.config.adminToken) {
      throw new AppError(401, "unauthorized", "缺少有效的 ADMIN_TOKEN。");
    }

    await next();
  });

  /**
   * /api/* 鉴权中间件。
   * 仅接受 Authorization: Bearer <ADMIN_TOKEN> 方式鉴权。
   * API 路径面向程序调用，不需要 ?token= 查询参数支持。
   */
  app.use("/api/*", async (c, next) => {
    const token = extractBearerToken(c.req.header("Authorization") ?? null);
    if (token !== context.config.adminToken) {
      throw new AppError(401, "unauthorized", "缺少有效的 ADMIN_TOKEN。");
    }

    await next();
  });

  /**
   * /webhook/* 鉴权中间件。
   * 通过 X-Webhook-Token 请求头传入 WEBHOOK_SHARED_TOKEN，
   * 与 context.config.webhookSharedToken 比对。
   * 使用独立 Token 便于对外分发，避免泄露 ADMIN_TOKEN。
   */
  app.use("/webhook/*", async (c, next) => {
    const token = c.req.header("X-Webhook-Token") ?? "";
    if (token !== context.config.webhookSharedToken) {
      throw new AppError(401, "unauthorized", "缺少有效的 X-Webhook-Token。");
    }

    await next();
  });

  // ==============================
  // 基础路由
  // ==============================

  /** GET / — 根路径，确认服务运行中 */
  app.get("/", (c) => c.json({ code: 200, message: "ilink-cloudflare is running." }));

  /** GET /healthz — 健康检查，返回数据库、队列、Bot 状态 */
  app.get("/healthz", async (c) => {
    const data = await context.services.health.probe();
    return c.json({
      code: 200,
      data
    });
  });

  // ==============================
  // 管理页面（HTML 渲染）
  // ==============================

  /**
   * GET /admin/dashboard
   * 管理总览页（HTML），包含：
   *   - Bot 状态面板
   *   - 快速操作（登录、激活、发送测试消息）
   *   - 最近投递日志表格
   *
   * 查询参数：
   *   ?token=<ADMIN_TOKEN>  — 必填
   *   ?refresh=<秒>         — 自动刷新间隔，默认 5，0 表示禁用
   *   ?logsLimit=<条数>     — 日志表格显示条数，默认 8，1-50
   */
  app.get("/admin/dashboard", async (c) => {
    const token = c.req.query("token")?.trim();
    if (!token) {
      throw new AppError(400, "missing_page_token", "总览页需要通过 ?token=ADMIN_TOKEN 打开。");
    }

    const url = new URL(c.req.url);
    const logsLimitRaw = url.searchParams.get("logsLimit");
    let logsLimit = 8;
    if (logsLimitRaw) {
      logsLimit = Number.parseInt(logsLimitRaw, 10);
      if (!Number.isInteger(logsLimit) || logsLimit < 1 || logsLimit > 50) {
        throw new AppError(400, "invalid_logs_limit", "logsLimit 必须是 1-50 之间的整数。");
      }
    }

    return new Response(
      renderDashboardPage({
        adminToken: token,
        refreshSeconds: parseRefreshSeconds(c.req.raw, 5),
        logsLimit
      }),
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store"
        }
      }
    );
  });

  /**
   * GET /admin/bot/login/qrcode/page
   * 二维码登录页面（HTML），自动：
   *   1. 向 /admin/bot/login/qrcode 创建会话获取二维码
   *   2. 用 qrcode npm 包渲染 SVG
   *   3. 前端 JS 自动轮询 /admin/bot/login/status/:sessionId
   *   4. 状态流转：wait → scanned → confirmed
   *
   * 查询参数：
   *   ?token=<ADMIN_TOKEN> — 必填
   */
  app.get("/admin/bot/login/qrcode/page", async (c) => {
    const token = c.req.query("token")?.trim();
    if (!token) {
      throw new AppError(400, "missing_page_token", "二维码页面需要通过 ?token=ADMIN_TOKEN 打开。");
    }

    const data = await context.services.admin.createLoginQrcode();
    const svgMarkup = await QRCode.toString(getQrcodeRenderContent(data), {
      type: "svg",
      margin: 1,
      width: 320,
      errorCorrectionLevel: "M",
      color: {
        dark: "#17202d",
        light: "#ffffff"
      }
    });

    return new Response(
      renderQrcodeLoginPage({
        sessionId: data.sessionId,
        expiresAt: data.expiresAt,
        svgMarkup,
        adminToken: token
      }),
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store"
        }
      }
    );
  });

  /**
   * GET /admin/deliveries/page
   * 投递日志中心页面（HTML），支持：
   *   - 按状态/来源筛选
   *   - 分页浏览
   *   - 自动刷新
   *   - 单条/批量重放
   *   - 批量删除
   *
   * 查询参数：
   *   ?token=<ADMIN_TOKEN>     — 必填
   *   ?status=<状态>           — 可选筛选
   *   ?source=<来源>           — 可选筛选
   *   ?limit=<条数>            — 每页条数，默认 20
   *   ?page=<页码>             — 默认 1
   *   ?refresh=<秒>            — 自动刷新间隔，默认 5
   */
  app.get("/admin/deliveries/page", async (c) => {
    const token = c.req.query("token")?.trim();
    if (!token) {
      throw new AppError(400, "missing_page_token", "日志页面需要通过 ?token=ADMIN_TOKEN 打开。");
    }

    const filters = parseDeliveryListQuery(c.req.raw);
    return new Response(
      renderDeliveryLogPage({
        adminToken: token,
        initialStatus: filters.status,
        initialSource: filters.source,
        initialLimit: filters.limit,
        initialPage: filters.page,
        initialRefreshSeconds: parseRefreshSeconds(c.req.raw, 5)
      }),
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store"
        }
      }
    );
  });

  // ==============================
  // Bot 管理 API（JSON）
  // ==============================

  /**
   * POST /admin/bot/login/qrcode
   * 创建登录二维码会话，返回 sessionId 和 base64 图片数据。
   * 会话有效期约 5 分钟。
   */
  app.post("/admin/bot/login/qrcode", async (c) => {
    const data = await context.services.admin.createLoginQrcode();
    return c.json(
      {
        code: 201,
        data
      },
      201
    );
  });

  /**
   * GET /admin/bot/login/status/:sessionId
   * 查询二维码扫描状态，前端自动轮询此端点。
   * 返回 wait / scanned / confirmed / expired。
   * confirmed 时含 bot_token、ilink_user_id 等凭证。
   */
  app.get("/admin/bot/login/status/:sessionId", async (c) => {
    const data = await context.services.admin.getLoginStatus(c.req.param("sessionId"));
    return c.json({
      code: 200,
      data
    });
  });

  /**
   * POST /admin/bot/activate
   * 激活 Bot：调用 getUpdates 获取 context_token 并持久化。
   * 前提：用户已在微信中给 ClawBot 发过消息（产生可用上下文）。
   * 成功后 Bot 状态变为 ready。
   */
  app.post("/admin/bot/activate", async (c) => {
    const data = await context.services.admin.activateBot();
    return c.json({
      code: 200,
      data
    });
  });

  /**
   * GET /admin/bot/status
   * 查询当前 Bot 状态（脱敏，不返回 token 等敏感字段）。
   */
  app.get("/admin/bot/status", async (c) => {
    const data = await context.services.admin.getBotStatus();
    return c.json({
      code: 200,
      data
    });
  });

  // ==============================
  // 投递日志管理 API（JSON）
  // ==============================

  /**
   * GET /admin/deliveries
   * 分页查询投递日志（JSON），支持按 status、source 筛选。
   *
   * 查询参数：
   *   ?status=<状态>  — 可选，queued / retrying / delivered / failed
   *   ?source=<来源>  — 可选
   *   ?limit=<条数>   — 每页条数，默认 20
   *   ?page=<页码>    — 默认 1
   */
  app.get("/admin/deliveries", async (c) => {
    const data = await context.services.delivery.listDeliveries(parseDeliveryListQuery(c.req.raw));
    return c.json({
      code: 200,
      data
    });
  });

  /**
   * POST /admin/deliveries/replay-ret2
   * 批量重放所有 ret=-2（上下文失效）的失败投递。
   * 通常在重新激活 Bot 后调用，使之前因 context 过期而失败的投递重新发送。
   *
   * 查询参数：
   *   ?limit=<条数>  — 最大重放条数，默认 20
   *   ?source=<来源> — 可选筛选来源
   */
  app.post("/admin/deliveries/replay-ret2", async (c) => {
    const data = await context.services.delivery.replayFailedRetMinusTwo(parseReplayQuery(c.req.raw));
    return c.json({
      code: 202,
      data
    }, 202);
  });

  /**
   * POST /admin/deliveries/compensate-queued
   * 补偿卡在 queued 状态的过期投递（手动触发版）。
   * 与 Cron 自动补偿逻辑相同，允许管理端手动执行。
   *
   * 查询参数：
   *   ?limit=<条数>              — 最大补偿条数，默认 20
   *   ?olderThanMinutes=<分钟>   — 超过此时间的 queued 记录才补偿，默认 10
   *   ?source=<来源>             — 可选筛选来源
   */
  app.post("/admin/deliveries/compensate-queued", async (c) => {
    const data = await context.services.delivery.compensateStaleQueued(parseQueuedCompensationQuery(c.req.raw));
    return c.json({
      code: 202,
      data
    }, 202);
  });

  /**
   * POST /admin/deliveries/batch/replay
   * 批量重放指定 deliveryIds 的失败投递。
   *
   * 请求体：
   *   { "deliveryIds": ["uuid-1", "uuid-2", ...] }
   * 限制最多 100 条，自动去重。
   */
  app.post("/admin/deliveries/batch/replay", async (c) => {
    const data = await context.services.delivery.replayDeliveries(await parseBatchDeliveryIds(c.req.raw));
    return c.json({
      code: 202,
      data
    }, 202);
  });

  /**
   * POST /admin/deliveries/batch/delete
   * 批量删除已完成（delivered / failed）的投递日志及其幂等记录。
   * 仅删除已结束状态，queued / retrying 的投递不会被删除。
   *
   * 请求体：
   *   { "deliveryIds": ["uuid-1", "uuid-2", ...] }
   */
  app.post("/admin/deliveries/batch/delete", async (c) => {
    const data = await context.services.delivery.deleteCompletedDeliveries(await parseBatchDeliveryIds(c.req.raw));
    return c.json({
      code: 200,
      data
    });
  });

  /**
   * POST /admin/deliveries/:deliveryId/replay
   * 重放单条失败投递，将其重新入队。
   */
  app.post("/admin/deliveries/:deliveryId/replay", async (c) => {
    const data = await context.services.delivery.replayDelivery(c.req.param("deliveryId"));
    return c.json({
      code: 202,
      data
    }, 202);
  });

  /**
   * GET /admin/deliveries/:deliveryId
   * 查询单条投递详情，含完整日志字段。
   * 不存在时返回 404。
   */
  app.get("/admin/deliveries/:deliveryId", async (c) => {
    const data = await context.services.delivery.getDelivery(c.req.param("deliveryId"));
    if (!data) {
      throw new AppError(404, "delivery_not_found", "未找到对应的投递记录。");
    }

    return c.json({
      code: 200,
      data
    });
  });

  // ==============================
  // 消息入站
  // ==============================

  /**
   * POST /api/send
   * 管理员手动发送测试消息。
   * 消息入队后立即返回 202，实际投递由 Queue 消费者异步处理。
   * source 固定为 "admin"。
   *
   * 请求体：
   *   { "text": "...", "traceId"?: "...", "dedupeKey"?: "..." }
   *
   * 鉴权：Bearer ADMIN_TOKEN（/api/* 中间件）
   */
  app.post("/api/send", async (c) => {
    const input = validateIncomingMessage(await parseJsonBody(c.req.raw));
    const data = await context.services.delivery.enqueueDelivery("admin", input);
    return c.json(
      {
        code: 202,
        data
      },
      202
    );
  });

  /**
   * POST /webhook/:source
   * 外部系统 Webhook 入站。
   * URL 中的 :source 标识消息来源（如 github、ci、monitor），
   * 校验后写入 D1 并入队，立即返回 202。
   *
   * 请求体：
   *   { "text": "...", "traceId"?: "...", "dedupeKey"?: "..." }
   *
   * 鉴权：X-Webhook-Token（/webhook/* 中间件）
   *
   * 幂等：source + dedupeKey 联合唯一，相同消息不会重复投递
   */
  app.post("/webhook/:source", async (c) => {
    const source = validateSource(c.req.param("source"));
    const input = validateIncomingMessage(await parseJsonBody(c.req.raw));
    const data = await context.services.delivery.enqueueDelivery(source, input);
    return c.json(
      {
        code: 202,
        data
      },
      202
    );
  });

  return app;
};
