import { expect, mock, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_COMPOSER_ATTACH_DOM_TEST !== "1") {
  test("the message box's Attach menu: camera, photos and files, in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_COMPOSER_ATTACH_DOM_TEST: "1" },
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
  test("Attach takes a photo, photos or any file; files go up as files and the message carries their paths", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    let coarsePointer = true;
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      Event: browser.Event,
      KeyboardEvent: browser.KeyboardEvent,
      IS_REACT_ACT_ENVIRONMENT: true,
      matchMedia: (query: string) => ({
        matches: query === "(pointer: coarse)" && coarsePointer,
      }),
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    const { readTerminalComposerDraft, terminalComposerDraftKey } =
      await import("../terminalComposer");
    const { AgentHistoryComposer } = await import("./AgentHistoryComposer");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const draftKey = terminalComposerDraftKey("local", 1, "pane-attach");
    const send = mock<(text: string) => Promise<void>>(async () => {});
    const errors: string[] = [];
    const uploadImage = mock<(file: File) => Promise<string>>(
      async (file) => `/tmp/roamgate-uploads-1/upload-i/img-${file.size}.png`,
    );
    // The host keeps the name, made safe.
    const uploadFile = mock<(file: File) => Promise<string>>(
      async (file) =>
        `/tmp/roamgate-uploads-1/upload-f/${file.name.replace(/[^A-Za-z0-9._+-]/g, "_")}`,
    );
    const render = (
      props: { image?: boolean; file?: boolean } = { image: true, file: true },
    ) =>
      React.act(async () =>
        root.render(
          <AgentHistoryComposer
            draftKey={draftKey}
            agent="claude"
            status="idle"
            onSend={send}
            onUploadImage={props.image ? uploadImage : undefined}
            onUploadFile={props.file ? uploadFile : undefined}
            onError={(message) => errors.push(message)}
            vimKeys={false}
          />,
        ),
      );
    const attach = () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Attach"]');
    const items = () =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
      ).map((item) => item.textContent);
    const openMenu = () => React.act(async () => attach()!.click());
    const input = (name: "camera" | "files") =>
      container.querySelector<HTMLInputElement>(
        `input[data-attach="${name}"]`,
      )!;
    const choose = (picker: HTMLInputElement, files: File[]) =>
      React.act(async () => {
        Object.defineProperty(picker, "files", {
          value: files,
          configurable: true,
        });
        picker.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
    const textarea = () => container.querySelector("textarea")!;
    // Spaces between attachments are not the point here.
    const squeeze = (text: string) => text.replace(/ +/g, " ");
    const draftNow = () => squeeze(readTerminalComposerDraft(draftKey));
    const shown = () => squeeze(textarea().value);
    try {
      // A phone: one Attach button, on the box first of its buttons (no
      // line of its own under it), and its menu.
      await render();
      expect(attach()).not.toBeNull();
      expect(
        attach()!.closest(".agent-history-composer-inline")?.firstElementChild,
      ).toBe(attach()!.parentElement);
      expect(
        attach()!.closest(".agent-history-composer-field")?.className,
      ).toContain("has-attach");
      expect(container.querySelector('[role="menu"]')).toBeNull();
      await openMenu();
      expect(attach()!.getAttribute("aria-expanded")).toBe("true");
      expect(items()).toEqual(["Take photo", "Photos", "Files"]);

      // Take photo: the camera, straight to a photo.
      const camera = input("camera");
      expect(camera.accept).toBe("image/*");
      expect(camera.getAttribute("capture")).toBe("environment");
      const cameraClick = mock(() => {});
      camera.addEventListener("click", cameraClick);
      await React.act(async () =>
        Array.from(
          container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
        )
          .find((item) => item.textContent === "Take photo")!
          .click(),
      );
      expect(cameraClick).toHaveBeenCalledTimes(1);
      // A camera's photo without a type is still an image.
      await choose(camera, [new File(["12345"], "image.jpg")]);
      expect(uploadImage).toHaveBeenCalledTimes(1);
      expect(uploadFile).not.toHaveBeenCalled();
      expect(draftNow()).toBe("/tmp/roamgate-uploads-1/upload-i/img-5.png ");
      expect(shown()).toBe("[Image #1] ");

      // Files: any type, several; an image among them still goes as one.
      const files = input("files");
      expect(files.accept).toBe("");
      expect(files.multiple).toBe(true);
      await choose(files, [
        new File(["%PDF-1.4"], "My Report.pdf", { type: "application/pdf" }),
        new File(["notes"], "notes.txt", { type: "text/plain" }),
        new File(["123"], "shot.png", { type: "image/png" }),
      ]);
      expect(uploadFile.mock.calls.map(([file]) => file.name)).toEqual([
        "My Report.pdf",
        "notes.txt",
      ]);
      expect(uploadImage).toHaveBeenCalledTimes(2);
      expect(draftNow()).toBe(
        "/tmp/roamgate-uploads-1/upload-i/img-5.png " +
          "/tmp/roamgate-uploads-1/upload-f/My_Report.pdf " +
          "/tmp/roamgate-uploads-1/upload-f/notes.txt " +
          "/tmp/roamgate-uploads-1/upload-i/img-3.png ",
      );
      // Short in the box, images and files numbered apart.
      expect(shown()).toBe("[Image #1] [File #1] [File #2] [Image #2] ");
      // Chips: the files by their own names, removable.
      const chips = Array.from(
        container.querySelectorAll(
          ".agent-history-composer-attachments > span.is-file",
        ),
      );
      expect(chips.map((chip) => chip.textContent)).toEqual([
        "My Report.pdf",
        "notes.txt",
      ]);
      await React.act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            '[aria-label="Remove file notes.txt"]',
          )!
          .click(),
      );
      expect(readTerminalComposerDraft(draftKey)).not.toContain("notes.txt");
      expect(shown()).toBe("[Image #1] [File #1] [Image #2] ");

      // Sent: the message carries the paths, for the agent to read.
      await React.act(async () =>
        container
          .querySelector<HTMLButtonElement>(".agent-history-composer-send")!
          .click(),
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0]).toContain(
        "/tmp/roamgate-uploads-1/upload-f/My_Report.pdf",
      );
      expect(send.mock.calls[0]?.[0]).toContain(
        "/tmp/roamgate-uploads-1/upload-i/img-5.png",
      );

      // A pasted file that is not an image goes up as a file too.
      const event = new window.Event("paste", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "clipboardData", {
        value: {
          files: [new File(["a,b"], "data.csv", { type: "text/csv" })],
          items: [],
        },
      });
      await React.act(async () => textarea().dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
      expect(
        uploadFile.mock.calls[uploadFile.mock.calls.length - 1]?.[0].name,
      ).toBe("data.csv");
      expect(draftNow()).toBe("/tmp/roamgate-uploads-1/upload-f/data.csv ");

      // A failed upload says which file and why.
      uploadFile.mockImplementationOnce(async () => {
        throw new Error("file too large (>104857600 bytes)");
      });
      await choose(files, [new File(["x"], "big.iso")]);
      expect(errors[errors.length - 1]).toBe(
        "big.iso did not upload: file too large (>104857600 bytes)",
      );

      // A desktop: no camera in the menu.
      coarsePointer = false;
      await render();
      await openMenu();
      expect(items()).toEqual(["Photos", "Files"]);
      // Esc closes it.
      await React.act(async () =>
        document.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Escape" }),
        ),
      );
      expect(container.querySelector('[role="menu"]')).toBeNull();

      // A box that takes images only (the companion's): Attach is there,
      // without Files.
      coarsePointer = true;
      await render({ image: true });
      await openMenu();
      expect(items()).toEqual(["Take photo", "Photos"]);
      // A box that takes files only still has Attach.
      await render({ file: true });
      expect(attach()).not.toBeNull();
      // One that takes nothing has none.
      await render({});
      expect(attach()).toBeNull();
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
    }
  });
}

test("on a phone, Attach stays on the box at rest; only Esc and a disabled Send hide", async () => {
  const css = await Bun.file(
    new URL("../styles/layout/mobile-nav.css", import.meta.url),
  ).text();
  const head = css.indexOf("/* Not writing, and nothing in the box");
  expect(head).toBeGreaterThanOrEqual(0);
  const rule = css.slice(head, css.indexOf("}", head));
  expect(rule).toContain("display: none;");
  expect(rule).toContain(".agent-history-composer-escape");
  expect(rule).not.toContain(".agent-history-composer-attach");
});
