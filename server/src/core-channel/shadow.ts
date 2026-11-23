/**
 * Shadow reads (contract/wire/core-channel.md): a sampled share of the
 * cheap reads of a family is also asked of the side that did not answer
 * it, after the browser got its answer, and the two results are compared.
 * Paused while a game runs.
 */
import { appendFileSync, chmodSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { REAL_TIMERS, type Timers } from "./channel";
import type { ShadowSettings } from "./owners";
import { type Side, shadowDiff } from "./protocol";

export const SHADOW_FILE = "shadow.jsonl";
/** At most one shadow per method this often. */
export const SHADOW_INTERVAL_MS = 5000;
export const SHADOW_IN_FLIGHT = 2;
/** Params and results larger than this (JSON) are not shadowed. */
export const SHADOW_MAX_BYTES = 256 * 1024;
export const SHADOW_TIMEOUT_MS = 10_000;
/** GameMode is asked at most this often. */
export const GAME_MODE_TTL_MS = 30_000;
export const SHADOW_ROTATE_BYTES = 5 * 1024 * 1024;
export const SHADOW_DIFF_LIMIT = 20;

export type ShadowRequest = {
  method: string;
  family: string;
  /** The side that answered. */
  owner: Side;
  params: unknown;
  result: unknown;
  /** Asks the other side; aborted when it takes too long. */
  run: (signal: AbortSignal) => Promise<unknown>;
};

export type ShadowSamplerOptions = {
  settings: () => ShadowSettings;
  /** The runtime directory, where shadow.jsonl goes. */
  directory: string;
  gameMode: () => Promise<boolean | null>;
  warn: (message: string) => void;
  timers?: Timers;
  random?: () => number;
};

export class ShadowSampler {
  private readonly timers: Timers;
  private readonly random: () => number;
  private readonly lastAt = new Map<string, number>();
  private inFlight = 0;
  private game: { active: boolean; at: number } | null = null;

  constructor(private readonly options: ShadowSamplerOptions) {
    this.timers = options.timers ?? REAL_TIMERS;
    this.random = options.random ?? Math.random;
  }

  /**
   * Shadows `request` when it is drawn and allowed; resolves once done
   * (or skipped), never rejects.
   */
  async offer(request: ShadowRequest): Promise<"skipped" | "done"> {
    const settings = this.options.settings();
    if (!settings.enabled || settings.rate <= 0) return "skipped";
    if (this.random() >= settings.rate) return "skipped";
    const now = this.timers.now();
    const last = this.lastAt.get(request.method);
    if (last !== undefined && now - last < SHADOW_INTERVAL_MS) return "skipped";
    if (this.inFlight >= SHADOW_IN_FLIGHT) return "skipped";
    if (
      jsonBytes(request.params) > SHADOW_MAX_BYTES ||
      jsonBytes(request.result) > SHADOW_MAX_BYTES
    )
      return "skipped";
    this.lastAt.set(request.method, now);
    this.inFlight++;
    try {
      if (await this.gaming()) return "skipped";
      const controller = new AbortController();
      const timer = this.timers.setTimeout(
        () => controller.abort(),
        SHADOW_TIMEOUT_MS,
      );
      let other: unknown;
      try {
        other = await Promise.race([
          request.run(controller.signal),
          new Promise((_, reject) =>
            controller.signal.addEventListener("abort", () =>
              reject(
                new Error(
                  `no answer within ${SHADOW_TIMEOUT_MS / 1000} s, abandoned`,
                ),
              ),
            ),
          ),
        ]);
      } catch (error) {
        this.record(request, { error: (error as Error).message });
        return "done";
      } finally {
        this.timers.clearTimeout(timer);
      }
      const { diffs, truncated } = shadowDiff(
        request.result,
        other,
        SHADOW_DIFF_LIMIT,
      );
      if (diffs.length) this.record(request, { diffs, truncated });
      return "done";
    } finally {
      this.inFlight--;
    }
  }

  private async gaming(): Promise<boolean> {
    const now = this.timers.now();
    if (!this.game || now - this.game.at >= GAME_MODE_TTL_MS)
      this.game = {
        active: (await this.options.gameMode().catch(() => null)) === true,
        at: now,
      };
    return this.game.active;
  }

  private record(request: ShadowRequest, outcome: Record<string, unknown>) {
    const line = {
      at: new Date(this.timers.now()).toISOString(),
      method: request.method,
      family: request.family,
      owner: request.owner,
      ...outcome,
    };
    const summary =
      "error" in outcome
        ? `failed: ${String(outcome.error)}`
        : `${(outcome.diffs as unknown[]).length}${outcome.truncated ? "+" : ""} difference(s): ${(
            outcome.diffs as { path: string; kind: string }[]
          )
            .slice(0, 3)
            .map((diff) => `${diff.kind} ${diff.path}`)
            .join(", ")}`;
    this.options.warn(
      `${request.method} on ${request.owner === "bun" ? "rust" : "bun"} ${summary}`,
    );
    const path = join(this.options.directory, SHADOW_FILE);
    try {
      try {
        if (statSync(path).size > SHADOW_ROTATE_BYTES)
          renameSync(path, `${path}.1`);
      } catch {
        // No file yet.
      }
      appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
    } catch (error) {
      this.options.warn(`cannot write ${path}: ${(error as Error).message}`);
    }
  }
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
