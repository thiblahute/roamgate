import { readJsonBody } from "./json-body";

/** Where the Android app redeems a call's handoff token. */
export const CALL_HANDOFF_PATH = "/api/voice/call/handoff";
/** Failed redeems one address may make in FAILURE_WINDOW_MS. */
export const HANDOFF_MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 10 * 60_000;
const MAX_BODY_BYTES = 1024;
const MAX_ADDRESSES = 4096;

/**
 * POST /api/voice/call/handoff, before the login gate: the Android app
 * gives the single-use token the page got from `call_handoff`
 * (voice-socket.ts) and gets the call's number and carrier token, and a
 * login cookie (it is the user's phone, sent there by their logged-in
 * page). The token is the credential: unknown, used or expired answers
 * 410; HANDOFF_MAX_FAILURES failures from one address answer 429 for a
 * while.
 */
export function createCallHandoffRedeem(args: {
  redeem: (token: unknown) => { call: number; carrier: string } | null;
  /** A new login's Set-Cookie value; null when no login is required. */
  sessionCookie: () => string | null;
  now?: () => number;
}) {
  const now = args.now ?? Date.now;
  const failures = new Map<string, { count: number; until: number }>();

  const failed = (ip: string) => {
    const at = now();
    const entry = failures.get(ip);
    if (!entry || entry.until <= at) {
      if (failures.size >= MAX_ADDRESSES) {
        for (const [key, value] of failures)
          if (value.until <= at) failures.delete(key);
        if (failures.size >= MAX_ADDRESSES) failures.clear();
      }
      failures.set(ip, { count: 1, until: at + FAILURE_WINDOW_MS });
    } else entry.count += 1;
  };

  return async function redeemHandoff(
    req: Request,
    ip: string,
  ): Promise<Response> {
    const headers = { "cache-control": "no-store" };
    if (req.method !== "POST")
      return new Response("method not allowed", {
        status: 405,
        headers: { allow: "POST", ...headers },
      });
    // The app sends no fetch metadata; a page of another site never redeems.
    if (req.headers.get("sec-fetch-site") === "cross-site")
      return new Response("forbidden", { status: 403, headers });
    const limited = failures.get(ip);
    if (
      limited &&
      limited.until > now() &&
      limited.count >= HANDOFF_MAX_FAILURES
    )
      return new Response("too many attempts", {
        status: 429,
        headers: {
          "retry-after": String(Math.ceil((limited.until - now()) / 1000)),
          ...headers,
        },
      });
    let body: unknown;
    try {
      body = await readJsonBody(req, MAX_BODY_BYTES);
    } catch {
      failed(ip);
      return new Response("bad request", { status: 400, headers });
    }
    const token =
      body && typeof body === "object"
        ? (body as { handoff?: unknown }).handoff
        : undefined;
    const taken = args.redeem(token);
    if (!taken) {
      failed(ip);
      return Response.json(
        { error: "This call handoff is unknown, used or expired" },
        { status: 410, headers },
      );
    }
    const cookie = args.sessionCookie();
    return Response.json(taken, {
      headers: { ...headers, ...(cookie ? { "set-cookie": cookie } : {}) },
    });
  };
}
