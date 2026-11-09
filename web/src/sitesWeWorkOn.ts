import {
  normalizeSiteList,
  normalizeSiteRoots,
} from "../../shared/renderedPage";

/**
 * The sites and directories the user works on (instance settings): a
 * rendered review's pages from there run their scripts, still sandboxed
 * away from Roamgate.
 */
async function request(
  method: "GET" | "PUT",
  body?: {
    rendered_sites?: string[];
    rendered_site_roots?: Record<string, string>;
  },
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch("/api/instance-settings", {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
      ...(method === "PUT"
        ? {
            headers: {
              "Content-Type": "application/json",
              "X-Roamgate-Settings": "1",
            },
            body: JSON.stringify(body),
          }
        : {}),
    });
    if (!response.ok) {
      let message = `Unable to ${method === "GET" ? "load" : "save"} the sites (HTTP ${response.status}).`;
      try {
        const body: unknown = await response.json();
        if (
          body &&
          typeof body === "object" &&
          "error" in body &&
          typeof body.error === "string"
        )
          message = body.error;
      } catch {
        // A proxy or expired login may answer with an HTML page.
      }
      throw new Error(message);
    }
    const settings = (await response.json()) as {
      rendered_sites?: unknown;
      rendered_site_roots?: unknown;
    };
    const sites = normalizeSiteList(settings.rendered_sites);
    return {
      sites,
      roots: normalizeSiteRoots(settings.rendered_site_roots, sites),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadSitesWeWorkOn(): Promise<string[]> {
  return (await request("GET")).sites;
}

export async function saveSitesWeWorkOn(sites: string[]): Promise<string[]> {
  return (await request("PUT", { rendered_sites: normalizeSiteList(sites) }))
    .sites;
}

/**
 * Where listed sites' root-absolute links start, when set: a directory or
 * site containing the entry, keyed by it.
 */
export async function loadSiteRoots(): Promise<Record<string, string>> {
  return (await request("GET")).roots;
}

export async function saveSiteRoots(
  roots: Record<string, string>,
): Promise<Record<string, string>> {
  return (await request("PUT", { rendered_site_roots: roots })).roots;
}
