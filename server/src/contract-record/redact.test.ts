import { describe, expect, it } from "bun:test";
import { Redactor, sensitiveKey } from "./redact";

const TAG = /^\[redacted:[0-9a-f]{8}\]$/;

describe("contract record redaction", () => {
  it("knows credential keys without catching counts and ids", () => {
    for (const key of [
      "password",
      "pin",
      "token",
      "call_token",
      "sessionToken",
      "session_secret",
      "cookie",
      "Set-Cookie",
      "authorization",
      "p256dh",
      "auth",
      "api_key",
    ])
      expect(sensitiveKey(key)).toBe(true);
    for (const key of [
      "input_tokens",
      "max_tokens",
      "pinned",
      "id",
      "terminal_id",
      "coalesce_key",
      "code",
    ])
      expect(sensitiveKey(key)).toBe(false);
  });

  it("redacts values under credential keys, keeping their types", () => {
    const redactor = new Redactor();
    const out = redactor.value({
      method: "auth.login",
      params: { password: "hunter2hunter2", pin: 123456, keep: true },
      nested: { credentials: { user: "me", secret: "s3cr3t" } },
    }) as {
      params: Record<string, unknown>;
      nested: { credentials: Record<string, unknown> };
      method: string;
    };
    expect(out.method).toBe("auth.login");
    expect(out.params.password).toMatch(TAG);
    expect(out.params.pin).toBe(0);
    expect(out.params.keep).toBe(true);
    expect(out.nested.credentials.user).toMatch(TAG);
  });

  it("gives equal secrets equal tags within a process only", () => {
    const one = new Redactor();
    const two = new Redactor();
    expect(one.tag("abc")).toBe(one.tag("abc"));
    expect(one.tag("abc")).not.toBe(one.tag("abd"));
    expect(one.tag("abc")).not.toBe(two.tag("abc"));
  });

  it("finds credentials inside free text", () => {
    const redactor = new Redactor();
    const text = [
      "Authorization: Bearer abcdefghijklmnop",
      "glpat-ABCDEFGHIJKLMNOPQRST",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWX",
      "sk-ant-api03-ABCDEFGHIJKLMNOP",
      "https://me:pa55word@example.com/repo.git",
      "https://host/x?token=abcdef&page=2",
      "/rendered/AbCdEfGhIjKlMnOpQrSt/index.html",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlX2hlcmU",
      "https://fcm.googleapis.com/fcm/send/abc:def",
    ].join("\n");
    const out = redactor.string(text);
    for (const secret of [
      "abcdefghijklmnop",
      "glpat-ABCDEF",
      "ghp_ABCDEF",
      "sk-ant-api03",
      "pa55word",
      "token=abcdef",
      "AbCdEfGhIjKlMnOpQrSt",
      "eyJhbGciOiJIUzI1NiJ9",
      "fcm/send/abc",
    ])
      expect(out).not.toContain(secret);
    expect(out).toContain("page=2");
    expect(out).toContain("https://me:[redacted:");
  });

  it("leaves ordinary prose alone", () => {
    const redactor = new Redactor();
    const prose =
      "Basic understanding of global-settings-and-other-things and the risk-assessment-framework";
    expect(redactor.string(prose)).toBe(prose);
  });

  it("redacts the exact secrets it is given", () => {
    const redactor = new Redactor();
    redactor.addSecret("my-server-password");
    redactor.addSecret("abc"); // too short to look for
    expect(redactor.string("login with my-server-password now")).toMatch(
      /^login with \[redacted:[0-9a-f]{8}\] now$/,
    );
    expect(redactor.string("abc")).toBe("abc");
  });

  it("keeps only the length of terminal bytes and keystrokes", () => {
    const redactor = new Redactor();
    const frame = redactor.value({
      terminal: { terminal_id: "t1", bytes: "aGVsbG8=" },
    }) as { terminal: Record<string, unknown> };
    expect(frame.terminal).toEqual({
      terminal_id: "t1",
      bytes: "[terminal:8]",
    });
    const input = redactor.message({
      id: 3,
      method: "terminal.input",
      params: { terminal_id: "t1", data: "cGFzc3dvcmQK" },
    }) as { params: Record<string, unknown> };
    expect(input.params).toEqual({ terminal_id: "t1", data: "[terminal:12]" });
  });

  it("cuts long strings and long base64", () => {
    const redactor = new Redactor({ maxString: 10 });
    expect(redactor.string("x".repeat(25))).toBe("xxxxxxxxxx...[+15]");
    expect(redactor.string("QUJD".repeat(20))).toBe("[base64:80]");
  });

  it("redacts headers, query parameters and forms", () => {
    const redactor = new Redactor();
    const headers = redactor.headers(
      new Headers({ cookie: "roamgate_session=abc", accept: "text/html" }),
    );
    expect(headers.cookie).toMatch(TAG);
    expect(headers.accept).toBe("text/html");
    const url = redactor.url(
      new URL("http://h/api/voice/call/signalling?call=3&call_token=xyz"),
    );
    expect(url.path).toBe("/api/voice/call/signalling");
    expect(url.query?.call).toBe("3");
    expect(url.query?.call_token).toMatch(TAG);
    const form = redactor.form(
      "pane=p1&input=%7B%22command%22%3A%22ls%22%7D&token=zzz&tag=a&tag=b",
    );
    expect(form.pane).toBe("p1");
    expect(form.input).toEqual({ command: "ls" });
    expect(form.token).toMatch(TAG);
    expect(form.tag).toEqual(["a", "b"]);
  });
});
