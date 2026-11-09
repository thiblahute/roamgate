import { describe, expect, test } from "bun:test";
import { claudeMcp, claudeMcpRow } from "./claude-mcp";
import type { ControlAnswer, ModelContext } from "./types";

/** Rows as Claude Code 2.1.319 sent them to a real `claude -p`. */
const CONNECTED = {
  name: "echo",
  status: "connected",
  serverInfo: { name: "echo-probe", version: "1.2.3" },
  config: {
    type: "stdio",
    command: "/opt/homebrew/bin/bun",
    args: ["/tmp/server.mjs", "--token=secret"],
    env: { API_KEY: "secret" },
  },
  transport: "stdio",
  scope: "dynamic",
  source: "dynamic",
  tools: [
    { name: "echo", annotations: { readOnly: true } },
    { name: "wipe", annotations: { destructive: true } },
    { name: "second", annotations: {} },
  ],
};

function context(answers: Record<string, ControlAnswer>) {
  const asked: [string, Record<string, unknown>][] = [];
  const ctx: ModelContext = {
    control: async (kind, params) => {
      asked.push([kind, params]);
      return answers[kind] === undefined ? { response: {} } : answers[kind];
    },
  };
  return { ctx, asked };
}

describe("a row of mcp_status", () => {
  test("a connected stdio server: its tools, and nothing secret", () => {
    const row = claudeMcpRow(CONNECTED);
    expect(row).toEqual({
      name: "echo",
      status: "connected",
      scope: "dynamic",
      transport: "stdio",
      target: "bun",
      version: "echo-probe 1.2.3",
      tools: [
        { name: "echo", readOnly: true },
        { name: "wipe", destructive: true },
        { name: "second" },
      ],
      actions: ["reconnect", "disable"],
    });
    expect(JSON.stringify(row)).not.toContain("secret");
  });

  test("a failed stdio server says why and has no sign-in", () => {
    expect(
      claudeMcpRow({
        name: "broken",
        status: "failed",
        transport: "stdio",
        error: "ENOENT: no such file or directory, posix_spawn 'stdio'",
        config: { type: "stdio", command: "/nonexistent/mcp-binary" },
      }),
    ).toMatchObject({
      status: "failed",
      target: "mcp-binary",
      error: "ENOENT: no such file or directory, posix_spawn 'stdio'",
      actions: ["reconnect", "disable"],
    });
  });

  test("an OAuth server that needs signing in shows only its host", () => {
    const row = claudeMcpRow({
      name: "docs",
      status: "needs-auth",
      transport: "http",
      source: "project",
      config: {
        type: "http",
        url: "https://mcp.example.com/v1?token=secret",
        headers: { Authorization: "Bearer secret" },
      },
    });
    expect(row).toEqual({
      name: "docs",
      status: "needs-auth",
      scope: "project",
      transport: "http",
      target: "mcp.example.com",
      actions: ["authenticate", "reconnect", "disable"],
    });
    expect(JSON.stringify(row)).not.toContain("secret");
  });

  test("the urlHost Claude sends wins over the configured URL", () => {
    expect(
      claudeMcpRow({
        name: "docs",
        status: "needs-auth",
        transport: "sse",
        urlHost: "mcp.example.com:8443",
      }),
    ).toMatchObject({ target: "mcp.example.com:8443" });
  });

  test("a claude.ai connector is signed in to on claude.ai", () => {
    expect(
      claudeMcpRow({
        name: "claude.ai Linear",
        status: "needs-auth",
        transport: "claudeai-proxy",
        scope: "claudeai",
        config: {
          type: "claudeai-proxy",
          url: "https://mcp-proxy.example/v1",
          id: "x",
        },
      }),
    ).toEqual({
      name: "claude.ai Linear",
      status: "needs-auth",
      scope: "claudeai",
      transport: "claude.ai",
      actions: ["authenticate", "reconnect", "disable"],
    });
  });

  test("a server the session proxies offers no sign-in", () => {
    expect(
      claudeMcpRow({
        name: "hosted",
        status: "needs-auth",
        transport: "http",
        sessionProxied: true,
      })?.actions,
    ).toEqual(["reconnect", "disable"]);
  });

  test("a disabled server can only be enabled, a pending one nothing", () => {
    expect(
      claudeMcpRow({ name: "a", status: "disabled", transport: "stdio" })
        ?.actions,
    ).toEqual(["enable"]);
    expect(
      claudeMcpRow({ name: "b", status: "pending", transport: "stdio" })
        ?.actions,
    ).toEqual([]);
  });

  test("a status it does not know is shown as failed, with the word", () => {
    expect(
      claudeMcpRow({ name: "c", status: "quarantined", transport: "stdio" }),
    ).toMatchObject({
      status: "failed",
      error: "Unknown status: quarantined",
    });
  });

  test("a tool count is kept when no list came", () => {
    expect(
      claudeMcpRow({
        name: "d",
        status: "connected",
        transport: "http",
        toolCount: 17,
      }),
    ).toMatchObject({ toolCount: 17 });
  });

  test("a row without a name is dropped", () => {
    expect(claudeMcpRow({ status: "connected" })).toBeNull();
    expect(claudeMcpRow("nope")).toBeNull();
  });
});

