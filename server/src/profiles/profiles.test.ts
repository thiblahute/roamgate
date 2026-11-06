import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeProfilesSettings } from "../../../shared/agentProfiles";
import type { GuiSettings } from "../config/gui-settings";
import { holderStartCommand } from "../conversation/drivers/claude";
import { resumeReply } from "../conversation/holder";
import { profileLaunch } from "../mr-reviews/claude";
import { researchArgs } from "../voice/voice-research";
import { toolArgs } from "../voice/voice-tools";
import { createModelDiscovery } from "./models";
import {
  asCommand,
  commandEnv,
  commandForSession,
  createLaunchRegistry,
  createSessionProfiles,
  helperCommand,
  PLAIN_CLAUDE,
  profileCommand,
  profileForSession,
  readSecretFile,
  withModel,
  withoutModel,
} from "./profiles";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "rg-profiles-"));
  dirs.push(dir);
  return dir;
}

function secret(dir: string, value = "s3cret\n", mode = 0o600) {
  const path = join(dir, "token");
  writeFileSync(path, value);
  chmodSync(path, mode);
  return path;
}

function settingsWith(dir: string, defaultName = "Claude"): GuiSettings {
  return {
    version: 1,
    repositories: {},
    workspace_auto_sync: {},
    custom: {},
    ui: {},
    profiles: normalizeProfilesSettings({
      list: [
        {
          name: "GLM",
          agent: "claude",
          env: {
            ANTHROPIC_BASE_URL: "https://gw.example",
            ANTHROPIC_AUTH_TOKEN: { file: secret(dir) },
            ANTHROPIC_MODEL: "glm-5p3",
          },
        },
      ],
      default: defaultName,
    }),
  };
}

describe("resolving a profile", () => {
  test("no profiles: plain claude, exactly as before", () => {
    expect(commandForSession("s-1", null)).toEqual(PLAIN_CLAUDE);
    expect(helperCommand()).toBe("claude");
    expect(asCommand("claude").plain).toBe(true);
  });

  test("a secret file is read at start, its newline dropped", () => {
    const dir = scratch();
    const settings = settingsWith(dir, "GLM");
    const command = commandForSession(null, settings);
    expect(command).toMatchObject({
      profile: "GLM",
      program: "claude",
      plain: false,
      env: {
        ANTHROPIC_BASE_URL: "https://gw.example",
        ANTHROPIC_AUTH_TOKEN: "s3cret",
        ANTHROPIC_MODEL: "glm-5p3",
      },
    });
    expect(command.unset).toContain("ANTHROPIC_API_KEY");
    expect(
      commandEnv(command, { ANTHROPIC_API_KEY: "pane", PATH: "/bin" }),
    ).toEqual({ ...command.env, PATH: "/bin" });
  });

  test("a secret others can read is refused, naming the file only", () => {
    const dir = scratch();
    const path = secret(dir, "s3cret", 0o644);
    expect(() => readSecretFile(path)).toThrow(/chmod 600/);
    try {
      readSecretFile(path);
    } catch (error) {
      expect(String(error)).not.toContain("s3cret");
    }
    expect(() => readSecretFile(join(dir, "missing"))).toThrow(
      /cannot be read/,
    );
    expect(() => readSecretFile("relative/path")).toThrow(/absolute/);
  });

  test("a session's choice wins over the default", () => {
    const dir = scratch();
    const store = createSessionProfiles({ file: join(dir, "s.json") });
    const settings = settingsWith(dir);
    expect(profileForSession(settings, "s-1", store).name).toBe("Claude");
    store.set("s-1", "GLM");
    expect(profileForSession(settings, "s-1", store).name).toBe("GLM");
    // Kept on disk.
    const again = createSessionProfiles({ file: join(dir, "s.json") });
    expect(again.get("s-1")?.profile).toBe("GLM");
    // A profile since removed: the default.
    store.set("s-2", "Removed");
    expect(profileForSession(settings, "s-2", store).name).toBe("Claude");
  });

  test("sessions sent away by a limit are due back after its reset", () => {
    let now = 1000;
    const store = createSessionProfiles({ file: null, now: () => now });
    store.set("s-1", "GLM", { at: 5000, to: "Claude" });
    store.set("s-2", "GLM");
    expect(store.due()).toEqual([]);
    now = 5000;
    expect(store.due()).toEqual([{ sessionId: "s-1", to: "Claude" }]);
  });
});

describe("launches typed into a pane", () => {
  test("a token is good once, for its pane, for a while", () => {
    let now = 0;
    const launches = createLaunchRegistry({ now: () => now, ttlMs: 1000 });
    const spec = {
      argv: ["claude"],
      env: { A: "1" },
      unset: [],
      agent: "claude",
      terminal: false,
    };
    const token = launches.register("c1", "p1", spec);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(launches.take("c1", "p2", token)).toBeNull();
    expect(launches.take("c2", "p1", token)).toBeNull();
    expect(launches.take("c1", "p1", token)).toEqual(spec);
    expect(launches.take("c1", "p1", token)).toBeNull();
    const late = launches.register("c1", "p1", spec);
    now = 1000;
    expect(launches.take("c1", "p1", late)).toBeNull();
  });
});

