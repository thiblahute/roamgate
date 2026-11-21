import { expect, mock, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_DICTATION_DOM_TEST !== "1") {
  test("Dictate on comment boxes and every text box in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_DICTATION_DOM_TEST: "1" },
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
  }, 30_000);
} else {
  test("the message box's Dictate on a comment editor and on the focused text box", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      HTMLInputElement: browser.HTMLInputElement,
      HTMLTextAreaElement: browser.HTMLTextAreaElement,
      Element: browser.Element,
      Node: browser.Node,
      Text: browser.Text,
      Event: browser.Event,
      FocusEvent: browser.FocusEvent,
      KeyboardEvent: browser.KeyboardEvent,
      MutationObserver: browser.MutationObserver,
      getSelection: () => browser.getSelection(),
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(0), 0),
      cancelAnimationFrame: (id: number) => clearTimeout(id),
      IS_REACT_ACT_ENVIRONMENT: true,
      matchMedia: () => ({ matches: false }),
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    // The voice socket is not there: Dictate's start and finish are stubs.
    let said = { text: "hello there", cleaned: true } as {
      text: string;
      cleaned: boolean;
      nothingHeard?: boolean;
    };
    const finish = mock(async () => said);
    const targets: unknown[] = [];
    const startDictation = mock(
      async (
        target: unknown,
        _onHeard: (text: string) => void,
        onLoading?: (loading: boolean) => void,
      ) => {
        targets.push(target);
        onLoading?.(true);
        return { finish, cancel: () => {} };
      },
    );
    const real = await import("../dictation");
    mock.module("../dictation", () => ({ ...real, startDictation }));
    const engine = await import("../speechEngine");
    mock.module("../speechEngine", () => ({
      ...engine,
      useSpeechEngine: () => ({ listen: true }),
    }));
    const { ReviewCommentEditor } = await import("./ReviewCommentEditor");
    const { default: FieldDictation } = await import("./FieldDictation");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const click = (button: HTMLButtonElement) =>
      React.act(async () => {
        button.click();
      });
    try {
      // A comment editor: the microphone on it; the words go in at the
      // cursor, the loading models said meanwhile.
      let comment = "";
      await React.act(async () =>
        root.render(
          <ReviewCommentEditor
            value="I think"
            vimMode={false}
            placeholder="Reply"
            onChange={(text) => {
              comment = text;
            }}
            onCommit={() => {}}
            onCancel={() => {}}
            onSuggest={() => {}}
          />,
        ),
      );
      const onEditor = () =>
        container.querySelector<HTMLButtonElement>(
          ".rc-editor-box > .dictation-button",
        );
      expect(onEditor()?.title).toBe("Dictate");
      expect(onEditor()?.querySelector(".lucide-mic")).not.toBeNull();
      await click(onEditor()!);
      expect(targets[0]).toMatchObject({
        kind: "text",
        hint: "Reply",
        before: "I think",
        after: "",
      });
      expect(
        container.querySelector(".rc-editor-box .dictation-status")
          ?.textContent,
      ).toContain("Loading the voice models");
      expect(onEditor()?.getAttribute("aria-pressed")).toBe("true");
      await click(onEditor()!);
      expect(comment).toBe("I think hello there");
      expect(container.querySelector(".dictation-status")).toBeNull();

      // Nothing heard: said so, nothing typed.
      said = { text: "", cleaned: false, nothingHeard: true };
      await click(onEditor()!);
      await click(onEditor()!);
      expect(comment).toBe("I think hello there");
      expect(
        container.querySelector(".dictation-status.is-error")?.textContent,
      ).toBe("Nothing was heard");
      said = { text: "hello there", cleaned: true };

      // Any other box: the microphone shows on the focused one, and the
      // words reach its onChange at the cursor.
      let title = "";
      const Form = () => {
        const [value, setValue] = React.useState("Fix the  bug");
        title = value;
        return (
          <>
            <input
              aria-label="Title"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            <input aria-label="Filter" data-dictation="off" />
            <input aria-label="Count" type="number" />
            <FieldDictation />
          </>
        );
      };
      await React.act(async () => root.render(<Form />));
      const floating = () =>
        document.querySelector<HTMLButtonElement>(
          ".field-dictation-button .dictation-button",
        );
      expect(floating()).toBeNull();
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Title"]',
      )!;
      await React.act(async () => {
        input.focus();
        input.setSelectionRange(8, 8);
      });
      expect(floating()?.title).toBe("Dictate");
      expect(input.classList.contains("has-field-dictation")).toBe(true);
      await click(floating()!);
      expect(targets[targets.length - 1]).toMatchObject({
        kind: "text",
        hint: "Title",
        before: "Fix the ",
        after: " bug",
      });
      await click(floating()!);
      expect(title).toBe("Fix the hello there bug");
      expect(input.selectionStart).toBe(19);

      // Not on a box that wants none, nor on a number.
      for (const label of ["Filter", "Count"]) {
        await React.act(async () => {
          container
            .querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
            .focus();
        });
        expect(floating()).toBeNull();
      }
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
    }
  });
}
