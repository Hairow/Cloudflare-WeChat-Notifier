import template from "../assets/qrcode-page.html";

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
  return template
    .replaceAll("{{SVG_MARKUP}}", input.svgMarkup)
    .replaceAll('"{{ADMIN_TOKEN_JSON}}"', JSON.stringify(input.adminToken))
    .replaceAll('"{{SESSION_ID_JSON}}"', JSON.stringify(input.sessionId))
    .replaceAll("{{ADMIN_TOKEN}}", escapeHtml(input.adminToken))
    .replaceAll("{{SESSION_ID}}", escapeHtml(input.sessionId))
    .replaceAll("{{EXPIRES_AT}}", escapeHtml(input.expiresAt));
};