describe("the requests", () => {
  test("mcp_status: the rows it can read, or why not", async () => {
    const { ctx } = context({
      mcp_status: {
        response: { mcpServers: [CONNECTED, { status: "pending" }] },
      },
    });
    const listed = await claudeMcp.status(ctx);
    expect(listed.ok && listed.servers.map((row) => row.name)).toEqual([
      "echo",
    ]);
    expect(await claudeMcp.status(context({ mcp_status: null }).ctx)).toEqual({
      ok: false,
      reason: "Claude did not answer in time",
    });
    expect(
      await claudeMcp.status(context({ mcp_status: { error: "nope" } }).ctx),
    ).toEqual({ ok: false, reason: "nope" });
    expect(
      await claudeMcp.status(context({ mcp_status: { response: {} } }).ctx),
    ).toEqual({ ok: false, reason: "Claude sent no list of servers" });
  });

  test("reconnect, enable and disable name the server", async () => {
    const { ctx, asked } = context({});
    await claudeMcp.act(ctx, { action: "reconnect", server: "a" });
    await claudeMcp.act(ctx, { action: "enable", server: "a" });
    await claudeMcp.act(ctx, { action: "disable", server: "a" });
    expect(asked).toEqual([
      ["mcp_reconnect", { serverName: "a" }],
      ["mcp_toggle", { serverName: "a", enabled: true }],
      ["mcp_toggle", { serverName: "a", enabled: false }],
    ]);
  });

  test("a refusal comes back as Claude wrote it", async () => {
    const { ctx } = context({
      mcp_reconnect: {
        error:
          "MCP server echo is disabled - enable it (mcp_toggle) before reconnecting",
      },
    });
    expect(
      await claudeMcp.act(ctx, { action: "reconnect", server: "echo" }),
    ).toEqual({
      ok: false,
      reason:
        "MCP server echo is disabled - enable it (mcp_toggle) before reconnecting",
    });
  });

  test("an OAuth sign-in: the page, and a redirect that can be pasted", async () => {
    const { ctx, asked } = context({
      mcp_authenticate: {
        response: {
          authUrl: "https://auth.example.com/a",
          requiresUserAction: true,
          callbackExpected: true,
          redirectScheme: "localhost",
          callbackPort: 57117,
        },
      },
    });
    expect(
      await claudeMcp.act(ctx, { action: "authenticate", server: "docs" }),
    ).toEqual({
      ok: true,
      signIn: { url: "https://auth.example.com/a", redirects: true },
    });
    expect(asked).toEqual([["mcp_authenticate", { serverName: "docs" }]]);
  });

  test("a claude.ai connector's page does not come back", async () => {
    expect(
      await claudeMcp.act(
        context({
          mcp_authenticate: {
            response: {
              authUrl: "https://claude.ai/settings/connectors",
              requiresUserAction: true,
              callbackExpected: false,
            },
          },
        }).ctx,
        { action: "authenticate", server: "linear" },
      ),
    ).toEqual({
      ok: true,
      signIn: {
        url: "https://claude.ai/settings/connectors",
        redirects: false,
      },
    });
  });

  test("a sign-in nothing was needed for, and an unusable page", async () => {
    expect(
      await claudeMcp.act(
        context({
          mcp_authenticate: {
            response: { requiresUserAction: false, callbackExpected: false },
          },
        }).ctx,
        { action: "authenticate", server: "docs" },
      ),
    ).toEqual({ ok: true, signIn: { url: null, redirects: false } });
    expect(
      await claudeMcp.act(
        context({
          mcp_authenticate: {
            response: {
              authUrl: "javascript:alert(1)",
              callbackExpected: true,
            },
          },
        }).ctx,
        { action: "authenticate", server: "docs" },
      ),
    ).toEqual({ ok: false, reason: "Claude sent no sign-in page to open" });
  });

  test("finishing a sign-in gives the address back, then reconnects", async () => {
    const { ctx, asked } = context({});
    expect(
      await claudeMcp.act(ctx, {
        action: "finish-sign-in",
        server: "docs",
        url: "http://localhost:1/callback?code=a&state=b",
      }),
    ).toEqual({ ok: true });
    expect(asked).toEqual([
      [
        "mcp_oauth_callback_url",
        {
          serverName: "docs",
          callbackUrl: "http://localhost:1/callback?code=a&state=b",
        },
      ],
      ["mcp_reconnect", { serverName: "docs" }],
    ]);
  });

  test("an address it refuses does not reconnect", async () => {
    const { ctx, asked } = context({
      mcp_oauth_callback_url: {
        error: "No active OAuth flow for server: docs",
      },
    });
    expect(
      await claudeMcp.act(ctx, {
        action: "finish-sign-in",
        server: "docs",
        url: "http://localhost:1/callback?code=a",
      }),
    ).toEqual({ ok: false, reason: "No active OAuth flow for server: docs" });
    expect(asked).toHaveLength(1);
  });

  test("signed in, but the server does not come up", async () => {
    expect(
      await claudeMcp.act(
        context({ mcp_reconnect: { error: "Server status: failed" } }).ctx,
        {
          action: "finish-sign-in",
          server: "docs",
          url: "http://localhost:1/callback?code=a",
        },
      ),
    ).toEqual({
      ok: false,
      reason: "Signed in, but it did not reconnect: Server status: failed",
    });
  });
});
