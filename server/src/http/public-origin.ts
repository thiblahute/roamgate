import { isLoopbackAddress } from "../workspace/file-manager";

/**
 * The origin a client reached Roamgate on, for absolute links the server
 * hands out (the notification socket's `url`). Behind a reverse proxy on
 * this machine, such as `tailscale serve`, the request Roamgate sees is
 * plain http on the public host name: the proxy's `X-Forwarded-Proto` and
 * `X-Forwarded-Host` say what the client used. Those headers are trusted
 * only from a loopback peer; anyone else could forge them. A `*.ts.net`
 * host on the default port is HTTPS anyway: Tailscale only serves those
 * names with TLS, and Android refuses cleartext links to them.
 */
export function publicOrigin(
  url: URL,
  headers: Headers,
  peer: string | undefined,
): string {
  const trusted = !!peer && isLoopbackAddress(peer);
  const forwardedHost = trusted
    ? hostOf(headers.get("x-forwarded-host"))
    : null;
  const forwardedProto = trusted
    ? protoOf(headers.get("x-forwarded-proto"))
    : null;
  const host = forwardedHost ?? url.host;
  const protocol =
    forwardedProto ?? (isTailscaleName(host) ? "https:" : url.protocol);
  const origin = parseOrigin(`${protocol}//${host}`);
  return origin ?? url.origin;
}

function first(value: string | null): string | null {
  const head = value?.split(",")[0]?.trim();
  return head ? head : null;
}

function protoOf(value: string | null): "http:" | "https:" | null {
  const proto = first(value)?.toLowerCase();
  return proto === "https" ? "https:" : proto === "http" ? "http:" : null;
}

/** A bare `host[:port]`, nothing a URL could smuggle in after it. */
function hostOf(value: string | null): string | null {
  const host = first(value);
  if (!host || /[\s/\\?#@]/.test(host)) return null;
  try {
    return new URL(`http://${host}`).host || null;
  } catch {
    return null;
  }
}

/** A Tailscale MagicDNS name on its default port: served over HTTPS only. */
function isTailscaleName(host: string): boolean {
  try {
    const url = new URL(`http://${host}`);
    return !url.port && /\.ts\.net\.?$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function parseOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