describe("each spawn site follows the profile", () => {
  const glm = {
    profile: "GLM",
    agent: "claude" as const,
    program: "glm-claude",
    env: { ANTHROPIC_BASE_URL: "https://gw.example" },
    unset: ["ANTHROPIC_API_KEY"],
    plain: false,
  };

  test("conversation mode's headless start", () => {
    const plain = holderStartCommand({ sessionId: "s-1", cwd: "/w" });
    expect((plain.argv as string[])[0]).toBe("claude");
    expect(plain.unset).toBeUndefined();
    const command = holderStartCommand({
      sessionId: "s-1",
      cwd: "/w",
      profile: glm,
    });
    expect((command.argv as string[])[0]).toBe("glm-claude");
    expect((command.argv as string[]).slice(-14, -11)).toEqual([
      "-p",
      "--resume",
      "s-1",
    ]);
    expect(command.set).toMatchObject({
      ROAMGATE_HEADLESS: "1",
      ANTHROPIC_BASE_URL: "https://gw.example",
    });
    expect(command.unset).toEqual(["ANTHROPIC_API_KEY"]);
  });

  test("the hand-back to the terminal", () => {
    const lease = {
      connection_id: "c",
      pane_id: "p",
      session_id: "s-1",
      cwd: "/w",
      owner: "conversation" as const,
      phase: "conversation" as const,
      terminal_args: ["--model", "opus"],
      updated_at: "",
    };
    expect(resumeReply(lease)).toEqual({
      action: "resume",
      session_id: "s-1",
      cwd: "/w",
      argv: ["claude", "--model", "opus", "--resume", "s-1"],
      args: ["--model", "opus", "--resume", "s-1"],
    });
    expect(resumeReply(lease, glm)).toMatchObject({
      argv: ["glm-claude", "--model", "opus", "--resume", "s-1"],
      agent: "claude",
      env: glm.env,
      unset: glm.unset,
    });
  });

  test("the reviews' Claude pane", () => {
    const specs: unknown[] = [];
    const conn = {
      launch: (paneId: string, spec: unknown) => {
        specs.push({ paneId, spec });
        return " launch\r";
      },
    };
    const id = "11111111-2222-3333-4444-555555555555";
    expect(
      profileLaunch(conn, "p", id, true, "terminal", () => PLAIN_CLAUDE),
    ).toBeNull();
    expect(profileLaunch(conn, "p", id, false, "conversation", () => glm)).toBe(
      " launch\r",
    );
    expect(specs).toEqual([
      {
        paneId: "p",
        spec: {
          argv: ["glm-claude", "--session-id", id],
          env: glm.env,
          unset: glm.unset,
          agent: "claude",
          terminal: false,
        },
      },
    ]);
  });

  test("the voice helpers", () => {
    expect(researchArgs("sonnet")[0]).toBe("claude");
    expect(researchArgs("sonnet", glm)[0]).toBe("glm-claude");
    expect(toolArgs("sonnet", glm)[0]).toBe("glm-claude");
    expect(toolArgs("sonnet", "/opt/claude")[0]).toBe("/opt/claude");
    // voice.json claude_command still wins.
    expect(helperCommand("/opt/claude")).toBe("/opt/claude");
  });

  test("a profile command resolves once its secret reads", () => {
    const dir = scratch();
    const settings = settingsWith(dir);
    const profile = settings.profiles!.list[0]!;
    expect(profileCommand(profile).env.ANTHROPIC_AUTH_TOKEN).toBe("s3cret");
  });
});

