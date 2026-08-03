/**
 * 契约定义（Contracts）
 * ---------------------------------------------------------------------------
 * 本文件定义了整个应用中所有共享的类型、接口和数据契约，不包含任何实现逻辑。
 * 所有模块（路由、服务、仓储、消费者）都通过这里的接口进行协作，实现编译期类型安全。
 *
 * ## 组织方式
 *
 *   枚举/字面量类型  →  BotStatus / DeliveryStatus 等
 *   数据模型        →  BotState / DeliveryLog / LoginSession 等
 *   请求/响应 DTO   →  IncomingMessagePayload / EnqueueDeliveryResult 等
 *   服务接口        →  AdminService / DeliveryService / HealthService
 *   顶层上下文      →  AppContext（绑定运行时配置 + 服务集合）
 *
 * ## 设计原则
 *   - 数据不可变：所有接口字段均为只读语义（通过类型约束）
 *   - 面向接口编程：路由层只依赖 AppContext，不直接 import 具体实现
 *   - 错误统一：服务层抛出 AppError / IlinkApiError，由路由层统一捕获
 *   - 多 Bot 支持：botId 贯穿整个投递链路，Webhook 路由携带 botId
 */

// ==========================================================================
// 状态枚举
// ==========================================================================

/**
 * Bot 生命周期状态：
 *
 *   logged_in        — 已登录但未激活（缺少 context_token）
 *   needs_activation — 需要调用 getUpdates 获取 context_token
 *   ready            — 一切就绪，可以收发消息
 *   needs_login      — 凭证过期，需要重新扫码登录
 *   error            — 发生异常
 */
export type BotStatus = "logged_in" | "needs_activation" | "ready" | "needs_login" | "error";

/** 登录会话（二维码）生命周期 */
export type LoginSessionStatus = "wait" | "scanned" | "confirmed" | "expired";

/** 投递日志状态：queued → (retrying) → delivered / failed */
export type DeliveryStatus = "queued" | "retrying" | "delivered" | "failed";

// ==========================================================================
// 核心数据模型
// ==========================================================================

/**
 * Bot 持久化状态。
 * 多 Bot 模式下，bot_id 为主键，每个 Bot 独立存储一行。
 * 敏感字段（botToken、ilinkUserId、contextToken）在 D1 中以 AES-GCM 加密存储。
 */
export interface BotState {
  /** iLink Bot 唯一标识，扫码登录成功后获得 */
  botId: string;
  /** 用户标签，便于识别（如 "张三-OA通知"） */
  label: string;
  /** Bot 鉴权令牌，所有需要鉴权的 API 请求都以此为 Bearer Token */
  botToken: string;
  /** 当前登录用户的 iLink 用户 ID，发送消息时的 to_user_id */
  ilinkUserId: string;
  /** 会话上下文令牌，由 getUpdates 返回，发送消息时必带；为空表示未激活 */
  contextToken: string | null;
  /** 长轮询游标，增量拉取消息时使用 */
  getUpdatesBuf: string | null;
  /** Bot 当前生命周期状态 */
  status: BotStatus;
  /** 最近一次错误信息，正常时为空 */
  lastError: string | null;
  /** ISO 8601 时间戳，最后更新时间 */
  updatedAt: string;
}

/** 对外暴露的 Bot 状态视图（脱敏，不暴露 token 等敏感字段） */
export interface BotStatusView {
  status: BotStatus;
  botId: string | null;
  label: string | null;
  updatedAt: string | null;
  lastError: string | null;
}

/** Bot 列表项（脱敏，用于管理页面展示） */
export interface BotListItem {
  botId: string;
  label: string;
  status: BotStatus;
  updatedAt: string;
  lastError: string | null;
}

/**
 * 登录会话。
 * 每次扫码登录创建一个新会话，包含二维码 token 和图片内容。
 * 过期后不再可用，需要重新创建。
 */
