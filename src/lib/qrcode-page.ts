const escapeHtml = (input: string): string =>
  input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const renderQrcodeLoginPage = (input: {
  sessionId: string;
  expiresAt: string;
  svgMarkup: string;
  adminToken: string;
}): string => {
  const escapedSessionId = escapeHtml(input.sessionId);
  const escapedExpiresAt = escapeHtml(input.expiresAt);
  const escapedToken = escapeHtml(input.adminToken);

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>iLink 登录二维码</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4f7fb;
        --card: #ffffff;
        --line: #d6dfeb;
        --text: #17202d;
        --muted: #556273;
        --accent: #0f766e;
        --accent-soft: #dff5f2;
      }
      * { box-sizing: border-box; }
      html {
        overflow-x: hidden;
      }
      body {
        margin: 0;
        font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        background: radial-gradient(circle at top, #eefbf8 0%, var(--bg) 52%, #edf2ff 100%);
        color: var(--text);
        overflow-x: hidden;
      }
      .shell {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: clamp(12px, 3vw, 24px);
      }
      .card {
        width: min(920px, 100%);
        background: rgba(255, 255, 255, 0.92);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(214, 223, 235, 0.9);
        border-radius: 24px;
        box-shadow: 0 24px 80px rgba(24, 39, 75, 0.12);
        overflow: hidden;
      }
      .grid {
        display: grid;
        grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
      }
      .qr {
        background: linear-gradient(160deg, #ffffff 0%, #eef7ff 100%);
        padding: clamp(22px, 4vw, 32px);
        display: grid;
        place-items: center;
        border-right: 1px solid var(--line);
        min-width: 0;
      }
      .qr svg {
        display: block;
        width: min(300px, 100%);
        max-width: 300px;
        height: auto;
      }
      .content {
        padding: clamp(22px, 4vw, 32px);
        min-width: 0;
      }
      h1 {
        margin: 0 0 8px;
        font-size: clamp(26px, 5vw, 28px);
        line-height: 1.18;
      }
      p {
        margin: 0;
        color: var(--muted);
        line-height: 1.7;
        overflow-wrap: anywhere;
      }
      .meta {
        margin-top: 18px;
        display: grid;
        gap: 10px;
      }
      .meta-row {
        padding: 12px 14px;
        border-radius: 14px;
        background: #f7fafc;
        border: 1px solid var(--line);
        font-size: 14px;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .status {
        margin-top: 20px;
        padding: 16px 18px;
        border-radius: 16px;
        background: var(--accent-soft);
        color: var(--accent);
        font-weight: 600;
        overflow-wrap: anywhere;
      }
      .actions {
        margin-top: 18px;
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        align-items: center;
        min-width: 0;
      }
      button,
      a.button {
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 0;
        border-radius: 999px;
        padding: 12px 18px;
        min-height: 46px;
        background: var(--text);
        color: #fff;
        text-decoration: none;
        font-weight: 600;
        cursor: pointer;
        line-height: 1.2;
        text-align: center;
        white-space: nowrap;
        max-width: 100%;
        touch-action: manipulation;
      }
      button.secondary,
      a.secondary {
        background: transparent;
        color: var(--text);
        border: 1px solid var(--line);
      }
      .hint {
        margin-top: 20px;
        font-size: 14px;
        color: var(--muted);
      }
      code {
        font-family: Consolas, "SFMono-Regular", monospace;
        background: #f3f5f8;
        border-radius: 8px;
        padding: 2px 6px;
        overflow-wrap: anywhere;
      }
      button:disabled {
        cursor: not-allowed;
        opacity: 0.58;
      }
      button:focus-visible,
      a.button:focus-visible {
        outline: 3px solid rgba(15, 118, 110, 0.28);
        outline-offset: 2px;
      }
      @media (max-width: 860px) {
        .grid { grid-template-columns: 1fr; }
        .qr { border-right: 0; border-bottom: 1px solid var(--line); }
      }
      @media (max-width: 560px) {
        .card {
          border-radius: 20px;
        }
        .actions > * {
          flex: 1 1 100%;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="card">
        <div class="grid">
          <div class="qr">${input.svgMarkup}</div>
          <div class="content">
            <h1>扫码登录 iLink</h1>
            <p>打开微信扫描左侧二维码。页面会自动轮询状态；确认登录后，你可以直接在这里触发激活。</p>

            <div class="meta">
              <div class="meta-row"><strong>Session ID:</strong> <code>${escapedSessionId}</code></div>
              <div class="meta-row"><strong>过期时间:</strong> <code>${escapedExpiresAt}</code></div>
            </div>

            <div class="status" id="status-box">当前状态：等待扫码</div>

            <div class="actions">
              <button id="activate-btn" disabled>确认后激活</button>
              <a class="button secondary" href="/admin/bot/login/qrcode/page?token=${escapedToken}">刷新二维码</a>
            </div>

            <p class="hint" id="hint-box">如果登录确认后仍无法激活，请先给“微信ClawBot”发一条消息，再点击“确认后激活”。</p>
          </div>
        </div>
      </section>
    </main>

    <script>
      const adminToken = ${JSON.stringify(input.adminToken)};
      const sessionId = ${JSON.stringify(input.sessionId)};
      const statusBox = document.getElementById("status-box");
      const hintBox = document.getElementById("hint-box");
      const activateBtn = document.getElementById("activate-btn");
      let polling = true;
      let loggedIn = false;

      const setStatus = (text, tone) => {
        statusBox.textContent = text;
        statusBox.style.background = tone === "error" ? "#fee2e2" : tone === "success" ? "#dcfce7" : "#dff5f2";
        statusBox.style.color = tone === "error" ? "#991b1b" : tone === "success" ? "#166534" : "#0f766e";
      };

      const fetchStatus = async () => {
        if (!polling) return;
        const response = await fetch("/admin/bot/login/status/" + encodeURIComponent(sessionId) + "?token=" + encodeURIComponent(adminToken));
        const payload = await response.json();
        if (!response.ok) {
          setStatus("状态查询失败：" + payload.message, "error");
          polling = false;
          return;
        }

        const status = payload.data.status;
        if (status === "wait") {
          setStatus("当前状态：等待扫码", "info");
          return;
        }
        if (status === "scanned") {
          setStatus("当前状态：已扫码，请在手机上确认", "info");
          return;
        }
        if (status === "expired") {
          setStatus("当前状态：二维码已过期，请刷新页面重新获取。", "error");
          polling = false;
          return;
        }
        if (status === "confirmed") {
          loggedIn = true;
          activateBtn.disabled = false;
          setStatus("当前状态：登录已确认，可以继续激活。", "success");
          hintBox.textContent = "下一步：先给“微信ClawBot”发一条消息，然后点击“确认后激活”。";
          polling = false;
        }
      };

      activateBtn.addEventListener("click", async () => {
        activateBtn.disabled = true;
        setStatus("正在尝试激活...", "info");
        const response = await fetch("/admin/bot/activate?token=" + encodeURIComponent(adminToken), {
          method: "POST"
        });
        const payload = await response.json();
        if (!response.ok) {
          setStatus("激活失败：" + payload.message, "error");
          activateBtn.disabled = !loggedIn;
          return;
        }

        const result = payload.data;
        if (result.status === "ready") {
          setStatus("激活成功：bot 已就绪，可以开始发信。", "success");
          hintBox.textContent = "现在可以调用 /webhook/:source 或 /api/send 进行发送测试。";
          return;
        }

        setStatus("激活未完成：" + result.message, "error");
        hintBox.textContent = result.message;
        activateBtn.disabled = false;
      });

      fetchStatus();
      setInterval(fetchStatus, 2000);
    </script>
  </body>
</html>`;
};
