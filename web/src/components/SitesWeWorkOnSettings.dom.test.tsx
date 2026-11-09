import { expect, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_SITES_SETTINGS_DOM_TEST !== "1") {
  test("sites we work on in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_SITES_SETTINGS_DOM_TEST: "1" },
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
  }, 20_000);
} else {
  test("the list is shown, added to normalized, and removed from", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      HTMLInputElement: browser.HTMLInputElement,
      Element: browser.Element,
      Node: browser.Node,
      Event: browser.Event,
      MouseEvent: browser.MouseEvent,
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    const { SitesWeWorkOnSettings } = await import("./SitesWeWorkOnSettings");
    const { createRoot } = await import("react-dom/client");
    const saved: string[][] = [];
    const savedRoots: Record<string, string>[] = [];
    const container = browser.document.createElement("div");
    browser.document.body.appendChild(container);
    const root = createRoot(container as unknown as HTMLElement);
    await React.act(async () => {
      root.render(
        <SitesWeWorkOnSettings
          load={async () => ["http://localhost:8080/"]}
          save={async (sites) => {
            saved.push(sites);
            return sites;
          }}
          loadRoots={async () => ({})}
          saveRoots={async (roots) => {
            savedRoots.push(roots);
            return roots;
          }}
        />,
      );
    });
    expect(container.textContent).toContain("http://localhost:8080/");
    const input = container.querySelector(
      "#sites-settings-new",
    ) as unknown as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(
      browser.HTMLInputElement.prototype,
      "value",
    )!.set!;
    await React.act(async () => {
      setValue.call(input, "javascript:alert(1)");
      input.dispatchEvent(
        new browser.Event("input", { bubbles: true }) as unknown as Event,
      );
    });
    expect(container.textContent).toContain(
      "An http(s) URL or an absolute directory.",
    );
    await React.act(async () => {
      setValue.call(input, "http://desktop:4000/docs/index.html");
      input.dispatchEvent(
        new browser.Event("input", { bubbles: true }) as unknown as Event,
      );
    });
    expect(container.textContent).toContain("Adds http://desktop:4000/docs/");
    await React.act(async () => {
      (
        container.querySelector("form") as unknown as HTMLFormElement
      ).requestSubmit();
    });
    expect(saved[saved.length - 1]).toEqual([
      "http://localhost:8080/",
      "http://desktop:4000/docs/",
    ]);
    // A root of its own: one that does not contain the site is refused.
    const rootInput = container.querySelector(
      'input[aria-label="Root of http://desktop:4000/docs/"]',
    ) as unknown as HTMLInputElement;
    const typeRoot = async (value: string) => {
      await React.act(async () => {
        setValue.call(rootInput, value);
        rootInput.dispatchEvent(
          new browser.Event("input", { bubbles: true }) as unknown as Event,
        );
      });
      await React.act(async () => {
        rootInput.dispatchEvent(
          new browser.KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
          }) as unknown as Event,
        );
      });
    };
    await typeRoot("http://desktop:4000/other/");
    expect(savedRoots).toEqual([]);
    expect(container.textContent).toContain("contains it");
    await typeRoot("http://desktop:4000");
    expect(savedRoots).toEqual([
      { "http://desktop:4000/docs/": "http://desktop:4000/" },
    ]);
    expect(rootInput.value).toBe("http://desktop:4000/");
    await typeRoot("");
    expect(savedRoots[savedRoots.length - 1]).toEqual({});
    await React.act(async () => {
      (
        container.querySelector(
          'button[aria-label="Remove http://localhost:8080/"]',
        ) as unknown as HTMLButtonElement
      ).click();
    });
    expect(saved[saved.length - 1]).toEqual(["http://desktop:4000/docs/"]);
    await React.act(async () => root.unmount());
  });
}
