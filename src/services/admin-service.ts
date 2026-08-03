import type { ActivateBotResponse, AdminService, BotListItem, BotStatusView, LoginQrcodeResponse, LoginSession, LoginStatusResponse } from "../contracts";
import { IlinkClient } from "../ilink/client";
import { AppError } from "../lib/errors";
import { createSessionId } from "../lib/id";
import { nowIso } from "../lib/time";
import { BotStateRepository } from "../storage/bot-state-repository";
import { LoginSessionRepository } from "../storage/login-session-repository";

const LOGIN_EXPIRES_IN_MS = 5 * 60 * 1000;

export class DefaultAdminService implements AdminService {
  public constructor(
    private readonly ilinkClient: IlinkClient,
    private readonly botRepository: BotStateRepository,
    private readonly loginSessionRepository: LoginSessionRepository
  ) { }

  /**
   * 创建登录二维码会话。
   */
  public async createLoginQrcode(): Promise<LoginQrcodeResponse> {
    const qrcode = await this.ilinkClient.getBotQrcode();
    const now = Date.now();
    const session: LoginSession = {
      sessionId: createSessionId(),
      qrcodeToken: qrcode.qrcode,
      qrcodeImgContent: qrcode.qrcodeImgContent,
      status: "wait",
      expiresAt: new Date(now + LOGIN_EXPIRES_IN_MS).toISOString(),
      botId: null,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString()
    };

    await this.loginSessionRepository.create(session);

    return {
      sessionId: session.sessionId,
      qrcode: session.qrcodeToken,
      qrcodeImgContent: session.qrcodeImgContent,
      expiresAt: session.expiresAt
    };
  }

  public async getLoginStatus(sessionId: string): Promise<LoginStatusResponse> {
    const session = await this.loginSessionRepository.getById(sessionId);
    if (!session) {
      throw new AppError(404, "session_not_found", "未找到对应的登录会话。");
    }

    if (Date.parse(session.expiresAt) <= Date.now() && session.status !== "confirmed") {
      await this.loginSessionRepository.updateStatus(sessionId, "expired", nowIso(), session.botId);
      return {
        sessionId,
        status: "expired",
        botId: session.botId,
        expiresAt: session.expiresAt
      };
    }

    if (session.status === "confirmed") {
      return {
        sessionId,
        status: session.status,
        botId: session.botId,
        expiresAt: session.expiresAt
      };
    }

    const remote = await this.ilinkClient.getQrcodeStatus(session.qrcodeToken);
    const updatedAt = nowIso();

    if (remote.status === "confirmed") {
      if (!remote.botToken || !remote.botId || !remote.ilinkUserId) {
        throw new AppError(502, "ilink_invalid_login_response", "iLink 返回了不完整的登录结果。");
      }

      // label 默认使用 botId 前缀，用户后续可在管理页面修改
      await this.botRepository.saveLoggedInBot({
        botId: remote.botId,
        botToken: remote.botToken,
        ilinkUserId: remote.ilinkUserId,
        label: remote.botId.slice(0, 12)
      });
      await this.loginSessionRepository.updateStatus(sessionId, "confirmed", updatedAt, remote.botId);

      return {
        sessionId,
        status: "confirmed",
        botId: remote.botId,
        expiresAt: session.expiresAt
      };
    }

    const status = remote.status;
    await this.loginSessionRepository.updateStatus(sessionId, status, updatedAt, session.botId);

    return {
      sessionId,
      status,
      botId: session.botId,
      expiresAt: session.expiresAt
    };
  }

  /**
   * 激活指定 Bot。
   * 调用 getUpdates 获取 context_token 并持久化。
   */
  public async activateBot(botId: string): Promise<ActivateBotResponse> {
    const bot = await this.botRepository.getById(botId);
    if (!bot) {
      throw new AppError(404, "bot_not_found", `未找到 botId=${botId} 的 Bot。`);
    }

    const updates = await this.ilinkClient.getUpdates(bot);
    const firstContextToken = updates.messages.find(
      (message) => typeof message.context_token === "string" && message.context_token.trim() !== ""
    )?.context_token;

    const contextToken = firstContextToken ?? bot.contextToken;
    const getUpdatesBuf = updates.getUpdatesBuf ?? bot.getUpdatesBuf;

    if (contextToken) {
      await this.botRepository.updateActivation(botId, {
        contextToken,
        getUpdatesBuf,
        status: "ready",
        lastError: null
      });

      return {
        status: "ready",
        botId: bot.botId,
        updatedAt: nowIso(),
        message: "bot 已激活，可以开始接收 webhook 并发信。"
      };
    }

    const activationMessage = "尚未拿到可用的 context_token，请先给微信ClawBot发一条消息后再调用激活接口。";
    await this.botRepository.updateActivation(botId, {
      contextToken: null,
      getUpdatesBuf,
      status: "needs_activation",
      lastError: activationMessage
    });

    return {
      status: "needs_activation",
      botId: bot.botId,
      updatedAt: nowIso(),
      message: activationMessage
    };
  }

  /**
   * 查询指定 Bot 状态。
   */
  public async getBotStatus(botId: string): Promise<BotStatusView> {
    const bot = await this.botRepository.getById(botId);
    if (!bot) {
      throw new AppError(404, "bot_not_found", `未找到 botId=${botId} 的 Bot。`);
    }

    return {
      status: bot.status,
      botId: bot.botId,
      label: bot.label,
      updatedAt: bot.updatedAt,
      lastError: bot.lastError
    };
  }

  /**
   * 列出所有 Bot（脱敏）。
   */
  public async listBots(): Promise<BotListItem[]> {
    return this.botRepository.listAllBrief();
  }

  /**
   * 删除指定 Bot。
   */
  public async deleteBot(botId: string): Promise<void> {
    const bot = await this.botRepository.getById(botId);
    if (!bot) {
      throw new AppError(404, "bot_not_found", `未找到 botId=${botId} 的 Bot。`);
    }

    await this.botRepository.delete(botId);
  }

  /**
   * 更新指定 Bot 的 label（别名/备注）。
   */
  public async updateBotLabel(botId: string, label: string): Promise<void> {
    await this.botRepository.updateLabel(botId, label);
  }
}
