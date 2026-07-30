import template from "../assets/dashboard-page.html";

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
  return template
    .replaceAll('"{{ADMIN_TOKEN_JSON}}"', JSON.stringify(input.adminToken))
    .replaceAll("{{ADMIN_TOKEN}}", escapeHtml(input.adminToken))
    .replaceAll("{{WEBHOOK_TOKEN}}", escapeHtml(input.webhookToken))
    .replaceAll('"{{REFRESH_SECONDS_JSON}}"', JSON.stringify(input.refreshSeconds))
    .replaceAll('"{{LOGS_LIMIT_JSON}}"', JSON.stringify(input.logsLimit))
    .replaceAll("{{LOGS_LIMIT}}", String(input.logsLimit));
};
