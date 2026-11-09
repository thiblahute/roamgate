import { normalizeTitleSuffix } from "../../../shared/instanceName";
import {
  normalizeSiteList,
  normalizeSiteRoots,
} from "../../../shared/renderedPage";
import { readGuiSettings, updateGuiSettings } from "../config/gui-settings";
import { serverLogger } from "../utils/logger";
import { readJsonBody } from "./json-body";

const headers = { "cache-control": "no-store" };

// Called only after the server's normal authentication gate. This setting is
// instance-wide, so it must not depend on a selected or connected Herdr server.
export async function handleInstanceSettings(req: Request): Promise<Response> {
  if (req.method === "GET") {
    const settings = await readGuiSettings();
    return Response.json(instanceSettingsOf(settings), { headers });
  }
  if (req.method !== "PUT") {
    return new Response("method not allowed", {
      status: 405,
      headers: { ...headers, allow: "GET, PUT" },
    });
  }
  // As with push settings, the custom header + JSON prevent a cross-origin
  // browser write without a CORS grant. Do not trust proxy Host/Origin rewriting.
  if (
    req.headers.get("x-roamgate-settings") !== "1" ||
    req.headers.get("sec-fetch-site") === "cross-site" ||
    req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
      "application/json"
  ) {
    return Response.json({ error: "Forbidden" }, { status: 403, headers });
  }
  let input: unknown;
  try {
    input = await readJsonBody(req, 4096);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof RangeError
            ? "Request body too large"
            : "Invalid settings request",
      },
      { status: error instanceof RangeError ? 413 : 400, headers },
    );
  }
  const fields =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as {
          title_suffix?: unknown;
          rendered_sites?: unknown;
          rendered_site_roots?: unknown;
        })
      : {};
  let suffix: string | undefined;
  let sites: string[] | undefined;
  let roots: unknown;
  try {
    // Either field may come alone; without either, the title is cleared
    // (as before the sites list existed).
    if (
      fields.title_suffix !== undefined ||
      (fields.rendered_sites === undefined &&
        fields.rendered_site_roots === undefined)
    )
      suffix = normalizeTitleSuffix(fields.title_suffix);
    if (fields.rendered_site_roots !== undefined) {
      const value = fields.rendered_site_roots;
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("rendered_site_roots must map sites to roots");
      for (const [site, root] of Object.entries(value))
        if (typeof root !== "string" || !root.trim())
          throw new Error(`no root given for ${site}`);
      roots = value;
    }
    if (fields.rendered_sites !== undefined) {
      if (!Array.isArray(fields.rendered_sites))
        throw new Error("rendered_sites must be a list");
      sites = normalizeSiteList(fields.rendered_sites);
    }
  } catch (error) {
    return Response.json(
      { error: (error as Error).message },
      { status: 400, headers },
    );
  }
  try {
    const settings = await updateGuiSettings((current) => {
      const next = { ...current };
      if (suffix !== undefined) next.title_suffix = suffix;
      if (sites !== undefined) {
        if (sites.length) next.rendered_sites = sites;
        else delete next.rendered_sites;
      }
      // Kept only for listed sites, each containing its site.
      const kept = normalizeSiteRoots(
        roots ?? next.rendered_site_roots,
        next.rendered_sites ?? [],
      );
      if (Object.keys(kept).length) next.rendered_site_roots = kept;
      else delete next.rendered_site_roots;
      return next;
    });
    return Response.json(instanceSettingsOf(settings), { headers });
  } catch (error) {
    serverLogger
      .child("settings")
      .warn("unable to save instance settings", { error });
    return Response.json(
      { error: "Unable to save instance settings" },
      { status: 500, headers },
    );
  }
}

function instanceSettingsOf(settings: {
  title_suffix?: string;
  rendered_sites?: string[];
  rendered_site_roots?: Record<string, string>;
}) {
  return {
    title_suffix: settings.title_suffix ?? "",
    rendered_sites: settings.rendered_sites ?? [],
    rendered_site_roots: settings.rendered_site_roots ?? {},
  };
}
