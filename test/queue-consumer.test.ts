import { afterEach, describe, expect, it, vi } from "vitest";
import { handleQueueBatch } from "../src/queue/consumer";
import type { AppContext, AppServices, QueueDeliveryMessage } from "../src/contracts";

const createServices = (outcome: "ack" | "retry", options?: {
  throwOnDeliveryIds?: string[];
  fallbackOutcome?: "ack" | "retry";
  ackStatus?: "delivered" | "failed";
}): AppServices => {
  const throwOnDeliveryIds = new Set(options?.throwOnDeliveryIds ?? []);

  return {
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
      compensateStaleQueued: vi.fn(),
      enqueueKeepaliveIfDue: vi.fn(),
      processQueuedDelivery: vi.fn().mockImplementation(async (deliveryId: string) => {
        if (throwOnDeliveryIds.has(deliveryId)) {
          throw new Error("unexpected processing error");
        }

        return outcome === "retry"
          ? {
              outcome: "retry" as const,
              delaySeconds: 10
            }
          : {
              outcome: "ack" as const,
              deliveryStatus: options?.ackStatus ?? ("delivered" as const),
              error: options?.ackStatus === "failed" ? "iLink ret=-2 errcode=0" : null,
              responseCode: 200
            };
      }),
      handleQueueProcessingError: vi.fn().mockResolvedValue(
        options?.fallbackOutcome === "retry"
          ? {
              outcome: "retry",
              delaySeconds: 5
            }
          : {
              outcome: "ack"
            }
      )
    },
    health: {
      probe: vi.fn()
    }
  };
};

const createContext = (outcome: "ack" | "retry"): AppContext => ({
  config: {
    adminToken: "admin-token",
    webhookSharedToken: "webhook-token",
    keepalive: {
      enabled: true,
      source: "keepalive",
      intervalHours: 24,
      text: "keepalive"
    }
  },
  services: createServices(outcome)
});

const createMessage = (body: QueueDeliveryMessage, attempts = 1) => {
  const state = {
    acked: false,
    retried: false,
    retryOptions: undefined as QueueRetryOptions | undefined
  };

  const message = {
    id: "msg-1",
    timestamp: new Date(),
    body,
    attempts,
    ack: () => {
      state.acked = true;
    },
    retry: (options?: QueueRetryOptions) => {
      state.retried = true;
      state.retryOptions = options;
    }
  } as unknown as Message<QueueDeliveryMessage>;

  return {
    message,
    state
  };
};

describe("queue consumer", () => {
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;

  afterEach(() => {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
    vi.restoreAllMocks();
  });

  it("should ack messages on success", async () => {
    const context = createContext("ack");
    const { message, state } = createMessage({ deliveryId: "delivery-1" });

    const batch = {
      queue: "ilink-notification-queue",
      messages: [message]
    } as unknown as MessageBatch<QueueDeliveryMessage>;

    await handleQueueBatch(batch, context);

    expect(state.acked).toBe(true);
    expect(state.retried).toBe(false);
    expect(context.services.delivery.processQueuedDelivery).toHaveBeenCalledWith("delivery-1", 1);
  });

  it("should retry messages when the service asks for retry", async () => {
    const context = createContext("retry");
    const { message, state } = createMessage({ deliveryId: "delivery-1" }, 2);

    const batch = {
      queue: "ilink-notification-queue",
      messages: [message]
    } as unknown as MessageBatch<QueueDeliveryMessage>;

    await handleQueueBatch(batch, context);

    expect(state.acked).toBe(false);
    expect(state.retried).toBe(true);
    expect(state.retryOptions).toEqual({
      delaySeconds: 10
    });
  });

  it("should handle unexpected errors per message and continue the batch", async () => {
    const context = {
      config: {
        adminToken: "admin-token",
        webhookSharedToken: "webhook-token",
        keepalive: {
          enabled: true,
          source: "keepalive",
          intervalHours: 24,
          text: "keepalive"
        }
      },
      services: createServices("ack", {
        throwOnDeliveryIds: ["delivery-1"],
        fallbackOutcome: "retry"
      })
    } satisfies AppContext;

    const first = createMessage({ deliveryId: "delivery-1" }, 0);
    const second = createMessage({ deliveryId: "delivery-2" }, 1);

    const batch = {
      queue: "ilink-notification-queue",
      messages: [first.message, second.message]
    } as unknown as MessageBatch<QueueDeliveryMessage>;

    await handleQueueBatch(batch, context);

    expect(context.services.delivery.handleQueueProcessingError).toHaveBeenCalledWith(
      "delivery-1",
      0,
      expect.any(Error)
    );
    expect(first.state.retried).toBe(true);
    expect(first.state.retryOptions).toEqual({
      delaySeconds: 5
    });
    expect(second.state.acked).toBe(true);
    expect(context.services.delivery.processQueuedDelivery).toHaveBeenNthCalledWith(2, "delivery-2", 1);
  });

  it("should log business failure details before acking", async () => {
    console.log = vi.fn();
    console.warn = vi.fn();
    console.error = vi.fn();

    const context = {
      config: {
        adminToken: "admin-token",
        webhookSharedToken: "webhook-token",
        keepalive: {
          enabled: true,
          source: "keepalive",
          intervalHours: 24,
          text: "keepalive"
        }
      },
      services: createServices("ack", {
        ackStatus: "failed"
      })
    } satisfies AppContext;
    const { message, state } = createMessage({ deliveryId: "delivery-1" }, 1);

    const batch = {
      queue: "ilink-notification-queue",
      messages: [message]
    } as unknown as MessageBatch<QueueDeliveryMessage>;

    await handleQueueBatch(batch, context);

    expect(state.acked).toBe(true);
    expect(console.error).toHaveBeenCalledWith(
      "[queue] delivery_acked",
      expect.objectContaining({
        component: "queue-consumer",
        event: "delivery_acked",
        deliveryId: "delivery-1",
        attempts: 1,
        deliveryStatus: "failed",
        error: "iLink ret=-2 errcode=0",
        responseCode: 200
      })
    );
  });
});
