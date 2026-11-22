import { expect, mock, test } from "bun:test";
import { inIsolatedChild } from "../testIsolated";

/**
 * The one root of the board view: a mode's shortcut opens the view on
 * that mode, closes it when it shows it, switches it when it shows the
 * other; the Work board opens on an item; the plain toggle closes.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "the board view's root and its mode toggles, in an isolated DOM runtime",
    "ROAMGATE_MR_REVIEWS_ROOT_MODES_TEST",
    30_000,
  )
) {
  const { installTestDom } = await import("../testDom");
  installTestDom({ url: "http://localhost/", width: 1280 });
  const React = await import("react");
  const { act } = React;
  const renders: { mode?: string; modeAt?: number; item?: string }[] = [];
  /** The shown view's close, as the panel calls it. */
  let closeShown:
    | ((options?: { keepFocus?: boolean; resume?: { item?: string } }) => void)
    | null = null;
  mock.module("./MrReviewsPanel", () => ({
    storedBoardMode: () => "mr",
    MrReviewsPanel: (props: {
      mode?: "mr" | "work";
      modeAt?: number;
      initialWorkItem?: string;
      onMode?: (mode: "mr" | "work") => void;
      onClose: NonNullable<typeof closeShown>;
    }) => {
      closeShown = props.onClose;
      const [mode, setMode] = React.useState(props.mode ?? "mr");
      React.useEffect(() => {
        if (props.mode) setMode(props.mode);
      }, [props.mode, props.modeAt]);
      React.useEffect(() => props.onMode?.(mode), [mode, props.onMode]);
      renders.push({
        mode: props.mode,
        modeAt: props.modeAt,
        item: props.initialWorkItem,
      });
      return (
        <aside
          className="mr-reviews-panel"
          data-mode={mode}
          data-item={props.initialWorkItem ?? ""}
        />
      );
    },
  }));
  const { showMrReviews, toggleMrReviews, closeMrReviews, shownBoardMode } =
    await import("./MrReviewsRoot");
  const panel = () =>
    document.querySelector<HTMLElement>(".mr-reviews-root .mr-reviews-panel");
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

  test("a mode's toggle opens, switches or closes; an item opens the Work board on it", async () => {
    expect(shownBoardMode()).toBeNull();
    await act(async () => toggleMrReviews("work"));
    await settle();
    expect(panel()?.dataset.mode).toBe("work");
    expect(shownBoardMode()).toBe("work");
    // The other mode's shortcut switches, in place.
    await act(async () => toggleMrReviews("mr"));
    await settle();
    expect(panel()?.dataset.mode).toBe("mr");
    expect(shownBoardMode()).toBe("mr");
    // Asked again for the mode shown: closed.
    await act(async () => toggleMrReviews("mr"));
    await settle();
    expect(panel()).toBeNull();
    expect(shownBoardMode()).toBeNull();
    // The Work board on an item.
    await act(async () =>
      showMrReviews(undefined, undefined, undefined, undefined, {
        mode: "work",
        item: "1234567890abcdef",
      }),
    );
    await settle();
    expect(panel()?.dataset.mode).toBe("work");
    expect(panel()?.dataset.item).toBe("1234567890abcdef");
    // The plain toggle closes whatever is shown.
    await act(async () => toggleMrReviews());
    await settle();
    expect(panel()).toBeNull();
    // Without a mode: the last one (the stub's default).
    await act(async () => toggleMrReviews());
    await settle();
    expect(panel()?.dataset.mode).toBe("mr");
    await act(async () => closeMrReviews());
    await settle();
    expect(panel()).toBeNull();
    expect(renders.some((render) => render.mode === "work")).toBe(true);
  });
  test("the Work board stepped aside for a pane opens again on its item, once, with Alt+W", async () => {
    await act(async () =>
      showMrReviews(undefined, undefined, undefined, undefined, {
        mode: "work",
        item: "1234567890abcdef",
      }),
    );
    await settle();
    // Its owner's pane was shown: the view closed, keeping the item.
    await act(async () =>
      closeShown?.({ keepFocus: true, resume: { item: "1234567890abcdef" } }),
    );
    await settle();
    expect(panel()).toBeNull();
    await act(async () => toggleMrReviews("work"));
    await settle();
    expect(panel()?.dataset.mode).toBe("work");
    expect(panel()?.dataset.item).toBe("1234567890abcdef");
    // Closed plainly, it opens on the board again, not the item.
    await act(async () => toggleMrReviews("work"));
    await settle();
    expect(panel()).toBeNull();
    await act(async () => toggleMrReviews("work"));
    await settle();
    expect(panel()?.dataset.item).toBe("");
    // The other mode's shortcut does not take a step aside's item.
    await act(async () =>
      closeShown?.({ resume: { item: "1234567890abcdef" } }),
    );
    await settle();
    await act(async () => toggleMrReviews("mr"));
    await settle();
    expect(panel()?.dataset.mode).toBe("mr");
    expect(panel()?.dataset.item).toBe("");
    await act(async () => closeMrReviews());
    await settle();
  });
}
