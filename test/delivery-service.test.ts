import { describe, expect, it, vi } from "vitest";
import type { DeliveryLog } from "../src/contracts";
import { IlinkClient } from "../src/ilink/client";
import { DefaultDeliveryService } from "../src/services/delivery-service";
import { BotStateRepository } from "../src/storage/bot-state-repository";
import { DeliveryLogRepository } from "../src/storage/delivery-log-repository";

describe("delivery replay", () => {
  it("requeues any failed delivery", async () => {
    const delivery: DeliveryLog = {
      deliveryId: "delivery-1",
      botId: "bot-1",
      source: "github",
      traceId: null,
      dedupeKey: null,
      text: "deploy failed",
      meta: null,
      status: "failed",
      attempts: 3,
      error: "iLink API network failure",
      responseCode: null,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z"
    };
    const repository = {
      getById: vi.fn().mockResolvedValue(delivery),
      markQueuedForReplay: vi.fn().mockResolvedValue(undefined)
    } as unknown as DeliveryLogRepository;
    const queue = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Queue<{ deliveryId: string }>;
    const service = new DefaultDeliveryService(
      queue,
      repository,
      {} as BotStateRepository,
      {} as IlinkClient
    );

    await expect(service.replayDelivery("delivery-1")).resolves.toMatchObject({
      deliveryId: "delivery-1",
      status: "queued",
      replayed: true
    });
    expect(repository.markQueuedForReplay).toHaveBeenCalledWith("delivery-1");
    expect(queue.send).toHaveBeenCalledWith({ deliveryId: "delivery-1" }, { contentType: "json" });
  });

  it("replays only failed deliveries in a selected batch", async () => {
    const failedDelivery: DeliveryLog = {
      deliveryId: "failed-delivery",
      botId: "bot-1",
      source: "github",
      traceId: null,
      dedupeKey: null,
      text: "deploy failed",
      meta: null,
      status: "failed",
      attempts: 3,
      error: "network failure",
      responseCode: null,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z"
    };
    const deliveredDelivery: DeliveryLog = {
      ...failedDelivery,
      deliveryId: "delivered-delivery",
      status: "delivered",
      error: null
    };
    const repository = {
      getById: vi.fn().mockResolvedValueOnce(failedDelivery).mockResolvedValueOnce(deliveredDelivery),
      markQueuedForReplay: vi.fn().mockResolvedValue(undefined)
    } as unknown as DeliveryLogRepository;
    const queue = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Queue<{ deliveryId: string }>;
    const service = new DefaultDeliveryService(
      queue,
      repository,
      {} as BotStateRepository,
      {} as IlinkClient
    );

    await expect(service.replayDeliveries(["failed-delivery", "delivered-delivery"])).resolves.toMatchObject({
      items: [
        { deliveryId: "failed-delivery", replayed: true, status: "queued" },
        { deliveryId: "delivered-delivery", replayed: false, status: "delivered" }
      ]
    });
    expect(repository.markQueuedForReplay).toHaveBeenCalledTimes(1);
    expect(queue.send).toHaveBeenCalledTimes(1);
  });

  it("deletes only the completed records reported by the repository", async () => {
    const repository = {
      deleteCompletedByIds: vi.fn().mockResolvedValue(1)
    } as unknown as DeliveryLogRepository;
    const service = new DefaultDeliveryService(
      {} as Queue<{ deliveryId: string }>,
      repository,
      {} as BotStateRepository,
      {} as IlinkClient
    );

    await expect(service.deleteCompletedDeliveries(["delivery-1", "delivery-2"])).resolves.toEqual({
      selected: 2,
      deleted: 1,
      skipped: 1
    });
    expect(repository.deleteCompletedByIds).toHaveBeenCalledWith(["delivery-1", "delivery-2"]);
  });
});

describe("delivery list pagination", () => {
  it("returns the requested page together with the matching total", async () => {
    const repository = {
      count: vi.fn().mockResolvedValue(41),
      list: vi.fn().mockResolvedValue([])
    } as unknown as DeliveryLogRepository;
    const service = new DefaultDeliveryService(
      {} as Queue<{ deliveryId: string }>,
      repository,
      {} as BotStateRepository,
      {} as IlinkClient
    );

    await expect(service.listDeliveries({ limit: 20, page: 3, status: "failed", source: "github" })).resolves.toMatchObject({
      page: 3,
      limit: 20,
      total: 41,
      totalPages: 3,
      status: "failed",
      source: "github"
    });
    expect(repository.count).toHaveBeenCalledWith({ limit: 20, page: 3, status: "failed", source: "github" });
    expect(repository.list).toHaveBeenCalledWith({ limit: 20, page: 3, status: "failed", source: "github" });
  });

  it("falls back to the last available page when the requested page is out of range", async () => {
    const repository = {
      count: vi.fn().mockResolvedValue(25),
      list: vi.fn().mockResolvedValue([])
    } as unknown as DeliveryLogRepository;
    const service = new DefaultDeliveryService(
      {} as Queue<{ deliveryId: string }>,
      repository,
      {} as BotStateRepository,
      {} as IlinkClient
    );

    await expect(service.listDeliveries({ limit: 20, page: 9 })).resolves.toMatchObject({
      page: 2,
      total: 25,
      totalPages: 2
    });
    expect(repository.list).toHaveBeenCalledWith({ limit: 20, page: 2 });
  });
});
