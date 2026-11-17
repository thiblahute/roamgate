import { inIsolatedChild } from "../testIsolated";
import { expect, mock, test } from "bun:test";
import * as React from "react";

if (
  inIsolatedChild(
    import.meta.path,
    "the `!` command block in an isolated browser runtime",
    "ROAMGATE_SHELL_BLOCK_DOM_TEST",
    20_000,
  )
) {
  test("a `!` line reads as a command the user ran: where, status chip, folded output, and what Claude has of it", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      Event: browser.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    const { ShellCommandBlock } = await import("./AgentChatShell");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onStop = mock(() => {});
    const render = (props: Parameters<typeof ShellCommandBlock>[0]) =>
      React.act(async () => root.render(<ShellCommandBlock {...props} />));
    const chip = () =>
      container.querySelector(".agent-chat-shell-chip")?.className ?? null;
    const chipText = () =>
      container.querySelector(".agent-chat-shell-chip")?.textContent ?? null;
    const foot = () =>
      container.querySelector(".agent-chat-shell-claude")?.textContent ?? null;
    try {
      // Running: "You ran", where, the command as `$ ...`, a spinner with
      // the time so far, its output so far, Stop, and what Claude gets.
      const started = new Date(Date.now() - 5_000).toISOString();
      await render({
        command: " echo hi && pwd",
        stdout: "hi\n",
        status: "running",
        host: "desktop",
        cwd: "/Users/me/devel/gstreamer/gstreamer-ocio",
        startedAt: started,
        pending: true,
        onStop,
      });
      const block = container.querySelector(".agent-chat-shell")!;
      expect(block.getAttribute("aria-label")).toBe(
        "You ran: echo hi && pwd, on desktop \u00b7 ~/devel/gstreamer/gstreamer-ocio",
      );
      expect(
        container.querySelector(".agent-chat-shell-you")!.textContent,
      ).toBe("You ran");
      expect(
        container.querySelector(".agent-chat-shell-where")!.textContent,
      ).toBe("desktop \u00b7 ~/devel/gstreamer/gstreamer-ocio");
      expect(
        container.querySelector(".agent-chat-shell-head")!.textContent,
      ).toStartWith("$echo hi && pwd");
      expect(chip()).toContain("is-running");
      expect(container.querySelector("[role=status]")!.textContent).toMatch(
        /^Running 0:0[56]$/,
      );
      expect(
        container.querySelector(".agent-chat-shell-spinner"),
      ).not.toBeNull();
      expect(
        container.querySelector(".agent-chat-shell-output")!.textContent,
      ).toBe("hi\n");
      expect(foot()).toBe("Claude sees this with your next message");
      const stop = block.querySelector<HTMLButtonElement>(
        '[aria-label="Stop the command"]',
      )!;
      await React.act(async () => stop.click());
      expect(onStop).toHaveBeenCalledTimes(1);

      // Exit 0: green, no Stop, no spinner.
      await render({
        command: "ls",
        stdout: "a\nb\n",
        status: "done",
        exitCode: 0,
        startedAt: "2026-11-01T00:00:00Z",
        finishedAt: "2026-11-01T00:00:03Z",
        pending: true,
        onStop,
      });
      expect(chipText()).toBe("Exit 0");
      expect(chip()).toContain("is-ok");
      expect(
        container
          .querySelector(".agent-chat-shell-chip")!
          .getAttribute("title"),
      ).toBe("Took 0:03");
      expect(
        container.querySelector('[aria-label="Stop the command"]'),
      ).toBeNull();
      expect(container.querySelector(".agent-chat-shell-spinner")).toBeNull();
      expect(
        container
          .querySelector(".agent-chat-shell")!
          .getAttribute("aria-label"),
      ).toBe("You ran: ls, exit 0");

      // Exit N: red, stderr apart, truncation said.
      await render({
        command: "make",
        stdout: "built\n",
        stderr: "warning: x\n",
        status: "done",
        exitCode: 2,
        truncated: true,
        pending: true,
      });
      expect(chipText()).toBe("Exit 2");
      expect(chip()).toContain("is-error");
      expect(
        container.querySelector(".agent-chat-shell-stderr")!.textContent,
      ).toBe("warning: x\n");
      expect(container.textContent).toContain("Output truncated");

      await render({ command: "sleep 9", status: "stopped", pending: true });
      expect(chipText()).toBe("Stopped");
      expect(chip()).toContain("is-stopped");
      // Nothing printed: no output box, no copy, no Show all.
      expect(container.querySelector(".agent-chat-shell-output")).toBeNull();
      expect(container.querySelector(".agent-chat-shell-copy")).toBeNull();

      await render({
        command: "nope",
        status: "failed",
        error: "ssh: connection refused",
        pending: true,
      });
      expect(chipText()).toBe("Could not run");
      expect(chip()).toContain("is-error");
      expect(container.textContent).toContain("ssh: connection refused");

      // Long output folds after 12 lines; Show all opens it, and back.
      const many = Array.from(
        { length: 30 },
        (_, index) => `line ${index + 1}`,
      );
      await render({
        command: "seq 30",
        stdout: `${many.join("\n")}\n`,
        status: "done",
        exitCode: 0,
        pending: true,
      });
      const output = () => container.querySelector(".agent-chat-shell-output")!;
      expect(output().textContent).toBe(`${many.slice(0, 12).join("\n")}\n`);
      expect(output().classList.contains("is-folded")).toBe(true);
      const more = container.querySelector<HTMLButtonElement>(
        ".agent-chat-shell-more",
      )!;
      expect(more.textContent).toBe("Show all 30 lines");
      expect(more.getAttribute("aria-expanded")).toBe("false");
      await React.act(async () => more.click());
      expect(output().textContent).toBe(`${many.join("\n")}\n`);
      expect(output().classList.contains("is-folded")).toBe(false);
      expect(more.textContent).toBe("Show less");
      await React.act(async () => more.click());
      expect(output().textContent?.split("\n")).toHaveLength(13);
      expect(container.querySelector(".agent-chat-shell-copy")).not.toBeNull();

      // Folded while it runs: the latest lines.
      await render({
        command: "seq 30",
        stdout: `${many.join("\n")}\n`,
        stderr: "oops\n",
        status: "running",
        pending: true,
      });
      expect(output().textContent).toBe(`${many.slice(19).join("\n")}\noops\n`);
      expect(
        container.querySelector(".agent-chat-shell-stderr")!.textContent,
      ).toBe("oops\n");

      // Sent with a message (read back from the transcript): said so, and
      // no exit code unless the browser saw it end.
      await render({
        command: " glab auth login",
        stderr: "ERROR\n",
        host: "desktop",
        cwd: "/srv/app",
        sent: true,
      });
      expect(
        container
          .querySelector(".agent-chat-shell")!
          .getAttribute("data-status"),
      ).toBe("recorded");
      expect(chip()).toBeNull();
      expect(foot()).toBe("Sent to Claude with your message");
      expect(container.textContent).not.toContain("next message");
      expect(
        container.querySelector('[aria-label="Stop the command"]'),
      ).toBeNull();
      await render({
        command: "ls",
        status: "done",
        exitCode: 1,
        sent: true,
      });
      expect(chipText()).toBe("Exit 1");
      expect(foot()).toBe("Sent to Claude with your message");
    } finally {
      await React.act(async () => root.unmount());
      await browser.happyDOM.close();
    }
  });
}
