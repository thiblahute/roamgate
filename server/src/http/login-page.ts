import { fillTemplate, LOGIN_HTML_TEMPLATE } from "../assets";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * The login page (contract/assets/html/login.html): password or PIN, the
 * token's help when `tokenCommand` says how to print it, and the script
 * that clears the terminal composer's drafts when asked.
 */
export function renderLoginPage(
  pinEnabled: boolean,
  tokenCommand?: string,
  clearDrafts = false,
): string {
  return fillTemplate(LOGIN_HTML_TEMPLATE, {
    pin: pinEnabled,
    token: !!tokenCommand,
    token_command: escapeHtml(tokenCommand ?? ""),
    clear_drafts: clearDrafts,
  });
}

export const LOGIN_HTML = renderLoginPage(false);