describe("model discovery", () => {
  test("lists a gateway's chat models with the profile's token", async () => {
    const dir = scratch();
    const profile = settingsWith(dir).profiles!.list[0]!;
    const seen: { url: string; headers: Record<string, string> }[] = [];
    let now = 0;
    const discover = createModelDiscovery({
      now: () => now,
      fetch: async (url, init) => {
        seen.push({ url, headers: init.headers as Record<string, string> });
        return Response.json({
          data: [
            { id: "glm-5p3" },
            { id: "kimi-k3p1-pro" },
            { id: "qwen3-embedding-8b" },
          ],
        });
      },
    });
    const first = await discover(profile);
    expect(first).toMatchObject({
      models: ["glm-5p3", "kimi-k3p1-pro"],
      source: "server",
      missing: [],
    });
    expect(seen[0]!.url).toBe("https://gw.example/v1/models?limit=1000");
    expect(seen[0]!.headers).toMatchObject({
      authorization: "Bearer s3cret",
      "x-api-key": "s3cret",
    });
    // Kept an hour.
    now = 30 * 60_000;
    await discover(profile);
    expect(seen).toHaveLength(1);
    await discover(profile, true);
    expect(seen).toHaveLength(2);
  });

  test("warns about a configured model the server no longer has", async () => {
    const dir = scratch();
    const profile = settingsWith(dir).profiles!.list[0]!;
    const discover = createModelDiscovery({
      fetch: async () => Response.json({ data: [{ id: "kimi-k3" }] }),
    });
    expect((await discover(profile)).missing).toEqual([
      { slot: "ANTHROPIC_MODEL", model: "glm-5p3" },
    ]);
  });

  test("Claude itself gets its aliases, asking no server", async () => {
    const discover = createModelDiscovery({
      fetch: async () => {
        throw new Error("never");
      },
    });
    expect(await discover({ name: "Claude", agent: "claude" })).toMatchObject({
      source: "aliases",
      models: ["opus", "sonnet", "haiku", "opusplan"],
    });
  });

  test("a failed list keeps the token out of its message", async () => {
    const dir = scratch();
    const profile = settingsWith(dir).profiles!.list[0]!;
    const discover = createModelDiscovery({
      fetch: async () => new Response("no", { status: 401 }),
    });
    const result = await discover(profile);
    expect(result.error).toContain("401");
    expect(JSON.stringify(result)).not.toContain("s3cret");
  });
});

describe("a session's one-time model after a switch", () => {
  test("every start has it until the session answered on its profile", () => {
    const store = createSessionProfiles({ file: null });
    store.set("s-1", null, undefined, "claude-opus-5-5");
    expect(profileForSession(null, "s-1", store).name).toBe("Claude");
    expect(commandForSession("s-1", null, store)).toMatchObject({
      plain: true,
      model: "claude-opus-5-5",
    });
    store.settleModel("s-1");
    expect(store.get("s-1")).toBeNull();
    expect(commandForSession("s-1", null, store).model).toBeUndefined();
    // A chosen profile stays once its model settled.
    store.set("s-2", "GLM", undefined, "glm-5p3");
    store.settleModel("s-2");
    expect(store.get("s-2")).toMatchObject({ profile: "GLM" });
    expect(store.get("s-2")?.model).toBeUndefined();
  });

  test("--model is replaced, never doubled", () => {
    expect(
      withModel(["--model", "opus", "--verbose"], "claude-opus-5-5"),
    ).toEqual(["--verbose", "--model", "claude-opus-5-5"]);
    expect(withModel(["--model=opus"], "x")).toEqual(["--model", "x"]);
    expect(withModel(["--verbose"])).toEqual(["--verbose"]);
    expect(withoutModel(["--model", "opus", "--model=x", "--verbose"])).toEqual(
      ["--verbose"],
    );
  });

  test("/model: kept with the session's profile until it answered with it", () => {
    let now = Date.parse("2026-11-06T10:00:00.000Z");
    const store = createSessionProfiles({ file: null, now: () => now });
    store.set("s-1", "GLM", { at: 9, to: "Claude" }, "glm-5p3");
    now += 1000;
    store.chooseModel("s-1", "glm-5p3-flash", "glm-5p3-flash");
    expect(store.get("s-1")).toEqual({
      profile: "GLM",
      at: "2026-11-06T10:00:00.000Z",
      return_at: 9,
      return_to: "Claude",
      model: "glm-5p3-flash",
      model_at: "2026-11-06T10:00:01.000Z",
      model_resolved: "glm-5p3-flash",
    });
    expect(commandForSession("s-1", null, store).model).toBe("glm-5p3-flash");
    store.settleModel("s-1");
    expect(store.get("s-1")).toEqual({
      profile: "GLM",
      at: "2026-11-06T10:00:00.000Z",
      return_at: 9,
      return_to: "Claude",
    });
    // On the default profile, the choice alone is kept, and dropped whole.
    store.chooseModel("s-2", "sonnet");
    expect(store.get("s-2")).toMatchObject({ profile: null, model: "sonnet" });
    store.chooseModel("s-2", null);
    expect(store.get("s-2")).toBeNull();
  });

  test("a holder resume and a typed resume carry it", () => {
    const lease = {
      pane_id: "p",
      session_id: "s-1",
      cwd: "/w",
      owner: "conversation" as const,
      phase: "conversation" as const,
      terminal_args: ["--model", "opus"],
      connection_id: "local",
      updated_at: "",
    };
    expect(
      resumeReply(lease, { ...PLAIN_CLAUDE, model: "claude-opus-5-5" }),
    ).toMatchObject({
      argv: ["claude", "--model", "claude-opus-5-5", "--resume", "s-1"],
    });
  });
});
