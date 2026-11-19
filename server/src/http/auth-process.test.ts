import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const password = "logout-test-secret";

// Exercise the real HTTP router and socket cleanup, not a second test router.
async function withAuthServer(
  run: (
    base: string,
    sockets: WebSocket[],
    home: string,
    /** What the server wrote to stderr so far. */
    errors: () => string,
  ) => Promise<void>,
  environment: NodeJS.ProcessEnv = {},
) {
  const root = await mkdtemp(join(tmpdir(), "roamgate-logout-"));
  const sockets: WebSocket[] = [];
  const child = Bun.spawn([process.execPath, "server/src/index.ts"], {
    cwd: join(import.meta.dir, "../../.."),
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOME: root,
      APPDATA: root,
      XDG_CONFIG_HOME: root,
      HOST: "127.0.0.1",
      PORT: "0",
      OPEN_BROWSER: "0",
      ROAMGATE_PASSWORD: password,
      ROAMGATE_PIN: "",
      HERDR_GUI_PIN: "",
      ROAMGATE_CONNECTIONS_PATH: join(root, "connections.json"),
      ROAMGATE_SETTINGS_PATH: join(root, "settings.json"),
      HERDR_SOCKET_PATH: join(root, "missing-control.sock"),
      HERDR_CLIENT_SOCKET_PATH: join(root, "missing-render.sock"),
      HERDR_SSH_HOST: "",
      HERDR_SESSION: "",
      ROAMGATE_TLS_CERT: "",
      ROAMGATE_TLS_KEY: "",
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let errorText = "";
  const errors = (async () => {
    for await (const chunk of child.stderr)
      errorText += new TextDecoder().decode(chunk);
    return errorText;
  })();
  const ready = Promise.withResolvers<string>();
  const output = (async () => {
    let text = "";
    for await (const chunk of child.stdout) {
      text += new TextDecoder().decode(chunk);
      const port = text.match(/\bINFO bridge listening\b[^\r\n]*:(\d+)\b/)?.[1];
      if (port) ready.resolve(`http://127.0.0.1:${port}`);
    }
    ready.reject(
      new Error(`Server exited before listening: ${text}\n${await errors}`),
    );
  })();
  const deadline = setTimeout(
    () => ready.reject(new Error("Server startup timed out")),
    10_000,
  );
  try {
    const base = await ready.promise;
    clearTimeout(deadline);
    await run(base, sockets, root, () => errorText);
  } finally {
    clearTimeout(deadline);
    for (const socket of sockets) socket.close();
    child.kill();
    await child.exited;
    await output;
    await rm(root, { recursive: true, force: true });
  }
}

test("logout after reauthentication closes earlier and later tabs, not other browsers", async () => {
  await withAuthServer(async (base, sockets) => {
    const request = (path: string, init?: RequestInit) =>
      fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(5000) });
    const login = async (cookie = "") => {
      const response = await request("/api/login", {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({ password }),
      });
      expect(response.status).toBe(200);
      return response.headers.get("set-cookie")?.split(";", 1)[0] ?? cookie;
    };
    const first = await login();
    const second = await login();
    const connect = async (cookie: string) => {
      // Bun accepts custom handshake headers; lib.dom's constructor does not.
      const Socket = WebSocket as unknown as new (
        url: string,
        options: Bun.WebSocketOptions,
      ) => WebSocket;
      const ws = new Socket(base.replace("http:", "ws:") + "/ws", {
        headers: { cookie },
      });
      sockets.push(ws);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("WebSocket hello timed out")),
          5000,
        );
        ws.onmessage = (event) => {
          if (!JSON.parse(String(event.data)).hello) return;
          clearTimeout(timeout);
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket failed"));
        };
      });
      return ws;
    };
    const a = await connect(first);
    const reauthenticated = await login(first);
    expect(reauthenticated).toBe(first);
    const sameBrowserTab = await connect(reauthenticated);
    const otherBrowser = await connect(second);
    const currentCookie = await login(reauthenticated);
    expect(currentCookie).toBe(first);
    const closures = [a, sameBrowserTab].map(
      (ws) =>
        new Promise<number>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Logout did not close socket")),
            5000,
          );
          ws.onclose = (event) => {
            clearTimeout(timeout);
            resolve(event.code);
          };
        }),
    );
    expect(
      (await request("/api/health", { headers: { cookie: first } })).status,
    ).toBe(200);
    expect(
      await (
        await request("/api/health", { headers: { cookie: first } })
      ).json(),
    ).toMatchObject({ auth_required: true });
    const page = await request("/login");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain("/roamgate-icon-192.png");
    const logo = await request("/roamgate-icon-192.png");
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/png");
    expect(
      (await request("/api/logout", { headers: { cookie: first } })).status,
    ).toBe(405);
    expect(
      (
        await request("/api/logout", {
          method: "POST",
          headers: { cookie: first },
        })
      ).status,
    ).toBe(403);
    expect(a.readyState).toBe(WebSocket.OPEN);
    const logout = await request("/api/logout", {
      method: "POST",
      headers: { cookie: currentCookie, "x-roamgate-logout": "1" },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await Promise.all(closures)).toEqual([4001, 4001]);
    expect(otherBrowser.readyState).toBe(WebSocket.OPEN);
    expect((await request("/api/health")).status).toBe(401);
    expect(
      (await request("/api/health", { headers: { cookie: second } })).status,
    ).toBe(200);
    const redirect = await request("/", {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(redirect.headers.get("location")).toBe("/login");
    expect(await login()).not.toBe(first);
  });
}, 20_000);