export interface LoginSession {
  /** 会话唯一标识（UUID） */
  sessionId: string;
  /** 二维码 token，用于轮询扫码状态 */
  qrcodeToken: string;
  /** 二维码图片 base64 内容，前端直接渲染为 <img> */
  qrcodeImgContent: string;
  /** 会话状态：wait → scanned → confirmed → expired */
  status: LoginSessionStatus;
  /** 会话过期时间（ISO 8601） */
  expiresAt: string;
  /** 登录成功后关联的 botId */
  botId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 投递日志。
 * 每条入站消息（Webhook 或 API 请求）对应一条投递日志，
 * 记录从入站到最终投递的完整生命周期。
 */
export interface DeliveryLog {
  /** 投递唯一标识（UUID V7，按时间有序） */
  deliveryId: string;
  /** 目标 Bot ID，投递将发送到该 Bot 对应的微信 */
  botId: string;
  /** 消息来源，对应 Webhook URL 中的 :source 参数 */
  source: string;
  /** 调用方传入的追踪 ID，用于跨系统关联日志 */
  traceId: string | null;
  /** 幂等去重键，与 botId + source 联合构成唯一约束 */
  dedupeKey: string | null;
  /** 要发送的文本内容 */
  text: string;
  /** 调用方附带的扩展元数据（JSON 对象） */
  meta: Record<string, unknown> | null;
  /** 投递状态 */
  status: DeliveryStatus;
  /** 已尝试发送次数（含当前次） */
  attempts: number;
  /** 失败时的错误信息 */
  error: string | null;
  /** 最后一次 iLink API 响应的 HTTP 状态码 */
  responseCode: number | null;
  createdAt: string;
  updatedAt: string;
}

// ==========================================================================
// 请求 / 响应 DTO
// ==========================================================================

/** 入站消息负载（Webhook / API 请求体） */
export interface IncomingMessagePayload {
  /** 必填，要发送的文本内容 */
  text: string;
  /** 可选，用于跨系统追踪 */
  traceId?: string;
  /** 可选，幂等去重键 */
  dedupeKey?: string;
  /** 可选，扩展元数据 */
  meta?: Record<string, unknown>;
}

/** Cloudflare Queue 中的消息体 */
export interface QueueDeliveryMessage {
  deliveryId: string;
}

/** 创建登录二维码的响应 */
export interface LoginQrcodeResponse {
  sessionId: string;
  qrcode: string;
  qrcodeImgContent: string;
  expiresAt: string;
}

/** 查询扫码状态的响应 */
export interface LoginStatusResponse {
  sessionId: string;
  status: LoginSessionStatus;
  botId: string | null;
  expiresAt: string;
}

/** 激活 Bot 的响应 */
export interface ActivateBotResponse {
  status: BotStatus;
  botId: string | null;
  updatedAt: string | null;
  message: string;
}

/** 入队投递结果 */
export interface EnqueueDeliveryResult {
  deliveryId: string;
  /** 目标 Bot ID */
  botId: string;
  /** 是否为重复投递（幂等拦截） */
  duplicate: boolean;
  status: DeliveryStatus;
}

/** 投递日志列表查询参数 */
export interface DeliveryListQuery {
  limit: number;
  page: number;
  status?: DeliveryStatus;
  source?: string;
  /** 可选，按 Bot ID 筛选 */
  botId?: string;
}

/** 投递日志列表分页结果 */
export interface DeliveryListResult {
  items: DeliveryLog[];
  limit: number;
  page: number;
  total: number;
  totalPages: number;
  status?: DeliveryStatus;
  source?: string;
  botId?: string;
}

/** 队列消费处理结果，决定消息的 ack/retry 策略 */
export interface QueueProcessResult {
  /** ack — 消费成功，从队列中移除；retry — 重新入队等待重试 */
  outcome: "ack" | "retry";
  /** 重试延迟秒数（仅 outcome=retry 时有效） */
  delaySeconds?: number;
  /** 处理后的投递状态，not_found 表示 deliveryId 在数据库中不存在 */
  deliveryStatus?: DeliveryStatus | "not_found";
  error?: string | null;
  responseCode?: number | null;
}

/** 单条投注重放结果 */
export interface ReplayDeliveryResult {
  deliveryId: string;
  status: DeliveryStatus;
  /** 是否成功重新入队 */
  replayed: boolean;
  error?: string | null;
}

/** 批量重放投递结果 */
export interface ReplayDeliveriesResult {
  items: ReplayDeliveryResult[];
}

/** 批量删除投递日志结果 */
export interface DeleteDeliveriesResult {
  /** 请求删除的数量 */
  selected: number;
  /** 实际删除的数量 */
  deleted: number;
  /** 跳过的数量（状态不符合删除条件） */
  skipped: number;
}

/** 重放 ret=-2（上下文失效）的失败投递 */
export interface ReplayFailedRetMinusTwoResult {
  items: ReplayDeliveryResult[];
  limit: number;
  source?: string;
}

/** 补偿卡在 queued 状态的过期投递 */
export interface CompensateStaleQueuedResult {
  items: ReplayDeliveryResult[];
  limit: number;
  olderThanMinutes: number;
  source?: string;
}

// ==========================================================================
// 配置相关
// ==========================================================================

/** 保活提醒配置，从环境变量中解析 */
export interface KeepaliveConfig {
  /** 是否启用保活 */
  enabled: boolean;
  /** 保活消息的 source 标识 */
  source: string;
  /** 保活间隔小时数 */
  intervalHours: number;
  /** 保活提醒文本 */
  text: string;
}

/** 定时保活执行结果 */
export interface ScheduledKeepaliveResult {
  /** 总体是否至少有一条入队 */
  enqueued: boolean;
  /** 每个 Bot 的保活结果 */
  perBot: ScheduledKeepalivePerBotResult[];
}

/** 单个 Bot 的保活结果 */
export interface ScheduledKeepalivePerBotResult {
  botId: string;
  label: string;
  enqueued: boolean;
  reason: "disabled" | "not_due" | "queued" | "duplicate" | "skipped" | "activated" | "activation_failed";
  deliveryId: string | null;
  lastDeliveryId: string | null;
  lastCreatedAt: string | null;
  nextDueAt: string | null;
}

/** /healthz 响应 */
export interface HealthResponse {
  service: string;
  timestamp: string;
  database: "ok" | "error";
  queue: "configured" | "missing";
  /** Bot 总数 */
  botCount: number;
  /** Bot 简要状态列表 */
  bots: BotListItem[];
}

// ==========================================================================
// 服务接口（面向接口编程）
// ==========================================================================

/** 管理员服务：处理 Bot 登录、激活、状态查询 */
export interface AdminService {
  /** 创建登录二维码会话 */
  createLoginQrcode(): Promise<LoginQrcodeResponse>;
  /** 轮询扫码状态 */
  getLoginStatus(sessionId: string): Promise<LoginStatusResponse>;
  /** 激活指定 Bot（调用 getUpdates 获取 context_token） */
  activateBot(botId: string): Promise<ActivateBotResponse>;
  /** 查询指定 Bot 状态，不传 botId 则返回第一个 Ready Bot */
  getBotStatus(botId: string): Promise<BotStatusView>;
  /** 列出所有 Bot */
  listBots(): Promise<BotListItem[]>;
  /** 删除指定 Bot */
  deleteBot(botId: string): Promise<void>;
  /** 更新指定 Bot 的 label */
  updateBotLabel(botId: string, label: string): Promise<void>;
}

/** 投递服务：消息入队、队列消费、日志管理 */
export interface DeliveryService {
  /** 将消息写入 D1 并投入 Cloudflare Queue */
  enqueueDelivery(botId: string, source: string, payload: IncomingMessagePayload): Promise<EnqueueDeliveryResult>;
  /** 分页查询投递日志 */
  listDeliveries(query: DeliveryListQuery): Promise<DeliveryListResult>;
  /** 查询单条投递详情 */
  getDelivery(deliveryId: string): Promise<DeliveryLog | null>;
  /** 重放单条失败投递 */
  replayDelivery(deliveryId: string): Promise<ReplayDeliveryResult>;
  /** 批量重放失败投递 */
  replayDeliveries(deliveryIds: string[]): Promise<ReplayDeliveriesResult>;
  /** 批量删除已完成（delivered/failed）的投递日志 */
  deleteCompletedDeliveries(deliveryIds: string[]): Promise<DeleteDeliveriesResult>;
  /** 重放所有 ret=-2（上下文失效）的失败投递 */
  replayFailedRetMinusTwo(query: { limit: number; source?: string }): Promise<ReplayFailedRetMinusTwoResult>;
  /** 补偿卡在 queued 状态的过期投递（Cron 触发） */
  compensateStaleQueued(query: { limit: number; olderThanMinutes: number; source?: string }): Promise<CompensateStaleQueuedResult>;
  /** 检查并执行保活（Cron 触发），遍历所有 ready/needs_activation Bot */
  enqueueKeepaliveIfDue(config: KeepaliveConfig, now?: Date): Promise<ScheduledKeepaliveResult>;
  /** 队列消费者处理单条投递 */
  processQueuedDelivery(deliveryId: string, attempts: number): Promise<QueueProcessResult>;
  /** 队列消费者处理异常 */
  handleQueueProcessingError(deliveryId: string, attempts: number, error: unknown): Promise<QueueProcessResult>;
}

/** 健康检查服务 */
export interface HealthService {
  /** 探测数据库、队列、所有 Bot 状态 */
  probe(): Promise<HealthResponse>;
}

// ==========================================================================
// 运行时上下文
// ==========================================================================

/** 从环境变量 / Secret 中解析的运行时配置 */
export interface RuntimeConfig {
  /** 管理后台鉴权令牌 */
  adminToken: string;
  /** Webhook 鉴权令牌 */
  webhookSharedToken: string;
  /** 保活配置 */
  keepalive: KeepaliveConfig;
}

/** 所有业务服务的集合，由容器注入 */
export interface AppServices {
  admin: AdminService;
  delivery: DeliveryService;
  health: HealthService;
}

/**
 * 应用顶层上下文。
 * 路由层和队列消费者都通过此上下文访问配置和服务，
 * 不直接依赖任何具体实现类。
 */
export interface AppContext {
  config: RuntimeConfig;
  services: AppServices;
}
