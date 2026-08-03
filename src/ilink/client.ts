/**
 * iLink 协议客户端
 * ---------------------------------------------------------------------------
 * iLink 是微信官方开放的 Bot API 协议，底层域名为 ilinkai.weixin.qq.com。
 * 通过微信 ClawBot 插件扫码登录后，获得 bot_token、context_token 等凭证，
 * 即可调用以下端点实现消息收发和管理。
 *
 * ## 协议概要
 *
 *   登录流程：
 *     getBotQrcode  →  用户在微信 ClawBot 中扫码
 *     getQrcodeStatus（轮询）  →  wait → scanned → confirmed  →  获得 bot_token
 *
 *   消息收发：
 *     getUpdates  →  长轮询拉取用户消息（含 context_token）
 *     sendMessage  →  向指定用户发送文本消息
 *     sendTyping   →  发送"正在输入"状态
 *
 * ## 参考链接
 *   - 官方协议说明：https://ilinkai.weixin.qq.com
 *   - 社区 SDK：@wechatbot/wechatbot（wechatbot.dev）
 *   - 社区逆向文档：epiral/weixin-bot（GitHub）
 */
import type { BotState } from "../contracts";
import { IlinkApiError, toErrorMessage } from "../lib/errors";
import { createIlinkClientId, createWechatUin } from "../lib/id";

/** iLink 服务默认地址 */
const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

// ==========================================================================
// 配置类型
// ==========================================================================

interface IlinkClientOptions {
  /** iLink API 基础地址，默认 https://ilinkai.weixin.qq.com */
  baseUrl?: string;
  /**
   * fetch 实现。Cloudflare Workers 中全局 fetch 若作为对象方法调用会触发
   * "Illegal invocation"，因此默认用箭头函数包装一层 globalThis.fetch。
   */
  fetchImpl?: typeof fetch;
}

// ==========================================================================
// 响应类型
// ==========================================================================

/** iLink 所有响应共用字段 */
interface IlinkApiBaseResponse {
  /** 业务返回码，0 表示成功 */
  ret?: number;
  /** 错误码，0 表示无错误 */
  errcode?: number;
  /** 错误信息（字段名因端点而异，都兼容） */
  errmsg?: string;
  err_msg?: string;
  error?: string;
}

// ------ getBotQrcode ------

interface GetBotQrcodeResponse {
  /** 二维码 token，轮询状态时使用 */
  qrcode: string;
  /** 二维码图片 base64 内容，可直接渲染为 <img src="data:image/png;base64,..."> */
  qrcode_img_content: string;
}

// ------ getQrcodeStatus ------

interface GetQrcodeStatusResponse {
  /**
   * 扫码状态：
   *   wait      — 等待扫码
   *   scaned    — 已扫码，等待确认（注意 API 拼写为 scaned，非 scanned）
   *   confirmed — 已确认登录，此时返回 bot_token 等凭证
   *   expired   — 二维码已过期
   */
  status: "wait" | "scaned" | "confirmed" | "expired";
  /** 登录成功后返回的 bot 令牌，后续所有需要鉴权的请求都以此为 Bearer Token */
  bot_token?: string;
  /** Bot 唯一标识 */
  ilink_bot_id?: string;
  /** 登录用户的 iLink 用户 ID，发送消息时的 to_user_id */
  ilink_user_id?: string;
}

// ------ getUpdates ------

interface MessageItem {
  type: number;
  text_item?: {
    text?: string;
  };
}

/** 用户发来的单条消息 */
interface UpdateMessage {
  /** 发送者用户 ID */
  from_user_id?: string;
  /** 当前会话上下文，后续发送消息时必须携带，否则会丢失上下文 */
  context_token?: string;
  /** 消息列表 */
  item_list?: MessageItem[];
}

interface GetUpdatesResponse extends IlinkApiBaseResponse {
  /** 长轮询游标，下次请求传入以实现增量拉取 */
  get_updates_buf?: string;
  /** 建议长轮询超时时间（毫秒） */
  longpolling_timeout_ms?: number;
  /** 新消息列表 */
  msgs?: UpdateMessage[];
}

// ------ sendMessage ------

/** sendMessage 不返回额外字段，仅需校验 ret/errcode */
interface SendMessageResponse extends IlinkApiBaseResponse {}

// ------ sendTyping / getConfig ------