test("loopback requires login and forged forwarding headers cannot evade login cooldown", async () => {
  await withAuthServer(async (base) => {
    expect(
      (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) }))
        .status,
    ).toBe(401);
    const redirect = await fetch(base, {
      signal: AbortSignal.timeout(5000),
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/login");
    for (let attempt = 0; attempt < 7; attempt++) {
      const response = await fetch(`${base}/api/login`, {
        signal: AbortSignal.timeout(5000),
        method: "POST",
        headers: {
          "x-forwarded-for": `192.0.2.${attempt + 1}`,
          "x-real-ip": `198.51.100.${attempt + 1}`,
        },
        body: JSON.stringify({ password: attempt === 6 ? password : "wrong" }),
      });
      expect(response.status).toBe(attempt < 5 ? 401 : 429);
      if (attempt >= 5) {
        expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(response.headers.get("set-cookie")).toBeNull();
      }
    }
  });
}, 20_000);

test("development loopback serves HTTP and WebSocket without credentials", async () => {
  await withAuthServer(
    async (base, sockets) => {
      const health = await fetch(`${base}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ auth_required: false });
      const page = await fetch(`${base}/login`, {
        signal: AbortSignal.timeout(5000),
        redirect: "manual",
      });
      expect(page.status).toBe(302);
      expect(page.headers.get("location")).toBe("/");
      expect(page.headers.get("cache-control")).toBe("no-store");
      const ws = new WebSocket(base.replace("http:", "ws:") + "/ws");
      sockets.push(ws);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("WebSocket hello timed out")),
          5000,
        );
        ws.onmessage = (event) => {
          if (!JSON.parse(String(event.data)).hello) return;
          clearTimeout(timeout);
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket failed"));
        };
      });
    },
    { NODE_ENV: "development", ROAMGATE_PASSWORD: "" },
  );
}, 20_000);

test("a rendered page's frame off its token gets an error page, never the login page or a route", async () => {
  const frame = {
    accept: "text/html",
    "sec-fetch-site": "cross-site",
    "sec-fetch-dest": "iframe",
    "sec-fetch-mode": "navigate",
  };
  const check = async (base: string, cookie = "") => {
    for (const path of [
      "/documentation/installing/index.html",
      "/login",
      "/",
    ]) {
      const response = await fetch(`${base}${path}`, {
        headers: { ...frame, ...(cookie ? { cookie } : {}) },
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(404);
      expect(response.headers.get("content-security-policy")).toContain(
        "sandbox allow-scripts",
      );
      const page = await response.text();
      expect(page).toContain("not part of this site");
      expect(page).not.toMatch(/password|token/i);
    }
    const fetched = await fetch(`${base}/api/health`, {
      headers: {
        "sec-fetch-site": "cross-site",
        "sec-fetch-dest": "empty",
        origin: "null",
      },
      signal: AbortSignal.timeout(5000),
    });
    expect(fetched.status).toBe(404);
  };
  await withAuthServer(async (base) => {
    await check(base);
    // Roamgate's own pages still go to the login page.
    const own = await fetch(base, {
      headers: { accept: "text/html", "sec-fetch-site": "none" },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    expect(own.headers.get("location")).toBe("/login");
  });
  // Nor any route where the gate lets everything through.
  await withAuthServer(async (base) => check(base), {
    NODE_ENV: "development",
    ROAMGATE_PASSWORD: "",
  });
}, 20_000);

test("development non-loopback binding still requires login", async () => {
  await withAuthServer(
    async (base) => {
      expect(
        (
          await fetch(`${base}/api/health`, {
            signal: AbortSignal.timeout(5000),
          })
        ).status,
      ).toBe(401);
    },
    { NODE_ENV: "development", HOST: "0.0.0.0" },
  );
}, 20_000);

test("instance naming is authenticated, persistent, and isolated from other instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "roamgate-instance-name-"));
  const settingsPath = join(root, "settings.json");
  const login = async (base: string) => {
    const response = await fetch(`${base}/api/login`, {
      method: "POST",
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    return response.headers.get("set-cookie")!.split(";", 1)[0];
  };
  const save = (base: string, cookie: string, title_suffix: string) =>
    fetch(`${base}/api/instance-settings`, {
      method: "PUT",
      headers: {
        cookie,
        "x-roamgate-settings": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title_suffix }),
      signal: AbortSignal.timeout(5000),
    });
  const manifest = async (base: string, cookie: string) => {
    const response = await fetch(`${base}/manifest.json`, {
      headers: { cookie },
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, must-revalidate",
    );
    return response.json();
  };
  try {
    await withAuthServer(
      async (base) => {
        for (const path of ["/api/instance-settings", "/manifest.json"]) {
          expect(
            (
              await fetch(`${base}${path}`, {
                signal: AbortSignal.timeout(5000),
              })
            ).status,
          ).toBe(401);
        }
        expect((await save(base, "", "Unauthorized")).status).toBe(401);
        const cookie = await login(base);
        const get = await fetch(`${base}/api/instance-settings`, {
          headers: { cookie },
          signal: AbortSignal.timeout(5000),
        });
        expect(await get.json()).toEqual({
          title_suffix: "",
          rendered_sites: [],
          rendered_site_roots: {},
        });
        expect(get.headers.get("cache-control")).toBe("no-store");
        const original = await manifest(base, cookie);
        expect(original.name).toBe("Roamgate");
        const saved = await save(base, cookie, "  Home  ");
        expect(saved.status).toBe(200);
        expect(await saved.json()).toEqual({
          title_suffix: "Home",
          rendered_sites: [],
          rendered_site_roots: {},
        });
        expect(await manifest(base, cookie)).toEqual({
          ...original,
          name: "Roamgate \u00b7 Home",
          short_name: "Roamgate \u00b7 Home",
        });
        const html = await (
          await fetch(`${base}/`, {
            headers: { cookie, accept: "text/html" },
            signal: AbortSignal.timeout(5000),
          })
        ).text();
        expect(html).toContain("<title>Roamgate \u00b7 Home</title>");
        expect(html).toContain(
          'name="application-name" content="Roamgate \u00b7 Home"',
        );
        expect(html).toContain(
          'name="apple-mobile-web-app-title" content="Roamgate \u00b7 Home"',
        );
        await withAuthServer(async (otherBase) => {
          const otherCookie = await login(otherBase);
          expect((await manifest(otherBase, otherCookie)).name).toBe(
            "Roamgate",
          );
          expect((await save(otherBase, otherCookie, "Work")).status).toBe(200);
          expect((await manifest(otherBase, otherCookie)).name).toBe(
            "Roamgate \u00b7 Work",
          );
          expect((await manifest(base, cookie)).name).toBe(
            "Roamgate \u00b7 Home",
          );
        });
      },
      { ROAMGATE_SETTINGS_PATH: settingsPath },
    );
    // A new process reads the same persisted name before serving its first page.
    await withAuthServer(
      async (base) => {
        const cookie = await login(base);
        expect((await manifest(base, cookie)).name).toBe(
          "Roamgate \u00b7 Home",
        );
        expect((await save(base, cookie, "")).status).toBe(200);
        expect((await manifest(base, cookie)).name).toBe("Roamgate");
      },
      { ROAMGATE_SETTINGS_PATH: settingsPath },
    );
    expect((await Bun.file(settingsPath).json()).title_suffix).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("instance name save failures preserve the current name and permit retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "roamgate-instance-save-"));
  const blockedPath = join(root, "settings.json");
  await mkdir(blockedPath);
  try {
    await withAuthServer(
      async (base) => {
        const response = await fetch(`${base}/api/login`, {
          method: "POST",
          body: JSON.stringify({ password }),
          signal: AbortSignal.timeout(5000),
        });
        const cookie = response.headers.get("set-cookie")!.split(";", 1)[0];
        const save = () =>
          fetch(`${base}/api/instance-settings`, {
            method: "PUT",
            headers: {
              cookie,
              "x-roamgate-settings": "1",
              "content-type": "application/json",
            },
            body: JSON.stringify({ title_suffix: "Retry" }),
            signal: AbortSignal.timeout(5000),
          });
        const failed = await save();
        expect(failed.status).toBe(500);
        expect(await failed.json()).toEqual({
          error: "Unable to save instance settings",
        });
        const get = () =>
          fetch(`${base}/api/instance-settings`, {
            headers: { cookie },
            signal: AbortSignal.timeout(5000),
          }).then((response) => response.json());
        expect(await get()).toEqual({
          title_suffix: "",
          rendered_sites: [],
          rendered_site_roots: {},
        });
        await rm(blockedPath, { recursive: true });
        expect((await save()).status).toBe(200);
        expect(await get()).toEqual({
          title_suffix: "Retry",
          rendered_sites: [],
          rendered_site_roots: {},
        });
      },
      { ROAMGATE_SETTINGS_PATH: blockedPath },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("PIN login uses a separate endpoint and preserves password recovery during PIN cooldown", async () => {
  await withAuthServer(
    async (base) => {
      const request = (path: string, init?: RequestInit) =>
        fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(5000) });
      const page = await (await request("/login")).text();
      expect(page).toContain('inputmode="numeric"');
      expect(page).toContain("Use password or token instead");
      const pinLogin = (pin: string) =>
        request("/api/login/pin", {
          method: "POST",
          body: JSON.stringify({ pin }),
        });
      const loggedIn = await pinLogin("012345");
      expect(loggedIn.status).toBe(200);
      const cookie = loggedIn.headers.get("set-cookie")!.split(";", 1)[0]!;
      expect(cookie).toContain("herdr_auth=");
      expect((await request("/", { headers: { cookie } })).status).toBe(200);
      for (let i = 0; i < 5; i++)
        expect((await pinLogin("654321")).status).toBe(401);
      const blocked = await pinLogin("012345");
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
      const recovered = await request("/api/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      expect(recovered.status).toBe(200);
      expect(recovered.headers.has("set-cookie")).toBe(true);
      expect((await pinLogin("012345")).status).toBe(429);
    },
    { ROAMGATE_PIN: "012345" },
  );
});

test("PIN endpoint is disabled by default", async () => {
  await withAuthServer(
    async (base) => {
      const response = await fetch(`${base}/api/login/pin`, {
        method: "POST",
        body: JSON.stringify({ pin: "012345" }),
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(404);
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(await (await fetch(`${base}/login`)).text()).not.toContain(
        'inputmode="numeric"',
      );
    },
    { ROAMGATE_PIN: "", HERDR_GUI_PIN: "" },
  );
});

test("instances sharing a home preserve independent sessions across restarts and credential rotations", async () => {
  const root = await mkdtemp(join(tmpdir(), "roamgate-instance-sessions-"));
  const shared = { HOME: root, APPDATA: root, XDG_CONFIG_HOME: root };
  const first = {
    ...shared,
    ROAMGATE_SETTINGS_PATH: join(root, "first-settings.json"),
    ROAMGATE_PASSWORD: "first-instance-password",
    ROAMGATE_PIN: "012345",
  };
  const second = {
    ...shared,
    ROAMGATE_SETTINGS_PATH: join(root, "second-settings.json"),
    ROAMGATE_PASSWORD: "second-instance-password",
    ROAMGATE_PIN: "654321",
  };
  const login = async (base: string, loginPassword: string) => {
    const response = await fetch(`${base}/api/login`, {
      method: "POST",
      body: JSON.stringify({ password: loginPassword }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    return response.headers.get("set-cookie")!.split(";", 1)[0]!;
  };
  const status = async (base: string, cookie: string) =>
    (
      await fetch(`${base}/api/health`, {
        headers: { cookie },
        signal: AbortSignal.timeout(5000),
      })
    ).status;
  let firstCookie = "";
  let secondCookie = "";
  let rotatedCookie = "";
  try {
    await withAuthServer(async (firstBase) => {
      firstCookie = await login(firstBase, first.ROAMGATE_PASSWORD);
      await withAuthServer(async (secondBase) => {
        secondCookie = await login(secondBase, second.ROAMGATE_PASSWORD);
        expect(await status(firstBase, firstCookie)).toBe(200);
        expect(await status(secondBase, secondCookie)).toBe(200);
        expect(await status(firstBase, secondCookie)).toBe(401);
        expect(await status(secondBase, firstCookie)).toBe(401);
      }, second);
    }, first);
    await withAuthServer(async (firstBase) => {
      expect(await status(firstBase, firstCookie)).toBe(200);
      await withAuthServer(async (secondBase) => {
        expect(await status(secondBase, secondCookie)).toBe(200);
        expect(await status(firstBase, firstCookie)).toBe(200);
      }, second);
    }, first);
    await withAuthServer(
      async (firstBase) => {
        expect(await status(firstBase, firstCookie)).toBe(401);
        rotatedCookie = await login(firstBase, "changed-instance-password");
        await withAuthServer(async (secondBase) => {
          expect(await status(secondBase, secondCookie)).toBe(200);
          expect(await status(firstBase, rotatedCookie)).toBe(200);
        }, second);
      },
      { ...first, ROAMGATE_PASSWORD: "changed-instance-password" },
    );
    await withAuthServer(async (firstBase) => {
      expect(await status(firstBase, firstCookie)).toBe(401);
      expect(await status(firstBase, rotatedCookie)).toBe(401);
      const restoredCookie = await login(firstBase, first.ROAMGATE_PASSWORD);
      expect(await status(firstBase, restoredCookie)).toBe(200);
      await withAuthServer(async (secondBase) => {
        expect(await status(secondBase, secondCookie)).toBe(200);
        expect(await status(firstBase, restoredCookie)).toBe(200);
      }, second);
    }, first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("generated-token login takes only page openings: sockets and API requests with a token are never failed logins", async () => {
  await withAuthServer(
    async (base, _sockets, home) => {
      const token = (
        await readFile(join(home, ".config/roamgate/auth-token"), "utf8")
      ).trim();
      expect(token.length).toBeGreaterThan(0);
      const upgrade = {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      };
      for (let attempt = 0; attempt < 6; attempt++) {
        for (const path of ["/ws?token=wrong", "/api/health?token=wrong"]) {
          const response = await fetch(`${base}${path}`, {
            signal: AbortSignal.timeout(5000),
            headers: path.startsWith("/ws") ? upgrade : {},
            redirect: "manual",
          });
          // Their routes answer: not logged in, never sent to /login.
          expect(response.status).toBe(401);
        }
      }
      const login = await fetch(`${base}/api/login`, {
        signal: AbortSignal.timeout(5000),
        method: "POST",
        body: JSON.stringify({ password: token }),
      });
      expect(login.status).toBe(200);
      // Opening a page with the token still logs in.
      const page = await fetch(`${base}/?token=${encodeURIComponent(token)}`, {
        signal: AbortSignal.timeout(5000),
        headers: { "sec-fetch-mode": "navigate", accept: "text/html" },
        redirect: "manual",
      });
      expect(page.status).toBe(303);
      expect(page.headers.get("location")).toBe("/");
      expect(page.headers.get("set-cookie")).toContain("=");
    },
    { ROAMGATE_PASSWORD: "" },
  );
}, 20_000);

test("a call's signalling socket needs login, this site, and the call's own token", async () => {
  await withAuthServer(async (base) => {
    const signalling = (cookie = "", site?: string) =>
      fetch(`${base}/api/voice/call/signalling?call=1&call_token=guess`, {
        signal: AbortSignal.timeout(5000),
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          ...(cookie ? { cookie } : {}),
          ...(site ? { "sec-fetch-site": site } : {}),
        },
      });
    expect((await signalling()).status).toBe(401);
    const login = await fetch(`${base}/api/login`, {
      signal: AbortSignal.timeout(5000),
      method: "POST",
      body: JSON.stringify({ password }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).toContain("=");
    // Logged in, but no call is this token's (none at all here).
    expect((await signalling(cookie)).status).toBe(403);
    expect((await signalling(cookie, "cross-site")).status).toBe(403);
  });
}, 20_000);

test.skipIf(process.platform === "win32")(
  "a call's signalling upgrades for its owner in generated-token mode, and refusals are 403, never 303 or 429",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "roamgate-call-"));
    try {
      const config = join(home, ".config/roamgate");
      await mkdir(config, { recursive: true });
      const helper = join(home, "fake-call-helper");
      const script = join(
        import.meta.dir,
        "../voice/testdata/fake-call-helper.ts",
      );
      await writeFile(
        helper,
        `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
        { mode: 0o755 },
      );
      // The fake helper reads no models: any file stands for them.
      const model = join(home, "model");
      await writeFile(model, "");
      await writeFile(
        join(config, "voice.json"),
        JSON.stringify({
          helper,
          whisper_model: model,
          kokoro_model: model,
          kokoro_voices: model,
        }),
      );
      await withAuthServer(
        async (base, sockets, _root, errors) => {
          // The live mode: no password, the generated token.
          const token = (
            await readFile(join(config, "auth-token"), "utf8")
          ).trim();
          const login = async () =>
            fetch(`${base}/api/login`, {
              signal: AbortSignal.timeout(5000),
              method: "POST",
              body: JSON.stringify({ password: token }),
            });
          const loggedIn = await login();
          expect(loggedIn.status).toBe(200);
          const cookie = (loggedIn.headers.get("set-cookie") ?? "").split(
            ";",
          )[0]!;
          // Bun accepts custom handshake headers; lib.dom's constructor
          // does not.
          const Socket = WebSocket as unknown as new (
            url: string,
            options: Bun.WebSocketOptions,
          ) => WebSocket;
          const open = (path: string) => {
            const ws = new Socket(base.replace("http:", "ws:") + path, {
              headers: { cookie },
            });
            sockets.push(ws);
            return ws;
          };
          const next = (
            ws: WebSocket,
            wanted: (message: Record<string, unknown>) => boolean,
          ) =>
            new Promise<Record<string, unknown>>((resolve, reject) => {
              const timeout = setTimeout(
                () => reject(new Error("no such message in 5 s")),
                5000,
              );
              ws.addEventListener("message", (event) => {
                const message = JSON.parse(String(event.data));
                if (!wanted(message)) return;
                clearTimeout(timeout);
                resolve(message);
              });
              ws.addEventListener("close", (event) => {
                clearTimeout(timeout);
                reject(new Error(`closed ${event.code} ${event.reason}`));
              });
            });

          const voice = open("/api/voice/ws");
          const answered = next(voice, (m) => m.event === "call_audio");
          voice.addEventListener("open", () =>
            voice.send(JSON.stringify({ op: "call_audio", on: true })),
          );
          const answer = await answered;
          expect(answer).toMatchObject({ webrtc: true });
          const call = Number(answer.call);
          const callToken = String(answer.resume);

          // The URL the page builds (webrtcCall.ts): its signalling opens.
          const signalling = open(
            `/api/voice/call/signalling?call=${call}&call_token=${encodeURIComponent(callToken)}`,
          );
          expect(
            await next(signalling, (m) => m.type === "welcome"),
          ).toMatchObject({ peerId: `fake-peer-${call}` });

          const upgrade = (query: string) =>
            fetch(`${base}/api/voice/call/signalling?${query}`, {
              signal: AbortSignal.timeout(5000),
              redirect: "manual",
              headers: {
                connection: "Upgrade",
                upgrade: "websocket",
                "sec-websocket-version": "13",
                "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
                cookie,
              },
            });
          for (let attempt = 0; attempt < 6; attempt += 1)
            for (const query of [
              `call=${call}&call_token=wrong`,
              // The parameter that URL login once took: never a login.
              `call=${call}&token=wrong`,
              `call=${call + 1}&call_token=${encodeURIComponent(callToken)}`,
            ])
              expect((await upgrade(query)).status).toBe(403);
          // Nothing counted as a failed login.
          expect((await login()).status).toBe(200);
          const log = errors();
          expect(log).toContain(
            `call ${call}: signalling refused (403): not the call's call_token`,
          );
          expect(log).toContain(
            `call ${call}: signalling refused (403): no call_token`,
          );
          expect(log).toContain(
            `call ${call + 1}: signalling refused (403): the call going on is ${call}`,
          );
          expect(log.match(/a page signals on port/g) ?? []).toHaveLength(1);
        },
        { HOME: home, ROAMGATE_PASSWORD: "", ROAMGATE_VOICE_DEBUG: "1" },
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  30_000,
);

test("a call handoff is redeemed without login, its token the only credential", async () => {
  await withAuthServer(async (base) => {
    const redeem = await fetch(`${base}/api/voice/call/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handoff: "not-a-token" }),
      signal: AbortSignal.timeout(5000),
    });
    expect(redeem.status).toBe(410);
    expect(redeem.headers.get("set-cookie")).toBeNull();
    // Nothing else of the call's API comes out from under the login.
    const other = await fetch(`${base}/api/voice/call/handoff/x`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    expect(other.status).toBe(401);
  });
}, 20_000);

test("the notification socket needs the login cookie, then replays and logs out", async () => {
  await withAuthServer(async (base, sockets) => {
    const upgrade = (cookie = "") =>
      fetch(`${base}/api/notifications/ws`, {
        signal: AbortSignal.timeout(5000),
        headers: {
          cookie,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      });
    expect((await upgrade()).status).toBe(401);
    const loggedIn = await fetch(`${base}/api/login`, {
      signal: AbortSignal.timeout(5000),
      method: "POST",
      body: JSON.stringify({ password }),
    });
    expect(loggedIn.status).toBe(200);
    const cookie = (loggedIn.headers.get("set-cookie") ?? "").split(";")[0]!;
    // Never from another site.
    const crossSite = await fetch(`${base}/api/notifications/ws`, {
      signal: AbortSignal.timeout(5000),
      headers: { cookie, "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);

    const Socket = WebSocket as unknown as new (
      url: string,
      options: Bun.WebSocketOptions,
    ) => WebSocket;
    const ws = new Socket(
      base.replace("http:", "ws:") + "/api/notifications/ws",
      { headers: { cookie } },
    );
    sockets.push(ws);
    const ready = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no ready")), 5000);
      ws.onmessage = (event) => {
        clearTimeout(timeout);
        resolve(JSON.parse(String(event.data)));
      };
    });
    ws.onopen = () =>
      ws.send(JSON.stringify({ op: "hello", since: null, client: "android" }));
    expect(await ready).toEqual({ event: "ready", last: 0 });

    const closed = new Promise<number>((resolve) => {
      ws.onclose = (event) => resolve(event.code);
    });
    await fetch(`${base}/api/logout`, {
      signal: AbortSignal.timeout(5000),
      method: "POST",
      headers: { cookie, "x-roamgate-logout": "1" },
    });
    expect(await closed).toBe(4001);
  });
}, 20_000);
