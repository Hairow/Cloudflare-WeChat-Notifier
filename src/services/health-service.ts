import type { BotStatus, HealthResponse } from "../contracts";
import { nowIso } from "../lib/time";
import { BotStateRepository } from "../storage/bot-state-repository";

export class DefaultHealthService {
  public constructor(
    private readonly db: D1Database,
    private readonly queue: Queue,
    private readonly botRepository: BotStateRepository
  ) {}

  public async probe(): Promise<HealthResponse> {
    let database: HealthResponse["database"] = "ok";
    try {
      await this.db.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    } catch {
      database = "error";
    }

    const bots = await this.botRepository.listAllBrief();

    return {
      service: "ilink-cloudflare",
      timestamp: nowIso(),
      database,
      queue: this.queue ? "configured" : "missing",
      botCount: bots.length,
      bots
    };
  }
}