interface SendTypingResponse extends IlinkApiBaseResponse {}

interface GetConfigResponse extends IlinkApiBaseResponse {
  /** sendTyping 所需的临时凭证 */
  typing_ticket?: string;
}

// ==========================================================================
// 工具函数
// ==========================================================================

/**
 * 从 iLink 响应体中提取错误信息。
 * 不同端点返回的错误字段名不同（error / errmsg / err_msg），统一兼容。
 */
const readErrorMessage = (responseBody: Record<string, unknown>): string => {
  const values = [responseBody.error, responseBody.errmsg, responseBody.err_msg]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map((value) => value.trim());

  return values[0] ?? "iLink API request failed";
};

/**
 * 根据 HTTP 状态码和错误消息将 iLink API 错误分类为四个等级，
 * 供上层（Queue 消费者）决定重试策略：
 *
 *   unauthorized — Token 无效或过期，不重试
 *   context     — 上下文失效（context_token 过期），不重试
 *   retryable   — 服务端 5xx 或超时，可重试
 *   unknown     — 未知错误，不重试
 */
const classifyErrorCategory = (
  httpStatus: number | undefined,
  message: string
): "unauthorized" | "context" | "retryable" | "unknown" => {
  const normalized = message.toLowerCase();

  if (httpStatus === 401 || httpStatus === 403 || normalized.includes("unauthorized") || normalized.includes("token")) {
    return "unauthorized";
  }

  if (normalized.includes("context") || normalized.includes("prepare")) {
    return "context";
  }

  if ((httpStatus !== undefined && httpStatus >= 500) || normalized.includes("timeout")) {
    return "retryable";
  }

  return "unknown";
};

// ==========================================================================
// IlinkClient
// ==========================================================================

/**
 * iLink Bot API 客户端，封装微信 iLink 协议的 5 个核心端点。
 *
 * ## 使用示例
 *
 * ```ts
 * const client = new IlinkClient({ baseUrl: "https://ilinkai.weixin.qq.com" });
 *
 * // 1. 获取登录二维码
 * const { qrcode, qrcodeImgContent } = await client.getBotQrcode();
 *
 * // 2. 轮询扫码状态
 * const status = await client.getQrcodeStatus(qrcode);
 * if (status.status === "confirmed") {
 *   console.log("botToken:", status.botToken);
 * }
 *
 * // 3. 发送消息
 * await client.sendMessage(botState, "Hello from Worker!");
 * ```
 */
export class IlinkClient {
  private readonly baseUrl: string;
  /** 箭头函数包装的 fetch，避免 Workers 中 Illegal invocation 问题 */
  private readonly fetchImpl: typeof fetch;

  public constructor(options: IlinkClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  }

  // ==============================
  // 登录
  // ==============================

  /**
   * 获取 Bot 登录二维码。
   *
   * GET /ilink/bot/get_bot_qrcode?bot_type=3
   *
   * 无需鉴权。返回 qrcode token（用于轮询状态）和图片 base64 内容。
   * 二维码有效期通常约 5 分钟。
   */
  public async getBotQrcode(): Promise<{ qrcode: string; qrcodeImgContent: string }> {
    const response = await this.request<GetBotQrcodeResponse>("GET", "/ilink/bot/get_bot_qrcode?bot_type=3", {
      extraHeaders: {
        "iLink-App-ClientVersion": "1"
      }
    });

    return {
      qrcode: response.qrcode,
      qrcodeImgContent: response.qrcode_img_content
    };
  }

  /**
   * 轮询二维码扫码状态。
   *
   * GET /ilink/bot/get_qrcode_status?qrcode={qrcode}
   *
   * 无需鉴权。二维码生命周期：
   *   wait → scanned → confirmed（获得 bot_token） → 登录完成
   *   若过期则返回 expired
   *
   * 注意：API 返回 scanned 时实际拼写为 "scaned"（非标准拼写），此处自动修正。
   */
  public async getQrcodeStatus(qrcode: string): Promise<{
    status: "wait" | "scanned" | "confirmed" | "expired";
    botToken: string | null;
    botId: string | null;
    ilinkUserId: string | null;
  }> {
    const encodedQrcode = encodeURIComponent(qrcode);
    const response = await this.request<GetQrcodeStatusResponse>(
      "GET",
      `/ilink/bot/get_qrcode_status?qrcode=${encodedQrcode}`,
      {
        extraHeaders: {
          "iLink-App-ClientVersion": "1"
        }
      }
    );

    return {
      // 修正 API 拼写：scaned → scanned
      status: response.status === "scaned" ? "scanned" : response.status,
      botToken: response.bot_token ?? null,
      botId: response.ilink_bot_id ?? null,
      ilinkUserId: response.ilink_user_id ?? null
    };
  }

