import type { BotListItem, BotState } from "../contracts";
import { decryptText, encryptText } from "../lib/crypto";
import { nowIso } from "../lib/time";

interface BotStateRow {
  bot_id: string;
  label: string;
  bot_token_ciphertext: string;
  ilink_user_id_ciphertext: string;
  context_token_ciphertext: string | null;
  get_updates_buf_ciphertext: string | null;
  status: BotState["status"];
  last_error: string | null;
  updated_at: string;
}

export class BotStateRepository {
  public constructor(
    private readonly db: D1Database,
    private readonly encryptionSecret: string
  ) {}

  // ==========================================================================
  // 查询
  // ==========================================================================

  /**
   * 按 botId 查询单个 Bot 状态。
   * @param botId - Bot 唯一标识
   * @returns Bot 状态，不存在时返回 null
   */
  public async getById(botId: string): Promise<BotState | null> {
    const row = await this.db
      .prepare(
        `
          SELECT
            bot_id,
            label,
            bot_token_ciphertext,
            ilink_user_id_ciphertext,
            context_token_ciphertext,
            get_updates_buf_ciphertext,
            status,
            last_error,
            updated_at
          FROM bot_state
          WHERE bot_id = ?
        `
      )
      .bind(botId)
      .first<BotStateRow>();

    return row ? this.toEntity(row) : null;
  }

  /**
   * 列出所有 Bot 的简要状态（脱敏，用于管理页面）。
   * @returns Bot 列表
   */
  public async listAll(): Promise<BotState[]> {
    const result = await this.db
      .prepare(
        `
          SELECT
            bot_id,
            label,
            bot_token_ciphertext,
            ilink_user_id_ciphertext,
            context_token_ciphertext,
            get_updates_buf_ciphertext,
            status,
            last_error,
            updated_at
          FROM bot_state
          ORDER BY updated_at DESC
        `
      )
      .all<BotStateRow>();

    return Promise.all(result.results.map((row) => this.toEntity(row)));
  }

  /**
   * 获取 Bot 列表简要视图（脱敏，用于管理页面渲染）。
   */
  public async listAllBrief(): Promise<BotListItem[]> {
    const result = await this.db
      .prepare(
        `
          SELECT bot_id, label, status, last_error, updated_at
          FROM bot_state
          ORDER BY updated_at DESC
        `
      )
      .all<{ bot_id: string; label: string; status: BotState["status"]; last_error: string | null; updated_at: string }>();

    return result.results.map((row) => ({
      botId: row.bot_id,
      label: row.label,
      status: row.status,
      updatedAt: row.updated_at,
      lastError: row.last_error
    }));
  }

  // ==========================================================================
  // 写入
  // ==========================================================================

  /**
   * 保存扫码登录成功的 Bot 信息。
   * 如果 botId 已存在则覆盖（重新登录同一 Bot），否则新增。
   */
  public async saveLoggedInBot(input: {
    botId: string;
    botToken: string;
    ilinkUserId: string;
    label?: string;
  }): Promise<void> {
    await this.upsert({
      botId: input.botId,
      label: input.label ?? "",
      botToken: input.botToken,
      ilinkUserId: input.ilinkUserId,
      contextToken: null,
      getUpdatesBuf: null,
      status: "logged_in",
      lastError: null,
      updatedAt: nowIso()
    });
  }

  /**
   * 更新指定 Bot 的激活状态（contextToken / getUpdatesBuf）。
   */
  public async updateActivation(
    botId: string,
    input: {
      contextToken: string | null;
      getUpdatesBuf: string | null;
      status: Extract<BotState["status"], "needs_activation" | "ready">;
      lastError: string | null;
    }
  ): Promise<void> {
    const current = await this.getById(botId);
    if (!current) {
      return;
    }

    await this.upsert({
      ...current,
      contextToken: input.contextToken,
      getUpdatesBuf: input.getUpdatesBuf,
      status: input.status,
      lastError: input.lastError,
      updatedAt: nowIso()
    });
  }

  /**
   * 更新指定 Bot 的状态。
   */
  public async updateStatus(
    botId: string,
    status: Extract<BotState["status"], "needs_activation" | "needs_login" | "error" | "ready">,
    lastError: string | null
  ): Promise<void> {
    const current = await this.getById(botId);
    if (!current) {
      return;
    }

    await this.upsert({
      ...current,
      status,
      lastError,
      updatedAt: nowIso()
    });
  }

  /**
   * 更新指定 Bot 的最后错误信息。
   */
  public async setLastError(botId: string, lastError: string | null): Promise<void> {
    const current = await this.getById(botId);
    if (!current) {
      return;
    }

    await this.upsert({
      ...current,
      lastError,
      updatedAt: nowIso()
    });
  }

  /**
   * 删除指定 Bot。
   */
  public async delete(botId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM bot_state WHERE bot_id = ?")
      .bind(botId)
      .run();
  }

  // ==========================================================================
  // 内部方法
  // ==========================================================================

  /**
   * 插入或更新 Bot 状态。
   * 使用 bot_id 作为主键，ON CONFLICT 时覆盖。
   */
  private async upsert(state: BotState): Promise<void> {
    await this.db
      .prepare(
        `
          INSERT INTO bot_state (
            bot_id,
            label,
            bot_token_ciphertext,
            ilink_user_id_ciphertext,
            context_token_ciphertext,
            get_updates_buf_ciphertext,
            status,
            last_error,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(bot_id) DO UPDATE SET
            label = excluded.label,
            bot_token_ciphertext = excluded.bot_token_ciphertext,
            ilink_user_id_ciphertext = excluded.ilink_user_id_ciphertext,
            context_token_ciphertext = excluded.context_token_ciphertext,
            get_updates_buf_ciphertext = excluded.get_updates_buf_ciphertext,
            status = excluded.status,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at
        `
      )
      .bind(
        state.botId,
        state.label,
        await encryptText(this.encryptionSecret, state.botToken),
        await encryptText(this.encryptionSecret, state.ilinkUserId),
        await encryptText(this.encryptionSecret, state.contextToken),
        await encryptText(this.encryptionSecret, state.getUpdatesBuf),
        state.status,
        state.lastError,
        state.updatedAt
      )
      .run();
  }

  private async toEntity(row: BotStateRow): Promise<BotState> {
    return {
      botId: row.bot_id,
      label: row.label,
      botToken: (await decryptText(this.encryptionSecret, row.bot_token_ciphertext)) ?? "",
      ilinkUserId: (await decryptText(this.encryptionSecret, row.ilink_user_id_ciphertext)) ?? "",
      contextToken: await decryptText(this.encryptionSecret, row.context_token_ciphertext),
      getUpdatesBuf: await decryptText(this.encryptionSecret, row.get_updates_buf_ciphertext),
      status: row.status,
      lastError: row.last_error,
      updatedAt: row.updated_at
    };
  }
}
