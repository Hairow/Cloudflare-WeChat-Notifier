import { afterEach, describe, expect, it, vi } from "vitest";
import { IlinkClient } from "../src/ilink/client";
import type { BotState } from "../src/contracts";

describe("IlinkClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should call global fetch without triggering illegal invocation", async () => {
    globalThis.fetch = function (this: typeof globalThis, input: RequestInfo | URL, _init?: RequestInit) {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }

      expect(String(input)).toContain("/ilink/bot/get_bot_qrcode");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ret: 0,
            qrcode: "qrcode-token",
            qrcode_img_content: "https://liteapp.weixin.qq.com/q/example"
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        )
      );
    } as typeof fetch;

    const client = new IlinkClient({
      baseUrl: "https://ilinkai.weixin.qq.com"
    });

    await expect(client.getBotQrcode()).resolves.toEqual({
      qrcode: "qrcode-token",
      qrcodeImgContent: "https://liteapp.weixin.qq.com/q/example"
    });
  });

  it("should use the current camelCase sendMessage endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ret: 0,
          errcode: 0
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    const client = new IlinkClient({
      baseUrl: "https://ilinkai.weixin.qq.com",
      fetchImpl
    });

    const bot: BotState = {
      botId: "bot-1",
      botToken: "bot-token",
      ilinkUserId: "user-1",
      contextToken: "context-token",
      getUpdatesBuf: "updates-buf",
      status: "ready",
      lastError: null,
      updatedAt: "2026-05-14T00:00:00.000Z"
    };

    await client.sendMessage(bot, "hello");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://ilinkai.weixin.qq.com/ilink/bot/sendMessage");
  });
});