  // ==============================
  // 消息收发
  // ==============================

  /**
   * 拉取新消息（长轮询）。
   *
   * POST /ilink/bot/getupdates
   *
   * 需要 bot_token 鉴权。增量拉取：传入上次返回的 get_updates_buf 作为游标，
   * 服务器会返回该游标之后的新消息。首次调用时 get_updates_buf 为空字符串。
   *
   * 返回的每条消息都携带新的 context_token，发送消息时必须使用最新的。
   *
   * @param bot - Bot 当前状态，需包含 botToken 和上一次的 getUpdatesBuf
   */
  public async getUpdates(bot: BotState): Promise<{ getUpdatesBuf: string | null; messages: UpdateMessage[] }> {
    const response = await this.request<GetUpdatesResponse>("POST", "/ilink/bot/getupdates", {
      token: bot.botToken,
      body: {
        get_updates_buf: bot.getUpdatesBuf ?? "",
        base_info: {
          channel_version: "1.0.0"
        }
      }
    });

    this.assertIlinkBody(response, 200, `${this.baseUrl}/ilink/bot/getupdates`);

    return {
      getUpdatesBuf: response.get_updates_buf ?? null,
      messages: response.msgs ?? []
    };
  }

  /**
   * 发送文本消息。
   *
   * POST /ilink/bot/sendMessage
   *
   * 需要 bot_token。消息体中：
   *   - to_user_id     目标用户的 ilink_user_id
   *   - context_token  当前会话上下文（从 getUpdates 获得的最新值）
   *   - client_id      客户端生成的消息唯一 ID（幂等）
   *   - message_type=2  表示文本消息
   *   - message_state=2 表示已发送状态
   *   - item_list        消息内容列表，type=1 表示文本，text_item.text 为文本内容
   *
   * 发送成功时 ret=0 且 errcode=0，否则抛出 IlinkApiError。
   *
   * @param bot  - Bot 当前状态，需包含 botToken、ilinkUserId、contextToken
   * @param text - 要发送的文本内容
   */
  public async sendMessage(bot: BotState, text: string): Promise<void> {
    const response = await this.request<SendMessageResponse>("POST", "/ilink/bot/sendMessage", {
      token: bot.botToken,
      body: {
        msg: {
          from_user_id: "",               // 发消息时 from 留空
          to_user_id: bot.ilinkUserId,    // 目标用户
          client_id: createIlinkClientId(), // 幂等 ID
          message_type: 2,                // 2 = 文本消息
          message_state: 2,               // 2 = 已发送
          context_token: bot.contextToken, // 会话上下文
          item_list: [
            {
              type: 1,                     // 1 = 文本
              text_item: {
                text
              }
            }
          ]
        },
        base_info: {
          channel_version: "1.0.2"
        }
      }
    });

    this.assertIlinkBody(response, 200, `${this.baseUrl}/ilink/bot/sendMessage`);
  }

  // ==============================
  // 状态
  // ==============================

  /**
   * 发送"正在输入"状态。
   *
   * 需要先调用 getconfig 获取 typing_ticket，再调用 sendtyping 发送状态。
   * 这是一个两步操作：
   *   1. POST /ilink/bot/getconfig   → 获取 typing_ticket
   *   2. POST /ilink/bot/sendtyping  → 发送状态（1=输入中, 2=取消输入中）
   *
   * @param bot    - Bot 当前状态
   * @param status - 1 表示"正在输入"，2 表示"取消正在输入"
   */
  public async sendTyping(bot: BotState, status: 1 | 2): Promise<void> {
    // 步骤 1：获取 typing_ticket
    const config = await this.request<GetConfigResponse>("POST", "/ilink/bot/getconfig", {
      token: bot.botToken,
      body: {
        ilink_user_id: bot.ilinkUserId,
        context_token: bot.contextToken,
        base_info: {
          channel_version: "1.0.0"
        }
      }
    });

    this.assertIlinkBody(config, 200, `${this.baseUrl}/ilink/bot/getconfig`);

    // 步骤 2：发送 typing 状态
    const response = await this.request<SendTypingResponse>("POST", "/ilink/bot/sendtyping", {
      token: bot.botToken,
      body: {
        ilink_user_id: bot.ilinkUserId,
        typing_ticket: config.typing_ticket,
        status,
        base_info: {
          channel_version: "1.0.0"
        }
      }
    });

    this.assertIlinkBody(response, 200, `${this.baseUrl}/ilink/bot/sendtyping`);
  }

