import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

/*
 * The commit picker's rows: one line each, whatever a subject's length,
 * the selected one kept in sight as j / k move it.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "the commit picker's rows in an isolated DOM runtime",
    "ROAMGATE_COMMIT_PICKER_DOM_TEST",
    30_000,
  )
) {
  const { installTestDom } = await import("../testDom");
  installTestDom();
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { ChangesCommitBar } = await import("./ChangesCommitBar");
  const { commitChoices } = await import("../reviewModel");
  type Views = Parameters<typeof ChangesCommitBar>[0]["views"];

  const subject =
    "gst: Add and remove children on the pipeline's control task while the bus watch dispatches messages";
  const commits = Array.from({ length: 96 }, (_, index) => ({
    sha: `${String(index).padStart(2, "0")}${"c420f7b1".repeat(5)}`,
    parent: null,
    author: "Thibault Saunier",
    date: "2026-11-04T20:53:38-03:00",
    subject: `${subject} ${index + 1}`,
    body: "",
  }));
  const choices = commitChoices(commits, true);

  test("each row is one line: place and sha, the subject, the author and a short date", async () => {
    const scrolled: string[] = [];
    Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value(this: HTMLElement) {
        scrolled.push(this.textContent ?? "");
      },
    });
    const views = (at: number) =>
      ({
        name: { head: "1/96 00c420f7", subject: commits[0]!.subject },
        commits,
        picker: { query: "", at, choices },
        sha: commits[0]!.sha,
        changed: false,
        status: "",
        history: false,
        step: () => {},
        openPicker: () => {},
        pick: () => {},
        setPickerQuery: () => {},
        movePicker: () => {},
      }) as unknown as Views;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ChangesCommitBar
          views={views(0)}
          onReload={() => {}}
          onDone={() => {}}
        />,
      );
    });

    const rows = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".diff-commit-picker-panel li > button",
      ),
    ];
    expect(rows.length).toBe(97);
    expect(
      rows[0]!.querySelector(".diff-commit-choice-subject")!.textContent,
    ).toBe("All changes (96 commits)");
    const row = rows[78]!;
    expect(
      [...row.children].map((child) => child.className.replace(" note", "")),
    ).toEqual([
      "diff-commit-choice-id",
      "diff-commit-choice-subject",
      "diff-commit-choice-meta",
    ]);
    expect(row.querySelector(".diff-commit-choice-id")!.textContent).toBe(
      "78/96 77c420f7",
    );
    // The whole subject in the tooltip, the full date in the meta's.
    expect(row.title).toBe(`78/96 77c420f7 ${subject} 78`);
    const meta = row.querySelector(".diff-commit-choice-meta")!;
    expect(meta.getAttribute("title")).toBe(
      "Thibault Saunier, 2026-11-04T20:53:38-03:00",
    );
    expect(meta.querySelector(".diff-commit-choice-author")!.textContent).toBe(
      "Thibault Saunier",
    );
    // Short: month, day and time, the year only when not this one.
    expect(meta.querySelector(".diff-commit-choice-date")!.textContent).toMatch(
      /^(2026-)?11-0[45] \d\d:\d\d$/,
    );
    // Every row's place and sha take the same width.
    expect(row.style.getPropertyValue("--choice-id")).toBe("14ch");
    expect(rows[0]!.className).toContain("on");

    // j / k move the selection: it is scrolled into sight.
    scrolled.length = 0;
    await act(async () => {
      root.render(
        <ChangesCommitBar
          views={views(60)}
          onReload={() => {}}
          onDone={() => {}}
        />,
      );
    });
    expect(scrolled[scrolled.length - 1]).toStartWith("60/96");
    expect(
      document
        .querySelectorAll(".diff-commit-picker-panel li > button")[60]!
        .className.split(" "),
    ).toContain("on");
    // The picker is over the review for a moment: Zen's way out stays put.
    expect(
      document
        .querySelector(".diff-commit-picker")!
        .hasAttribute("data-zen-transient"),
    ).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });
}
