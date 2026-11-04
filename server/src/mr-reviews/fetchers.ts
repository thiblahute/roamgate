import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { MrItem } from "../../../shared/mrReviews";
import { ghHostLogin } from "../review/forge";
import { type GlabContext, glab, glabHostAccess } from "../review/gitlab";
import { forgeGate } from "../workspace/forge-calls";

/**
 * How the inbox asks the forges, on the bridge's machine with the user's
 * own glab and gh logins: every call through the forge gate (its per-host
 * budget, queue and rate-limit pauses), feature `inbox`. Reads only.
 */

export type InboxFetchers = {
  /** Throws a NotSignedIn error when the host has no login here. */
  gitlab(host: string, query: string): Promise<unknown>;
  github(host: string, query: string): Promise<unknown>;
  /** The user's pending draft notes on a GitLab merge request. */
  gitlabDrafts(item: MrItem): Promise<number>;
};

export class NotSignedInError extends Error {}
export class ForgeToolMissingError extends Error {}

const TIMEOUT_MS = 30_000;

type Run = GlabContext["runProcessWithCodeTimeout"];

export function createInboxFetchers(run: Run): InboxFetchers {
  const context: GlabContext = {
    root: homedir(),
    shQuote: (value) => `'${value.replaceAll("'", "'\\''")}'`,
    runProcessWithCodeTimeout: run,
  };
  const access = async (host: string) => {
    try {
      return await glabHostAccess(context, host);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not installed/i.test(message))
        throw new ForgeToolMissingError("glab is not installed");
      if (/no login/i.test(message))
        throw new NotSignedInError(
          `Not signed in to ${host} (glab auth login --hostname ${host})`,
        );
      throw error;
    }
  };
  return {
    async gitlab(host, query) {
      const login = await access(host);
      return glab(
        context,
        { host, ...login },
        "POST",
        "graphql",
        [["query", query, "raw"]],
        false,
        { feature: "inbox", kind: "inbox" },
      );
    },
    async github(host, query) {
      const code = await ghHostLogin(context, host).catch(() => -1);
      if (code === 127) throw new ForgeToolMissingError("gh is not installed");
      if (code !== 0)
        throw new NotSignedInError(
          `Not signed in to ${host} (gh auth login --hostname ${host})`,
        );
      const argv = [
        "gh",
        "api",
        ...(host === "github.com" ? [] : ["--hostname", host]),
        "graphql",
        "-f",
        `query=${query}`,
      ];
      const output = await forgeGate.run(
        run,
        { host, feature: "inbox", kind: "inbox" },
        argv,
        async (full) => {
          try {
            return await run(full, TIMEOUT_MS, {
              cwd: existsSync(context.root) ? context.root : undefined,
              env: {
                ...process.env,
                GH_PROMPT_DISABLED: "1",
                GIT_TERMINAL_PROMPT: "0",
                NO_COLOR: "1",
              },
            });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              return { code: 127, stdout: "", stderr: "" };
            throw error;
          }
        },
      );
      if (output.code === 127)
        throw new ForgeToolMissingError("gh is not installed");
      // A GraphQL answer with errors (a followed repository gone) still
      // has its data: gh exits 1 but prints it.
      const body = output.stdout.trim();
      if (body.startsWith("{")) {
        try {
          return JSON.parse(body);
        } catch {}
      }
      throw new Error(
        `GitHub: ${(output.stderr || "the request failed").trim().slice(0, 300)}`,
      );
    },
    async gitlabDrafts(item) {
      const login = await access(item.host);
      const answer = await glab(
        context,
        { host: item.host, ...login },
        "GET",
        `projects/${encodeURIComponent(item.project)}/merge_requests/${item.number}/draft_notes?per_page=100`,
        [],
        false,
        { feature: "inbox", kind: "drafts" },
      );
      return Array.isArray(answer) ? answer.length : 0;
    },
  };
}