  // ==========================================================================
  // 私有方法：HTTP 请求基础设施
  // ==========================================================================

  /**
   * 发起 iLink API 请求。
   *
   * 所有请求自动携带：
   *   - AuthorizationType: ilink_bot_token   — 声明鉴权方式
   *   - X-WECHAT-UIN       — 随机生成的 WeChat UIN（用于日志追踪）
   *   - Authorization: Bearer {token}        — 如有 token 则添加
   *
   * 错误处理：
   *   - 网络异常 → retryable IlinkApiError
   *   - HTTP 非 2xx → 根据消息内容分类（unauthorized / context / retryable / unknown）
   *
   * 注意：并非所有 iLink 端点都返回一致的 ret/errcode 结构（如 getBotQrcode）。
   * 因此本方法只做 HTTP 层面的校验，业务层的 ret/errcode 校验由调用方自行调用
   * assertIlinkBody() 处理。
   */
  private async request<T extends object>(
    method: "GET" | "POST",
    path: string,
    options: {
      token?: string;
      body?: Record<string, unknown>;
      extraHeaders?: Record<string, string>;
    } = {}
  ): Promise<T> {
    const upstreamUrl = `${this.baseUrl}${path}`;
    const headers = new Headers(options.extraHeaders);
    headers.set("AuthorizationType", "ilink_bot_token");
    headers.set("X-WECHAT-UIN", createWechatUin());

    if (options.token) {
      headers.set("Authorization", `Bearer ${options.token}`);
    }

    let body: string | undefined;
    if (options.body) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(upstreamUrl, {
        method,
        headers,
        body
      });
    } catch (error) {
      console.error("[iLink] network failure", {
        upstreamUrl,
        method,
        error: error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              cause: error.cause
            }
          : error
      });

      throw new IlinkApiError(`iLink API network failure: ${toErrorMessage(error)}`, {
        category: "retryable",
        upstreamUrl,
        cause: error
      });
    }

    const text = await response.text();

    // 尝试解析 JSON 响应体，失败时将原始文本存入 error 字段
    const parsed = text ? this.safeParseJson(text) : {};

    if (!response.ok) {
      const message = readErrorMessage(parsed);
      throw new IlinkApiError(message, {
        category: classifyErrorCategory(response.status, message),
        httpStatus: response.status,
        upstreamUrl
      });
    }

    return parsed as T;
  }

  /**
   * 校验 iLink 响应中的 ret/errcode 字段。
   *
   * ret=0 且 errcode=0 表示成功；否则根据消息内容分类并抛出 IlinkApiError。
   * 并非所有端点都返回 ret/errcode（如 getBotQrcode），因此仅在有此结构的端点调用。
   */
  private assertIlinkBody(response: IlinkApiBaseResponse, httpStatus: number, upstreamUrl: string): void {
    const ret = response.ret ?? 0;
    const errcode = response.errcode ?? 0;
    if (ret === 0 && errcode === 0) {
      return;
    }

    const message = response.errmsg ?? response.err_msg ?? response.error ?? `iLink ret=${ret} errcode=${errcode}`;
    throw new IlinkApiError(message, {
      category: classifyErrorCategory(httpStatus, message),
      httpStatus,
      ret,
      errcode,
      upstreamUrl
    });
  }

  /**
   * 安全解析 JSON，失败时不抛异常，将原始内容放入 error 字段返回。
   * 避免因 iLink 返回非标准 JSON（如纯文本错误）而导致未捕获异常。
   */
  private safeParseJson(input: string): Record<string, unknown> {
    try {
      return JSON.parse(input) as Record<string, unknown>;
    } catch {
      return {
        error: input
      };
    }
  }
}
