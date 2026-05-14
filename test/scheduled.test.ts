import { afterEach, describe, expect, it, vi } from "vitest";
import { handleScheduled } from "../src/index";
import type { AppContext } from "../src/contracts";

const createContext = (): AppContext => ({
  config: {
    adminToken: "admin-token",
    webhookSharedToken: "webhook-token",
    keepalive: {
      enabled: true,
      source: "keepalive",
      intervalHours: 24,
      text: "请进行交互保活"
    }
  },
  services: {
    admin: {
      createLoginQrcode: vi.fn(),
      getLoginStatus: vi.fn(),
      activateBot: vi.fn(),
      getBotStatus: vi.fn()
    },
    delivery: {
      enqueueDelivery: vi.fn(),
      listDeliveries: vi.fn(),
      getDelivery: vi.fn(),
      replayDelivery: vi.fn(),
      replayFailedRetMinusTwo: vi.fn(),
      compensateStaleQueued: vi.fn().mockResolvedValue({
        items: [],
        limit: 20,
        olderThanMinutes: 10,
        source: undefined
      }),
      enqueueKeepaliveIfDue: vi.fn().mockResolvedValue({
        enqueued: true,
        reason: "queued",
        deliveryId: "delivery-keepalive",
        lastDeliveryId: null,
        lastCreatedAt: null,
        nextDueAt: "2026-05-15T00:00:00.000Z"
      }),
      processQueuedDelivery: vi.fn(),
      handleQueueProcessingError: vi.fn()
    },
    health: {
      probe: vi.fn()
    }
  }
});

describe("scheduled handler", () => {
  const originalConsoleLog = console.log;

  afterEach(() => {
    console.log = originalConsoleLog;
    vi.restoreAllMocks();
  });

  it("should run stale queued compensation and keepalive scheduling", async () => {
    console.log = vi.fn();
    const context = createContext();
    const controller = {
      cron: "*/15 * * * *",
      scheduledTime: Date.parse("2026-05-14T00:00:00.000Z")
    } as ScheduledController;

    await handleScheduled(controller, context);

    expect(context.services.delivery.compensateStaleQueued).toHaveBeenCalledWith({
      limit: 20,
      olderThanMinutes: 10
    });
    expect(context.services.delivery.enqueueKeepaliveIfDue).toHaveBeenCalledWith(
      context.config.keepalive,
      new Date("2026-05-14T00:00:00.000Z")
    );
    expect(console.log).toHaveBeenCalledWith(
      "[scheduled] keepalive",
      expect.objectContaining({
        event: "keepalive",
        enqueued: true,
        reason: "queued",
        deliveryId: "delivery-keepalive"
      })
    );
  });
});
