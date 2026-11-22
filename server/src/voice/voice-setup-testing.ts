import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceHardware } from "../../../shared/voiceSetup";
import { type ModelPackage, PACKAGES } from "./voice-models";
import type { VoiceSetupDeps } from "./voice-setup";

/**
 * For the voice setup's tests: the catalog's packages with a few bytes in
 * place of each model file, served by a local server that answers Range
 * requests, so nothing real is ever downloaded.
 */

export const GIB = 1024 ** 3;

export const NVIDIA_DESKTOP: VoiceHardware = {
  platform: "linux",
  arch: "x64",
  osName: "Fedora Linux 43",
  cpu: { model: "AMD Ryzen 9 3950X 16-Core Processor", cores: 32 },
  ramBytes: 64 * GIB,
  gpus: [
    {
      vendor: "nvidia",
      name: "NVIDIA GeForce RTX 3060 Ti",
      vramBytes: 8 * GIB,
    },
  ],
  acceleration: "cuda",
  gpuBytes: 8 * GIB,
};

export const CPU_LAPTOP: VoiceHardware = {
  platform: "linux",
  arch: "x64",
  cpu: { model: "Intel Core i5", cores: 8 },
  ramBytes: 16 * GIB,
  gpus: [],
  acceleration: "cpu",
  gpuBytes: 0,
};

export type ModelServer = {
  url: string;
  packages: ModelPackage[];
  /** Each request's path and Range header. */
  requests: { path: string; range: string | null }[];
  /** Bodies by path, to change one (a corrupted file). */
  bodies: Map<string, Uint8Array>;
  /**
   * A fetch whose response for these paths stops halfway once, as a
   * connection lost: give it to the downloads as their fetch.
   */
  cutOnce: Set<string>;
  fetch: typeof fetch;
  /** Ignore Range headers, answering the whole file. */
  ignoreRange: boolean;
  stop: () => void;
};

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export function serveModels(): ModelServer {
  const bodies = new Map<string, Uint8Array>();
  const requests: ModelServer["requests"] = [];
  const cutOnce = new Set<string>();
  const state = { ignoreRange: false };
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const range = req.headers.get("range");
      requests.push({ path, range });
      const body = bodies.get(path);
      if (!body) return new Response("not found", { status: 404 });
      let start = 0;
      if (range && !state.ignoreRange) {
        start = Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0);
        if (start >= body.length) return new Response(null, { status: 416 });
      }
      const rest = body.slice(start);
      return new Response(rest, {
        status: start ? 206 : 200,
        headers: start
          ? {
              "content-range": `bytes ${start}-${body.length - 1}/${body.length}`,
            }
          : {},
      });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const packages = PACKAGES.map((entry) => ({
    ...entry,
    files: entry.files.map((file) => {
      const bytes = new TextEncoder().encode(
        `${entry.id}/${file.path}:`.repeat(40),
      );
      const path = `/${entry.id}/${file.path}`;
      bodies.set(path, bytes);
      return {
        path: file.path,
        url: `${url}${path}`,
        size: bytes.length,
        sha256: sha256(bytes),
      };
    }),
  }));
  return {
    url,
    packages,
    requests,
    bodies,
    cutOnce,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fetch(input, init);
      const path = new URL(String(input)).pathname;
      if (!cutOnce.delete(path) || !response.body) return response;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const half = bytes.slice(0, Math.max(1, Math.floor(bytes.length / 2)));
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) controller.error(new Error("connection lost"));
          else controller.enqueue(half);
          sent = true;
        },
      });
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      });
    }) as typeof fetch,
    get ignoreRange() {
      return state.ignoreRange;
    },
    set ignoreRange(value: boolean) {
      state.ignoreRange = value;
    },
    stop: () => server.stop(true),
  };
}

export type SetupHome = {
  home: string;
  deps: VoiceSetupDeps;
  cleanup: () => void;
};

/** A temporary home with the voice's directories, on `hardware`. */
export function setupHome(
  server: ModelServer,
  hardware: VoiceHardware = NVIDIA_DESKTOP,
): SetupHome {
  const home = mkdtempSync(join(tmpdir(), "roamgate-voice-setup-"));
  return {
    home,
    deps: {
      hardware: () => hardware,
      modelsDir: join(home, ".local", "share", "roamgate", "voice", "models"),
      configPath: join(home, ".config", "roamgate", "voice.json"),
      helperPath: join(
        home,
        ".local",
        "share",
        "roamgate",
        "voice",
        "roamgate-voice",
      ),
      packages: server.packages,
      freeBytes: () => 100 * GIB,
      retryDelayMs: 0,
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}
