const escapeHtml = (input: string): string =>
  input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const renderDashboardPage = (input: {
  adminToken: string;
  webhookToken: string;
  refreshSeconds: number;
  logsLimit: number;
}): string => {
  const escapedToken = escapeHtml(input.adminToken);
  const escapedWebhookToken = escapeHtml(input.webhookToken);

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>iLink 管理总览</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4f7fb;
        --card: rgba(255, 255, 255, 0.92);
        --line: #d6dfeb;
        --text: #16202f;
        --muted: #556273;
        --accent: #0f766e;
        --accent-soft: #dff5f2;
        --danger-soft: #fee2e2;
        --danger: #991b1b;
        --danger-hover: #7f1d1d;
        --success-soft: #dcfce7;
        --success: #166534;
        --shadow: 0 24px 80px rgba(24, 39, 75, 0.12);
      }
      * { box-sizing: border-box; }
      html { overflow-x: hidden; }
      body {
        margin: 0;
        font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, #eafaf6 0%, transparent 32%),
          radial-gradient(circle at top right, #ecf1ff 0%, transparent 30%),
          var(--bg);
        overflow-x: hidden;
      }
      .shell {
        min-height: 100vh;
        padding: clamp(12px, 2vw, 24px);
      }
      .stack {
        width: min(1320px, 100%);
        margin: 0 auto;
        display: grid;
        gap: 20px;
      }
      .card {
        background: var(--card);
        border: 1px solid rgba(214, 223, 235, 0.88);
        backdrop-filter: blur(10px);
        border-radius: 24px;
        box-shadow: var(--shadow);
      }
      .hero {
        padding: clamp(20px, 3vw, 28px);
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 18px;
        flex-wrap: wrap;
      }
      .hero > div:first-child { flex: 1 1 420px; min-width: 0; }
      h1 { margin: 0 0 8px; font-size: clamp(28px, 4vw, 34px); line-height: 1.15; }
      h2 { margin: 0; font-size: 22px; line-height: 1.25; }
      h3 { margin: 0; font-size: 15px; font-weight: 700; line-height: 1.3; }
      p { margin: 0; color: var(--muted); line-height: 1.7; overflow-wrap: anywhere; }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-top: 16px;
        padding: 10px 14px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-weight: 700;
      }
      .hero-actions,
      .section-actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
      }
      button,
      a.button {
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 0;
        border-radius: 999px;
        padding: 10px 16px;
        min-height: 42px;
        background: var(--text);
        color: #fff;
        text-decoration: none;
        cursor: pointer;
        font-weight: 700;
        font-size: 13px;
        line-height: 1.2;
        text-align: center;
        white-space: nowrap;
        transition: transform 160ms ease, box-shadow 160ms ease, background 160ms ease, border-color 160ms ease;
      }
      button.secondary,
      a.secondary {
        background: transparent;
        color: var(--text);
        border: 1px solid var(--line);
      }
      button.danger {
        background: transparent;
        color: var(--danger);
        border: 1px solid var(--danger);
      }
      button.danger:hover {
        background: var(--danger-soft);
      }
      button.small { padding: 6px 12px; min-height: 32px; font-size: 12px; }
      button:not(:disabled):hover,
      a.button:hover {
        box-shadow: 0 10px 22px rgba(22, 32, 47, 0.14);
        transform: translateY(-1px);
      }
      button.secondary:not(:disabled):hover,
      a.secondary:hover {
        background: #ffffff;
        border-color: #aebdcd;
      }
      .grid {
        display: grid;
        grid-template-columns: minmax(0, 1.05fr) minmax(0, 1.15fr);
        gap: 20px;
      }
      .section {
        padding: clamp(18px, 2.4vw, 24px);
        display: grid;
        gap: 18px;
        min-width: 0;
      }
      .section-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
        flex-wrap: wrap;
      }
      .section-head > div:first-child { flex: 1 1 300px; min-width: 0; }
      /* Bot 卡片 */
      .bot-cards {
        display: grid;
        gap: 12px;
      }
      .bot-card {
        padding: 18px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: linear-gradient(180deg, #ffffff 0%, #f8fbff 100%);
        transition: border-color 160ms ease, box-shadow 160ms ease;
      }
      .bot-card:hover {
        border-color: #aebdcd;
        box-shadow: 0 8px 20px rgba(24, 39, 75, 0.06);
      }
      .bot-card-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
        margin-bottom: 12px;
      }
      .bot-card-header > div { min-width: 0; }
      .bot-label { font-size: 13px; color: var(--muted); }
      .label-text {
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 6px;
        border: 1px solid transparent;
        transition: border-color 160ms ease, background 160ms ease;
        display: inline-block;
        max-width: 100%;
        word-break: break-all;
      }
      .label-text:hover { background: #f1f5f9; border-color: #cbd5e1; }
      .edit-icon {
        display: inline-block;
        font-size: 12px;
        color: #94a3b8;
        cursor: pointer;
        margin-left: 4px;
        vertical-align: middle;
        transition: color 160ms ease;
        user-select: none;
      }
      .edit-icon:hover { color: var(--accent); }
      .label-input {
        font: inherit;
        font-size: 13px;
        padding: 2px 6px;
        border: 1px solid var(--accent);
        border-radius: 6px;
        outline: none;
        width: 100%;
        box-sizing: border-box;
      }
      .bot-card-body {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 12px;
        align-items: end;
      }
      .bot-meta {
        display: grid;
        gap: 6px;
        font-size: 13px;
        color: var(--muted);
      }
      .bot-meta code { font-size: 12px; }
      .bot-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .status-dot {
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        margin-right: 6px;
        vertical-align: middle;
      }
      .status-dot.ready { background: #22c55e; }
      .status-dot.logged_in,
      .status-dot.needs_activation { background: #f59e0b; }
      .status-dot.needs_login,
      .status-dot.error { background: #ef4444; }
      .form-grid { display: grid; gap: 14px; }
      label {
        display: grid;
        gap: 8px;
        font-size: 13px;
        color: var(--muted);
        font-weight: 700;
      }
      .hint {
        font-weight: 400;
        font-size: 11px;
        color: var(--muted);
        line-height: 1.5;
      }
      input,
      textarea,
      select {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 12px 14px;
        background: #fff;
        color: var(--text);
        font: inherit;
        min-width: 0;
      }
      textarea { min-height: 120px; resize: vertical; }
      .form-note { font-size: 13px; color: var(--muted); }
      .message-box {
        padding: 14px 16px;
        border-radius: 16px;
        background: #f8fafc;
        border: 1px solid var(--line);
        color: var(--muted);
        overflow-wrap: anywhere;
      }
      .message-box.success {
        background: var(--success-soft);
        color: var(--success);
        border-color: #bbf7d0;
      }
      .message-box.error {
        background: var(--danger-soft);
        color: var(--danger);
        border-color: #fecaca;
      }
      .table-wrap {
        width: 100%;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
      }
      table {
        width: 100%;
        min-width: 800px;
        border-collapse: collapse;
      }
      th,
      td {
        padding: 12px 9px;
        text-align: left;
        border-bottom: 1px solid #edf1f7;
        vertical-align: top;
        font-size: 13px;
      }
      th { color: var(--muted); font-weight: 700; white-space: nowrap; }
      td { overflow-wrap: anywhere; }
      tbody tr { transition: background 160ms ease; }
      tbody tr:hover { background: #f8fafc; }
      .badge {
        display: inline-flex;
        padding: 5px 9px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 800;
      }
      .badge.queued { background: #e0f2fe; color: #075985; }
      .badge.retrying { background: #fef3c7; color: #92400e; }
      .badge.delivered { background: #dcfce7; color: #166534; }
      .badge.failed { background: #fee2e2; color: #991b1b; }
      .tiny { font-size: 12px; color: var(--muted); }
      code {
        font-family: Consolas, "SFMono-Regular", monospace;
        background: #f4f7fb;
        border-radius: 8px;
        padding: 2px 6px;
        font-size: 12px;
      }
      button:disabled { cursor: not-allowed; opacity: 0.58; }
      button:focus-visible,
      a.button:focus-visible,
      input:focus-visible,
      textarea:focus-visible,
      select:focus-visible {
        outline: 3px solid rgba(15, 118, 110, 0.28);
        outline-offset: 2px;
      }
      .empty-state {
        padding: 32px 18px;
        text-align: center;
        color: var(--muted);
      }
      .empty-state strong { display: block; margin-bottom: 8px; font-size: 16px; color: var(--text); }
      @media (max-width: 1100px) { .grid { grid-template-columns: 1fr; } }
      @media (max-width: 720px) {
        .stack { gap: 14px; }
        .card { border-radius: 20px; }
        .hero { gap: 16px; }
        .hero-actions,
        .section-actions { width: 100%; }
        .hero-actions > *,
        .section-actions > * { flex: 1 1 100%; }
        .bot-card-body { grid-template-columns: 1fr; }
      }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { transition: none !important; }
        button:not(:disabled):hover,
        a.button:hover { transform: none; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <div class="stack">
        <section class="card hero">
          <div>
            <h1>iLink 管理总览</h1>
            <p>管理所有 Bot、发送测试消息、查看投递日志。</p>
            <div class="pill" id="hero-pill" aria-live="polite">正在加载...</div>
          </div>
          <div class="hero-actions">
            <button id="refresh-all-btn">刷新总览</button>
            <a class="button secondary" href="/admin/bot/login/qrcode/page?token=${escapedToken}">添加 Bot（扫码）</a>
            <a class="button secondary" href="/admin/deliveries/page?token=${escapedToken}">日志中心</a>
          </div>
        </section>

        <section class="grid">
          <!-- ========== Bot 卡片列表 ========== -->
          <section class="card section">
            <div class="section-head">
              <div>
                <h2>Bot 列表</h2>
                <p>所有已登录 Bot，可逐个激活或删除。</p>
              </div>
              <div class="section-actions">
                <button class="secondary" id="refresh-bots-btn">刷新列表</button>
              </div>
            </div>
            <div class="bot-cards" id="bot-cards" aria-live="polite">
              <div class="empty-state"><strong>暂无 Bot</strong><p>请点击"添加 Bot（扫码）"完成登录。</p></div>
            </div>
            <div class="form-note">
              扫码登录后 Bot 状态为 <code>needs_activation</code>，请先给微信 ClawBot 发一条消息，再点击对应 Bot 的「激活」按钮。
            </div>
          </section>

          <!-- ========== 手动发送测试 ========== -->
          <section class="card section">
            <div class="section-head">
              <div>
                <h2>手动发送测试</h2>
                <p>选择目标 Bot 并发送测试通知，走完整队列链路。</p>
              </div>
            </div>
            <div class="form-grid">
              <label>
                目标 Bot
                <select id="send-bot-select">
                  <option value="">请选择 Bot</option>
                </select>
              </label>
              <label>
                文本内容
                <textarea id="send-text" placeholder="输入一条测试消息，例如：Cloudflare deploy succeeded."></textarea>
              </label>
              <label>
                幂等键 dedupeKey（可选）
                <input id="send-dedupe" placeholder="例如 deploy-20260326-1" />
                <span class="hint">同一 Bot + 同一 dedupeKey 的重复请求会被去重，只投递一次。留空则每次都会创建新投递，不做去重。</span>
              </label>
              <div class="section-actions">
                <button id="send-btn">发送测试消息</button>
              </div>
              <div class="message-box" id="send-message" aria-live="polite">等待发送操作。</div>
            </div>
          </section>
        </section>

        <!-- ========== 最近日志 ========== -->
        <section class="card section">
          <div class="section-head">
            <div>
              <h2>最近日志</h2>
              <p>最近 ${input.logsLimit} 条投递记录，便于确认链路状态。</p>
            </div>
            <div class="section-actions">
              <button class="secondary" id="refresh-logs-btn">刷新日志</button>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>Bot</th>
                  <th>状态</th>
                  <th>来源</th>
                  <th>消息预览</th>
                  <th>尝试</th>
                  <th>响应</th>
                </tr>
              </thead>
              <tbody id="recent-log-body" aria-live="polite">
                <tr><td colspan="7" class="tiny">正在加载日志...</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>

    <script>
      const adminToken = ${JSON.stringify(input.adminToken)};
      const refreshSeconds = ${JSON.stringify(input.refreshSeconds)};
      const logsLimit = ${JSON.stringify(input.logsLimit)};

      const heroPill = document.getElementById("hero-pill");
      const botCards = document.getElementById("bot-cards");
      const sendBotSelect = document.getElementById("send-bot-select");
      const sendText = document.getElementById("send-text");
      const sendDedupe = document.getElementById("send-dedupe");
      const sendMessage = document.getElementById("send-message");
      const recentLogBody = document.getElementById("recent-log-body");
      const sendBtn = document.getElementById("send-btn");

      const escapeHtml = (value) =>
        value
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");

      // ----- 缓存 Bot 列表 -----
      let cachedBots = [];

      const setHeroPill = (text, tone) => {
        heroPill.textContent = text;
        heroPill.style.background = tone === "error" ? "#fee2e2" : tone === "success" ? "#dcfce7" : "#dff5f2";
        heroPill.style.color = tone === "error" ? "#991b1b" : tone === "success" ? "#166534" : "#0f766e";
      };

      const statusLabel = (status) => {
        const map = {
          ready: "已就绪",
          logged_in: "已登录",
          needs_activation: "待激活",
          needs_login: "需重登",
          error: "异常"
        };
        return map[status] || status;
      };

      const statusDotClass = (status) => {
        const map = {
          ready: "ready",
          logged_in: "logged_in",
          needs_activation: "needs_activation",
          needs_login: "needs_login",
          error: "error"
        };
        return map[status] || "error";
      };

      const formatTime = (iso) => {
        if (!iso) return "-";
        const d = new Date(iso);
        const pad = (n) => String(n).padStart(2, "0");
        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
          + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
      };

      const badgeClass = (status) => {
        if (["queued", "retrying", "delivered", "failed"].includes(status)) return status;
        return "queued";
      };

      // ----- Bot 列表渲染 -----
      const loadBots = async () => {
        setHeroPill("正在刷新...", "info");
        try {
          const response = await fetch("/admin/bots?token=" + encodeURIComponent(adminToken));
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.message || "无法读取 Bot 列表");
          cachedBots = payload.data || [];

          if (!cachedBots.length) {
            botCards.innerHTML = '<div class="empty-state"><strong>暂无 Bot</strong><p>请点击"添加 Bot（扫码）"完成登录。</p></div>';
            setHeroPill("0 个 Bot", "info");
          } else {
            botCards.innerHTML = cachedBots
              .map((bot) => {
                const showActivate = bot.status === "logged_in" || bot.status === "needs_activation";
                return '<div class="bot-card">'
                  + '<div class="bot-card-header">'
                  + '<div>'
                  + '<h3><span class="status-dot ' + statusDotClass(bot.status) + '"></span>' + escapeHtml(statusLabel(bot.status)) + '</h3>'
                  + '<div class="bot-label"><span class="label-text" data-bot-id="' + escapeHtml(bot.botId) + '" title="点击编辑">' + (bot.label ? escapeHtml(bot.label) : '<em>未命名</em>') + '</span><span class="edit-icon" data-bot-id="' + escapeHtml(bot.botId) + '" title="编辑名称">✎</span></div>'
                  + '</div>'
                  + '</div>'
                  + '<div class="bot-card-body">'
                  + '<div class="bot-meta">'
                  + '<div><code>' + escapeHtml(bot.botId) + '</code></div>'
                  + '<div>更新于 ' + formatTime(bot.updatedAt) + '</div>'
                  + (bot.lastError ? '<div style="color:#991b1b">错误: ' + escapeHtml(bot.lastError) + '</div>' : '')
                  + '</div>'
                  + '<div class="bot-actions">'
                  + (showActivate
                    ? '<button class="small activate-bot-btn" data-bot-id="' + escapeHtml(bot.botId) + '">激活</button>'
                    : '<button class="small secondary" disabled>激活</button>')
                  + (bot.status === "ready"
                    ? '<button class="small copy-template-btn" data-bot-id="' + escapeHtml(bot.botId) + '">复制请求</button>'
                    : '')
                  + '<button class="small danger delete-bot-btn" data-bot-id="' + escapeHtml(bot.botId) + '">删除</button>'
                  + '</div>'
                  + '</div>'
                  + '</div>';
              })
              .join("");

            // 绑定激活按钮
            botCards.querySelectorAll(".activate-bot-btn").forEach((btn) => {
              btn.addEventListener("click", () => activateSpecificBot(btn.dataset.botId));
            });

            // 绑定删除按钮
            botCards.querySelectorAll(".delete-bot-btn").forEach((btn) => {
              btn.addEventListener("click", () => deleteBot(btn.dataset.botId));
            });

            // 绑定复制请求模版按钮
            botCards.querySelectorAll(".copy-template-btn").forEach((btn) => {
              btn.addEventListener("click", () => copyCurlTemplate(btn.dataset.botId));
            });

            // 绑定 label 行内编辑
            botCards.querySelectorAll(".label-text").forEach((span) => {
              span.addEventListener("click", () => editLabel(span));
            });
            botCards.querySelectorAll(".edit-icon").forEach((icon) => {
              icon.addEventListener("click", () => {
                const span = icon.closest(".bot-label").querySelector(".label-text");
                if (span) editLabel(span);
              });
            });

            const readyCount = cachedBots.filter((b) => b.status === "ready").length;
            setHeroPill(cachedBots.length + " 个 Bot，" + readyCount + " 个已就绪", readyCount > 0 ? "success" : "info");
          }

          // 刷新发送测试的 Bot 下拉框
          const prevSelected = sendBotSelect.value;
          sendBotSelect.innerHTML = '<option value="">请选择 Bot</option>'
            + cachedBots
              .map((b) => '<option value="' + escapeHtml(b.botId) + '"'
                + (b.status === "ready" ? "" : ' class="not-ready"')
                + '>'
                + escapeHtml(b.label || b.botId)
                + (b.status !== "ready" ? " [" + statusLabel(b.status) + "]" : "")
                + '</option>')
              .join("");
          // 恢复之前的选中项
          if (prevSelected && cachedBots.some((b) => b.botId === prevSelected)) {
            sendBotSelect.value = prevSelected;
          }
        } catch (error) {
          setHeroPill("Bot 列表加载失败", "error");
          botCards.innerHTML = '<div class="empty-state"><strong>加载失败</strong><p>'
            + escapeHtml(error instanceof Error ? error.message : "网络请求失败") + '</p></div>';
        }
      };

      // ----- 激活指定 Bot -----
      const activateSpecificBot = async (botId) => {
        if (!botId) {
          alert("botId 缺失，无法激活。请先扫码登录。");
          return;
        }
        const btn = botCards.querySelector('.activate-bot-btn[data-bot-id="' + CSS.escape(botId) + '"]');
        if (btn) {
          btn.disabled = true;
          btn.textContent = "激活中...";
        }
        try {
          const response = await fetch("/admin/bot/" + encodeURIComponent(botId) + "/activate?token=" + encodeURIComponent(adminToken), {
            method: "POST"
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.message || "未知错误");
        } catch (error) {
          // 静默处理，刷新列表后会显示最新状态
        } finally {
          await loadBots();
        }
      };

      // ----- 复制请求模版 -----
      const copyCurlTemplate = async (botId) => {
        const origin = window.location.origin;
        const template = [
          "curl -X POST " + origin + "/webhook/" + botId + "/your-source \\\\",
          '  -H "Content-Type: application/json" \\\\',
          '  -H "X-Webhook-Token: ${escapedWebhookToken}" \\\\',
          \`  -d '{"text": "Hello World"}'\`,
        ].join("\\n");

        try {
          await navigator.clipboard.writeText(template);
        } catch {
          // 降级方案
          const ta = document.createElement("textarea");
          ta.value = template;
          ta.style.position = "fixed";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }

        const btn = botCards.querySelector('.copy-template-btn[data-bot-id="' + CSS.escape(botId) + '"]');
        if (btn) {
          const original = btn.textContent;
          btn.textContent = "已复制!";
          btn.style.background = "#22c55e";
          setTimeout(() => {
            btn.textContent = original;
            btn.style.background = "";
          }, 1500);
        }
      };

      // ----- 删除指定 Bot -----
      const deleteBot = async (botId) => {
        const label = (cachedBots.find((b) => b.botId === botId) || {}).label || botId;
        if (!confirm("确定要删除 Bot「" + label + "」吗？此操作不可撤销。")) return;

        const btns = botCards.querySelectorAll('.delete-bot-btn[data-bot-id="' + CSS.escape(botId) + '"]');
        btns.forEach((b) => { b.disabled = true; b.textContent = "删除中..."; });

        try {
          const response = await fetch("/admin/bot/" + encodeURIComponent(botId) + "?token=" + encodeURIComponent(adminToken), {
            method: "DELETE"
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.message || "未知错误");
        } catch (error) {
          alert("删除失败: " + (error instanceof Error ? error.message : "网络请求失败"));
        } finally {
          await loadBots();
        }
      };

      // ----- label 行内编辑 -----
      let isEditingLabel = false;
      const editLabel = (span) => {
        if (span.querySelector("input")) return; // 已在编辑中
        isEditingLabel = true;
        const botId = span.dataset.botId;
        const originalLabel = span.textContent;
        const input = document.createElement("input");
        input.type = "text";
        input.className = "label-input";
        input.value = originalLabel === "未命名" ? "" : originalLabel;
        input.placeholder = "输入名称...";

        const finishEdit = async (save) => {
          if (save && input.value.trim() && input.value.trim() !== originalLabel) {
            try {
              await fetch("/admin/bot/" + encodeURIComponent(botId) + "?token=" + encodeURIComponent(adminToken), {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ label: input.value.trim() })
              });
            } catch (err) {
              // 静默处理，刷新后恢复
            }
          }
          isEditingLabel = false;
          await loadBots();
        };

        input.addEventListener("blur", () => finishEdit(true));
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { input.blur(); }
          if (e.key === "Escape") { input.value = originalLabel === "未命名" ? "" : originalLabel; finishEdit(false); }
        });

        span.replaceChildren(input);
        input.focus();
        input.select();
      };

      // ----- 日志加载 -----
      const loadRecentLogs = async () => {
        try {
          const response = await fetch(
            "/admin/deliveries?token=" + encodeURIComponent(adminToken) + "&limit=" + encodeURIComponent(String(logsLimit))
          );
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.message || "未知错误");
          const items = payload.data.items || [];
          if (!items.length) {
            recentLogBody.innerHTML = '<tr><td colspan="7" class="tiny">暂无日志。</td></tr>';
            return;
          }
          recentLogBody.innerHTML = items
            .map((item) => {
              const preview = item.text.length > 80 ? item.text.slice(0, 80) + "..." : item.text;
              return '<tr>'
                + '<td><div>' + formatTime(item.createdAt) + '</div><div class="tiny"><code>' + escapeHtml(item.deliveryId) + '</code></div></td>'
                + '<td><code>' + escapeHtml(item.botId || "-") + '</code></td>'
                + '<td><span class="badge ' + badgeClass(item.status) + '">' + escapeHtml(item.status) + '</span></td>'
                + '<td>' + escapeHtml(item.source) + '</td>'
                + '<td>' + escapeHtml(preview) + '</td>'
                + '<td>' + escapeHtml(String(item.attempts)) + '</td>'
                + '<td>' + escapeHtml(String(item.responseCode ?? "-")) + '</td>'
                + '</tr>';
            })
            .join("");
        } catch (error) {
          recentLogBody.innerHTML = '<tr><td colspan="7" class="tiny">日志读取失败：'
            + escapeHtml(error instanceof Error ? error.message : "网络请求失败") + '</td></tr>';
        }
      };

      // ----- 发送测试消息 -----
      const sendTestMessage = async () => {
        const text = sendText.value.trim();
        if (!text) {
          sendMessage.className = "message-box error";
          sendMessage.textContent = "请先输入要发送的文本内容。";
          return;
        }

        sendBtn.disabled = true;
        sendBtn.textContent = "提交中...";
        sendMessage.className = "message-box";
        sendMessage.textContent = "正在提交发送请求...";

        const body = { text };
        body.dedupeKey = sendDedupe.value.trim() || undefined;
        if (sendBotSelect.value) {
          body.botId = sendBotSelect.value;
        }

        try {
          const response = await fetch("/api/send", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + adminToken
            },
            body: JSON.stringify(body)
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.message || "未知错误");
          sendMessage.className = "message-box success";
          sendMessage.textContent = "已入队: deliveryId=" + payload.data.deliveryId + ", botId=" + payload.data.botId + ", 状态=" + payload.data.status;
          sendText.value = "";
          await loadRecentLogs();
        } catch (error) {
          sendMessage.className = "message-box error";
          sendMessage.textContent = "发送失败：" + (error instanceof Error ? error.message : "网络请求失败");
        } finally {
          sendBtn.disabled = false;
          sendBtn.textContent = "发送测试消息";
        }
      };

      // ----- 事件绑定 -----
      document.getElementById("refresh-all-btn").addEventListener("click", async () => {
        await Promise.all([loadBots(), loadRecentLogs()]);
      });
      document.getElementById("refresh-bots-btn").addEventListener("click", loadBots);
      document.getElementById("refresh-logs-btn").addEventListener("click", loadRecentLogs);
      sendBtn.addEventListener("click", sendTestMessage);

      // ----- 自动刷新 -----
      const scheduleRefresh = () => window.setTimeout(async () => {
        if (!isEditingLabel) {
          await Promise.all([loadBots(), loadRecentLogs()]);
        }
        scheduleRefresh();
      }, refreshSeconds * 1000);

      loadBots();
      loadRecentLogs();
      if (refreshSeconds > 0) scheduleRefresh();
    </script>
  </body>
</html>`;
};
