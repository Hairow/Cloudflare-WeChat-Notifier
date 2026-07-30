import template from "../assets/delivery-log-page.html";

const escapeHtml = (input: string): string =>
  input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const renderDeliveryLogPage = (input: {
  adminToken: string;
  initialStatus?: string;
  initialSource?: string;
  initialLimit: number;
  initialPage: number;
  initialRefreshSeconds: number;
}): string => {
  return template
    .replaceAll('"{{ADMIN_TOKEN_JSON}}"', JSON.stringify(input.adminToken))
    .replaceAll("{{ADMIN_TOKEN}}", escapeHtml(input.adminToken))
    .replaceAll('"{{INITIAL_STATUS_JSON}}"', JSON.stringify(input.initialStatus ?? ""))
    .replaceAll('"{{INITIAL_SOURCE_JSON}}"', JSON.stringify(input.initialSource ?? ""))
    .replaceAll('"{{INITIAL_LIMIT_JSON}}"', JSON.stringify(String(input.initialLimit)))
    .replaceAll('"{{INITIAL_PAGE_JSON}}"', JSON.stringify(String(input.initialPage)))
    .replaceAll('"{{INITIAL_REFRESH_SECONDS_JSON}}"', JSON.stringify(String(input.initialRefreshSeconds)))
    .replaceAll("{{SOURCE}}", escapeHtml(input.initialSource ?? ""));
};
