import { inIsolatedChild } from "../testIsolated";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type {
  AgentChatModelResult,
  AgentChatModels,
} from "../../../shared/agentChat";
import { modelSheetRows } from "./AgentModelSheet";

test("the filter keeps matching rows, and offers a typed name the list lacks", () => {
  const models = [
    { value: "default", label: "Default", description: "Opus 5.5" },
    { value: "sonnet", label: "Sonnet", description: "Sonnet 5.5" },
  ];
  expect(modelSheetRows(models, "")).toEqual(models);
  expect(modelSheetRows(models, "opus")).toEqual([
    models[0],
    { value: "opus", label: "opus", typed: true },
  ]);
  expect(modelSheetRows(models, "Sonnet")).toEqual([models[1]]);
  // Not a model name: nothing to switch to.
  expect(modelSheetRows(models, "two words")).toEqual([]);
});

if (
  inIsolatedChild(
    import.meta.path,
    "model sheet interactions in an isolated DOM runtime",
    "ROAMGATE_MODEL_SHEET_DOM_TEST",
    15_000,
  )
) {
  await registerTests();
}

async function registerTests() {
  const browser = new Window({ url: "http://localhost" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "Element",
    "Node",
    "Event",
    "KeyboardEvent",
    "MouseEvent",
    "PointerEvent",
  ] as const) {
    Object.defineProperty(globalThis, key, {
      value: key === "window" ? browser : browser[key],
      writable: true,
      configurable: true,
    });
  }
  Object.assign(globalThis, {
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  // happy-dom has no layout: nothing to scroll to.
  Object.defineProperty(browser.HTMLElement.prototype, "scrollIntoView", {
    value: () => {},
    configurable: true,
  });
  const { act, createElement: h } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { AgentModelSheet } = await import("./AgentModelSheet");

  let root: Root | null = null;
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
    await browser.happyDOM.whenAsyncComplete();
  });
  afterAll(async () => browser.happyDOM.close());

  const LISTED: AgentChatModels = {
    models: [
      {
        value: "default",
        label: "Default (recommended)",
        resolved: "claude-opus-5-5",
      },
      { value: "sonnet", label: "Sonnet", resolved: "claude-sonnet-5-5" },
      { value: "haiku", label: "Haiku", resolved: "claude-haiku-5-5" },
    ],
    current: "claude-sonnet-5-5",
    chosen: "sonnet",
    source: "agent",
  };

  async function open(
    pick: (model: string) => Promise<AgentChatModelResult>,
    listed: AgentChatModels = LISTED,
  ) {
    const onPick = mock(pick);
    const onClose = mock(() => {});
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        h(AgentModelSheet, {
          load: async () => listed,
          onPick,
          onClose,
        }),
      ),
    );
    await act(async () => browser.happyDOM.whenAsyncComplete());
    const rows = () => [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".agent-model-list button",
      ),
    ];
    const press = async (key: string) =>
      act(async () => {
        container
          .querySelector(".agent-model-sheet")!
          .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        await browser.happyDOM.whenAsyncComplete();
      });
    return { container, rows, onPick, onClose, press };
  }

  test("the model it runs is marked and under the cursor; Enter switches and closes", async () => {
    const { rows, onPick, onClose, press } = await open(async () => ({
      ok: true,
      model: "claude-haiku-5-5",
    }));
    expect(rows().map((row) => row.getAttribute("aria-current"))).toEqual([
      null,
      "true",
      null,
    ]);
    expect(rows()[1]!.className).toBe("is-cursor");
    await press("ArrowDown");
    await press("Enter");
    expect(onPick).toHaveBeenCalledWith("haiku");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a refusal stays in the sheet; Escape closes it", async () => {
    const { container, rows, onClose, press } = await open(async () => ({
      ok: false,
      reason: "Model 'haiku' not found",
    }));
    await act(async () => rows()[2]!.click());
    await act(async () => browser.happyDOM.whenAsyncComplete());
    expect(container.querySelector(".agent-model-refusal")?.textContent).toBe(
      "Model 'haiku' not found",
    );
    expect(onClose).not.toHaveBeenCalled();
    await press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("the profile's list error is said, and a disabled row cannot be picked", async () => {
    const { container, rows, onPick } = await open(
      async () => ({ ok: true, model: null }),
      {
        ...LISTED,
        models: [
          ...LISTED.models,
          { value: "fable", label: "Fable", disabled: true },
        ],
        error: "Could not list the models: the server answered 401",
      },
    );
    expect(container.querySelector(".agent-model-note")?.textContent).toBe(
      "Could not list the models: the server answered 401",
    );
    const fable = rows()[3]!;
    expect(fable.disabled).toBe(true);
    await act(async () => fable.click());
    expect(onPick).not.toHaveBeenCalled();
  });
}
