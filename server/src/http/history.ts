import type { HistoryStatus } from "../../../shared/history";
import { readJsonBody } from "./json-body";

/**
 * Local history (server/src/history), for Settings' "History and backup":
 *
 *   GET  /api/history         its status
 *   PUT  /api/history         {location?: string | null, enabled?: boolean}:
 *                             where the repo is (null: the default) and
 *                             whether it is written
 *   POST /api/history/commit  a pass now, every area
 *
 * Writes need the settings header and JSON, as the instance settings do,
 * so a cross-origin page cannot make them.
 */

export type HistoryRouteDeps = {
  status(): Promise<HistoryStatus>;
  configure(change: {
    location?: string | null;
    enabled?: boolean;
  }): Promise<void>;
  commit(): Promise<unknown>;
};

const headers = { "cache-control": "no-store" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers });
}

function trusted(req: Request): boolean {
  return (
    req.headers.get("x-roamgate-settings") === "1" &&
    req.headers.get("sec-fetch-site") !== "cross-site" &&
    req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ===
      "application/json"
  );
}

export function createHistoryRoute(deps: HistoryRouteDeps) {
  return async (req: Request, pathname: string): Promise<Response | null> => {
    if (pathname !== "/api/history" && pathname !== "/api/history/commit")
      return null;
    if (pathname === "/api/history" && req.method === "GET")
      return json(await deps.status());
    const method = pathname === "/api/history" ? "PUT" : "POST";
    if (req.method !== method)
      return json({ error: "method not allowed" }, 405);
    if (!trusted(req)) return json({ error: "Forbidden" }, 403);
    let body: unknown;
    try {
      body = await readJsonBody(req, 8192);
    } catch {
      return json({ error: "Invalid history request" }, 400);
    }
    if (pathname === "/api/history/commit") {
      await deps.commit();
      return json(await deps.status());
    }
    const fields =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const change: { location?: string | null; enabled?: boolean } = {};
    if (fields.location !== undefined) {
      if (fields.location !== null && typeof fields.location !== "string")
        return json({ error: "location is a path or null" }, 400);
      change.location =
        typeof fields.location === "string" && fields.location.trim()
          ? fields.location
          : null;
    }
    if (fields.enabled !== undefined) {
      if (typeof fields.enabled !== "boolean")
        return json({ error: "enabled is true or false" }, 400);
      change.enabled = fields.enabled;
    }
    try {
      await deps.configure(change);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
    return json(await deps.status());
  };
}
