import { expect, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_CONFIG_APP_DOM_TEST !== "1") {
  test("the Android app's settings entry, in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CONFIG_APP_DOM_TEST: "1" },
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
  test("Connection offers the app's settings only inside the app", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      localStorage: browser.localStorage,
      Event: browser.Event,
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    const { ConfigurationDialog } = await import("./ConfigurationDialog");
    const { createRoot } = await import("react-dom/client");
    const { act } = React;
    const noop = () => {};
    const props = {
      theme: "dark",
      accentColor: "blue",
      uiScale: 100,
      terminalFontScale: 1,
      terminalFontName: "",
      mobileTerminalShortcuts: [],
      mobileTerminalSideShortcuts: [],
      terminalThemeSelection: { kind: "auto" },
      customTerminalThemes: [],
      blackBackground: false,
      onThemeChange: noop,
      onBlackBackgroundChange: noop,
      onAccentColorChange: noop,
      onUiScaleChange: noop,
      onTerminalFontScaleChange: noop,
      onTerminalFontNameChange: noop,
      onMobileTerminalShortcutsChange: noop,
      onMobileTerminalSideShortcutsChange: noop,
      onTerminalThemeSelectionChange: noop,
      onCustomTerminalThemesChange: noop,
      onClose: noop,
      initialTab: "Connection",
    } as unknown as React.ComponentProps<typeof ConfigurationDialog>;
    const entry = () =>
      Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Android app settings"),
      );

    const render = async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<ConfigurationDialog {...props} />);
      });
      return () => {
        act(() => root.unmount());
        container.remove();
      };
    };

    // A browser: no bridge, no entry.
    let unmount = await render();
    expect(entry()).toBeUndefined();
    unmount();

    // The app's WebView: the entry is there and calls the bridge.
    let opened = 0;
    Object.defineProperty(globalThis, "RoamgateApp", {
      value: {
        handOff: noop,
        openSettings: () => {
          opened++;
        },
      },
      configurable: true,
      writable: true,
    });
    unmount = await render();
    const button = entry();
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
    expect(opened).toBe(1);
    unmount();
  });
}
