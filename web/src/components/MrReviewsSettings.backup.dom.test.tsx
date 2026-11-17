import { expect, test } from "bun:test";

if (process.env.ROAMGATE_MR_BACKUP_DOM_TEST !== "1") {
  test("the Reviews export and import, in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_MR_BACKUP_DOM_TEST: "1" },
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
  test("export downloads, import previews then applies", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({
      url: "http://localhost/",
      width: 1280,
      height: 800,
    });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      HTMLInputElement: browser.HTMLInputElement,
      Element: browser.Element,
      Node: browser.Node,
      NodeFilter: browser.NodeFilter,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      MutationObserver: browser.MutationObserver,
      Event: browser.Event,
      CustomEvent: browser.CustomEvent,
      KeyboardEvent: browser.KeyboardEvent,
      MouseEvent: browser.MouseEvent,
      CSS: { escape: (value: string) => value.replace(/["\\]/g, "\\$&") },
      getComputedStyle: browser.getComputedStyle.bind(browser),
      requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    (browser.HTMLElement.prototype as any).scrollIntoView = () => {};
    localStorage.setItem("roamgate:mrReviewsFilter", "mine");

    const React = await import("react");
    const { act } = React;
    const { bridge } = await import("../api");
    const calls: [string, Record<string, unknown>][] = [];
    (bridge as any).call = async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push([method, params]);
      if (method === "bridge.mr_reviews.export") return { text: "{}" };
      if (method === "bridge.mr_reviews.import")
        return params.apply
          ? { applied: true, changes: [] }
          : {
              applied: false,
              changes: [
                {
                  path: "mr_reviews.views[media]",
                  kind: "changed",
                  newerLocal: true,
                },
                { path: "mr_reviews.order", kind: "changed" },
              ],
            };
      return {};
    };
    const urls: string[] = [];
    (URL as any).createObjectURL = () => {
      urls.push("blob:x");
      return "blob:x";
    };
    (URL as any).revokeObjectURL = () => {};
    const { createRoot } = await import("react-dom/client");
    const { MrReviewsBackup } = await import("./MrReviewsSettings");
    const host = document.createElement("div");
    document.body.append(host);
    let imported = 0;
    await act(async () =>
      createRoot(host).render(
        <MrReviewsBackup onImported={() => imported++} />,
      ),
    );
    const button = (label: string) =>
      [...host.querySelectorAll("button")].find(
        (each) => each.textContent === label,
      )!;
    await act(async () => {
      button("Export").click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(calls[0]).toEqual(["bridge.mr_reviews.export", {}]);
    expect(urls).toHaveLength(1);
    const input = host.querySelector<HTMLInputElement>("input[type=file]")!;
    const file = new browser.File(['{"format":"roamgate-reviews"}'], "r.json", {
      type: "application/json",
    });
    Object.defineProperty(input, "files", {
      value: [file],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(calls[1]).toEqual([
      "bridge.mr_reviews.import",
      { text: '{"format":"roamgate-reviews"}' },
    ]);
    const preview = host.querySelector(".mr-reviews-import-preview")!;
    expect(preview.textContent).toContain(
      "r.json: 2 changes, 1 where yours is newer",
    );
    expect(preview.querySelector(".is-newer")?.textContent).toContain(
      "mr_reviews.views[media]",
    );
    expect(imported).toBe(0);
    await act(async () => {
      button("Apply").click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(calls[2]).toEqual([
      "bridge.mr_reviews.import",
      { text: '{"format":"roamgate-reviews"}', apply: true },
    ]);
    expect(imported).toBe(1);
    expect(host.textContent).toContain("Imported 2 changes");
  });
}
