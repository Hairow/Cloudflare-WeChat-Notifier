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

const DEFAULT_KEEPALIVE_TEXT = "【保活提醒】请和微信 ClawBot 进行一次交互，保持 iLink 上下文可用。";

const requireBinding = (value: string | undefined, name: string): string => {
  if (!value) {
    throw new AppError(500, "missing_binding", `缺少必需绑定: ${name}`);
  }

  return value;
};

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

export const createAppContext = (env: CloudflareBindings): AppContext => {
  const adminToken = requireBinding(env.ADMIN_TOKEN, "ADMIN_TOKEN");
  const webhookSharedToken = requireBinding(env.WEBHOOK_SHARED_TOKEN, "WEBHOOK_SHARED_TOKEN");
  const encryptionSecret = requireBinding(env.BOT_STATE_ENC_KEY, "BOT_STATE_ENC_KEY");

  const botRepository = new BotStateRepository(env.DB, encryptionSecret);
  const loginSessionRepository = new LoginSessionRepository(env.DB);
  const deliveryLogRepository = new DeliveryLogRepository(env.DB);
  const ilinkClient = new IlinkClient({
    baseUrl: env.ILINK_BASE_URL
  });

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
