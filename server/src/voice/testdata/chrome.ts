/**
 * Headless Chrome for the opt-in live voice tests (voice-call.live.test.ts),
 * driven over the DevTools protocol: no browser automation package. Its
 * fake microphone plays a WAV file; Chrome's echo cancellation, noise
 * suppression and auto gain run on it as on a device. (No request
 * interception: Chrome's Fetch domain breaks the page's WebSockets.)
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Chrome or Chromium here: CHROME_BIN, else the usual places. */
export function chromePath(): string | null {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((path) => path && existsSync(path)) ?? null;
}

type Pending = {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

export type Page = {
  /** Evaluates `expression` in the page, awaiting a promise it gives. */
  evaluate: <T>(expression: string) => Promise<T>;
  navigate: (url: string) => Promise<void>;
  /** The page's console lines so far. */
  console: string[];
};

export type Chrome = {
  /** A new page, blank. */
  page: () => Promise<Page>;
  close: () => Promise<void>;
};

/** Launches headless Chrome, its fake microphone playing `microphone`. */
export async function launchChrome(
  binary: string,
  microphone: string,
): Promise<Chrome> {
  const profile = mkdtempSync(join(tmpdir(), "roamgate-chrome-"));
  const child = Bun.spawn(
    [
      binary,
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      // The sandboxed audio service cannot read the microphone's file:
      // it would hear silence.
      "--disable-features=AudioServiceSandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${microphone}%noloop`,
      "--autoplay-policy=no-user-gesture-required",
      // Its audio goes to a silent fake device, not the Mac's speakers.
      "--disable-audio-output",
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  const portFile = join(profile, "DevToolsActivePort");
  const started = Date.now();
  while (
    !existsSync(portFile) ||
    !readFileSync(portFile, "utf8").includes("\n")
  ) {
    if (Date.now() - started > 20_000) {
      child.kill();
      throw new Error("Chrome did not start");
    }
    await Bun.sleep(50);
  }
  const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("no DevTools socket"));
  });
  let next = 0;
  const pending = new Map<number, Pending>();
  const handlers = new Set<(message: Record<string, unknown>) => void>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    if (typeof message.id === "number") {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.error)
        waiting?.reject(new Error(JSON.stringify(message.error)));
      else waiting?.resolve((message.result ?? {}) as Record<string, unknown>);
      return;
    }
    for (const handler of handlers) handler(message);
  };
  const send = (
    method: string,
    params: object = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> => {
    const id = (next += 1);
    socket.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
    return new Promise((resolve, reject) =>
      pending.set(id, { resolve, reject }),
    );
  };

  return {
    async page() {
      const { targetId } = await send("Target.createTarget", {
        url: "about:blank",
      });
      const { sessionId } = (await send("Target.attachToTarget", {
        targetId,
        flatten: true,
      })) as { sessionId: string };
      const lines: string[] = [];
      handlers.add((message) => {
        if (message.sessionId !== sessionId) return;
        const params = (message.params ?? {}) as Record<string, unknown>;
        if (message.method === "Runtime.consoleAPICalled") {
          const args = (params.args ?? []) as { value?: unknown }[];
          lines.push(args.map((arg) => String(arg.value ?? "")).join(" "));
        }
      });
      await send("Runtime.enable", {}, sessionId);
      await send("Page.enable", {}, sessionId);
      return {
        console: lines,
        async navigate(url) {
          const { loaderId } = (await send(
            "Page.navigate",
            { url },
            sessionId,
          )) as { loaderId?: string };
          // Loaded once this navigation's document is complete.
          for (let i = 0; i < 300; i += 1) {
            const now = (await send(
              "Runtime.evaluate",
              {
                expression: "document.readyState",
                returnByValue: true,
              },
              sessionId,
            )) as { result?: { value?: unknown } };
            const { frameTree } = (await send(
              "Page.getFrameTree",
              {},
              sessionId,
            )) as { frameTree: { frame: { loaderId: string } } };
            if (
              now.result?.value === "complete" &&
              (!loaderId || frameTree.frame.loaderId === loaderId)
            )
              return;
            await Bun.sleep(100);
          }
          throw new Error(`${url} did not load`);
        },
        async evaluate<T>(expression: string) {
          const answer = (await send(
            "Runtime.evaluate",
            { expression, awaitPromise: true, returnByValue: true },
            sessionId,
          )) as {
            result?: { value?: unknown };
            exceptionDetails?: { exception?: { description?: string } };
          };
          if (answer.exceptionDetails)
            throw new Error(
              answer.exceptionDetails.exception?.description ??
                JSON.stringify(answer.exceptionDetails),
            );
          return answer.result?.value as T;
        },
      };
    },
    async close() {
      try {
        await send("Browser.close");
      } catch {
        // Gone already.
      }
      socket.close();
      child.kill();
      await child.exited;
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
