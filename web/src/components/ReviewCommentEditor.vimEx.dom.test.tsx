import { expect, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_VIM_EX_DOM_TEST !== "1") {
  test("Vim ex commands in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_VIM_EX_DOM_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 15_000);
} else {
  test("each editor's :w and :q act on that editor", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      Text: browser.Text,
      Event: browser.Event,
      MutationObserver: browser.MutationObserver,
      getSelection: () => browser.getSelection(),
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(0), 0),
      cancelAnimationFrame: (id: number) => clearTimeout(id),
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    const { ComposerVimEditor } = await import("./ComposerVimEditor");
    const { ReviewCommentEditor } = await import("./ReviewCommentEditor");
    const { getCM, Vim } = await import("@replit/codemirror-vim");
    const { EditorView } = await import("@codemirror/view");
    const { createRoot } = await import("react-dom/client");
    const cmIn = (container: HTMLElement) =>
      getCM(
        EditorView.findFromDOM(
          container.querySelector(".cm-editor") as HTMLElement,
        )!,
      )! as Parameters<typeof Vim.handleEx>[0];

    // The chat's message box loads first, then a review comment editor.
    const chat = document.createElement("div");
    const comment = document.createElement("div");
    document.body.append(chat, comment);
    const chatRoot = createRoot(chat);
    const commentRoot = createRoot(comment);
    let sent = 0;
    const done: string[] = [];
    await React.act(async () =>
      chatRoot.render(
        <ComposerVimEditor
          value="hello"
          selection={null}
          placeholder="Message"
          label="Message"
          enterSends
          onChange={() => {}}
          onSelect={() => {}}
          onSubmit={() => sent++}
          onPasteImages={() => {}}
          onComposingChange={() => {}}
        />,
      ),
    );
    await React.act(async () =>
      commentRoot.render(
        <ReviewCommentEditor
          value="a comment"
          vimMode
          placeholder="Comment"
          onChange={() => {}}
          onCommit={(explicit) => done.push(`commit ${explicit}`)}
          onCancel={() => done.push("cancel")}
          onSuggest={() => done.push("suggest")}
        />,
      ),
    );

    Vim.handleEx(cmIn(chat), "w");
    expect(sent).toBe(1);
    expect(done).toEqual([]);

    Vim.handleEx(cmIn(comment), "w");
    Vim.handleEx(cmIn(comment), "sugg");
    Vim.handleEx(cmIn(comment), "q");
    expect(done).toEqual(["commit true", "suggest", "cancel"]);
    expect(sent).toBe(1);

    // An editor with its own command line defines its words later, `q`
    // among them: each editor keeps its own `:q`.
    const { vim } = await import("@replit/codemirror-vim");
    const { defineExCommands, vimExEditors } = await import("./vimEx");
    const own = document.createElement("div");
    document.body.append(own);
    const ownView = new EditorView({ parent: own, extensions: [vim()] });
    const lines: string[] = [];
    vimExEditors.set(getCM(ownView)!, (input) => lines.push(input));
    defineExCommands(["files", "q", "quit"]);
    done.length = 0;
    Vim.handleEx(cmIn(own), "files a.c");
    Vim.handleEx(cmIn(own), "q");
    Vim.handleEx(cmIn(comment), "q");
    Vim.handleEx(cmIn(comment), "quit");
    Vim.handleEx(cmIn(comment), "files");
    expect(lines).toEqual(["files a.c", "q"]);
    expect(done).toEqual(["cancel", "cancel"]);
    ownView.destroy();

    await React.act(async () => {
      commentRoot.unmount();
      chatRoot.unmount();
    });
  });
}
