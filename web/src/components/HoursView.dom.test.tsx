import { expect, mock, test } from "bun:test";

if (process.env.ROAMGATE_HOURS_DOM_TEST !== "1") {
  test("the Hours view in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_HOURS_DOM_TEST: "1" },
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
  const { Window } = await import("happy-dom");
  const browser = new Window({ url: "http://localhost/" });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLSelectElement: browser.HTMLSelectElement,
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

  const T = (clock: string) => `2026-11-03T${clock}:00-03:00`;
  type Call = { op: string; params: Record<string, unknown> };
  const calls: Call[] = [];
  let day: Record<string, unknown>;
  /** Answers per op; a function gets the params. */
  const answers: Record<string, (params: Record<string, unknown>) => unknown> =
    {};
  /** Ops that fail, with the provider's error and code. */
  const failures: Record<string, { error: string; code: string }> = {};
  const reset = () => {
    for (const key of Object.keys(failures)) delete failures[key];
    calls.length = 0;
    day = {
      date: "2026-11-03",
      status: "needs_input",
      tracked_minutes: 120,
      expected_minutes: 420,
      blocks: [
        {
          id: "b1",
          start: T("08:00"),
          end: T("09:00"),
          minutes: 60,
          status: "proposed",
          source: "pin",
          confidence: 1,
          target: { id: "10", label: "Just remote investment" },
          task_type: "development",
          subject: "upstreaming",
          evidence: [
            { kind: "workspace", title: "ges-natural-size", minutes: 48 },
            {
              kind: "note",
              title: "one share of 100 min split between 2 projects",
            },
          ],
        },
        {
          id: "q1",
          start: T("09:00"),
          end: T("10:00"),
          minutes: 60,
          status: "needs_input",
          source: "ai",
          question: {
            prompt: "Where should 60 min on roamgate be logged?",
            options: [
              {
                id: "target:12",
                label: "Suggested: Igalia internal (55% sure)",
                kind: "target",
              },
              { id: "skip", label: "Do not log", kind: "skip" },
            ],
          },
        },
      ],
      gaps: [{ start: T("10:00"), end: T("10:30"), hint: "idle" }],
    };
    for (const key of Object.keys(answers)) delete answers[key];
  };
  reset();
  mock.module("../api", () => ({
    bridge: {
      call: async (method: string, params: Record<string, unknown> = {}) => {
        if (method !== "bridge.time_report") throw new Error(method);
        const { op, ...rest } = params as { op: string };
        calls.push({ op, params: rest });
        if (failures[op]) return { ok: false, ...failures[op]! };
        if (answers[op]) return { ok: true, value: answers[op]!(rest) };
        switch (op) {
          case "day":
            return { ok: true, value: day };
          case "days":
            return {
              ok: true,
              value: {
                days: [
                  {
                    date: "2026-11-02",
                    status: "submitted",
                    tracked_minutes: 425,
                    expected_minutes: 420,
                  },
                  {
                    date: "2026-11-03",
                    status: "needs_input",
                    tracked_minutes: 120,
                    expected_minutes: 420,
                    open_questions: 1,
                  },
                ],
              },
            };
          case "targets":
            return {
              ok: true,
              value: {
                targets: [
                  { id: "10", label: "Just remote investment" },
                  { id: "12", label: "Igalia internal" },
                ],
                task_types: [{ id: "development", label: "Development" }],
              },
            };
          case "submit-preview":
            return {
              ok: true,
              value: {
                changes: [
                  {
                    action: "create",
                    block_id: "b1",
                    entry: {},
                    summary: "08:00-09:00 Just remote investment (60 min)",
                  },
                ],
                total_minutes: 60,
                confirm_token: "tok-1",
                expires_at: T("10:15"),
              },
            };
          case "submit":
            return {
              ok: true,
              value: {
                results: [{ block_id: "b1", ok: true, external_id: "e1" }],
              },
            };
          default:
            return { ok: true, value: {} };
        }
      },
    },
  }));

  const { HoursView } = await import("./HoursView");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const settle = async () => {
    for (let i = 0; i < 6; i++)
      await act(async () => {
        await Promise.resolve();
      });
  };
  const mount = async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <HoursView date="2026-11-03" onDate={() => {}} workspaces={[]} />,
      );
    });
    await settle();
    return { container, unmount: () => act(async () => root.unmount()) };
  };
  const text = (element: Element | null | undefined) =>
    element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const button = (root: ParentNode, label: string | RegExp) =>
    [...root.querySelectorAll("button")].find((b) =>
      typeof label === "string" ? text(b) === label : label.test(text(b)),
    ) as HTMLButtonElement | undefined;
  const click = async (element: Element | null | undefined) => {
    await act(async () => {
      (element as HTMLElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await settle();
  };
  const set = async (element: Element | null | undefined, value: string) => {
    await act(async () => {
      const input = element as HTMLInputElement;
      Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(input),
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
  };
  const ops = () => calls.map((call) => call.op);

  test("the day shows its questions, blocks, gaps and a split, and cannot be submitted while asking", async () => {
    reset();
    const { container, unmount } = await mount();
    expect(ops()).toContain("day");
    expect(text(container.querySelector(".hours-question strong"))).toBe(
      "Where should 60 min on roamgate be logged?",
    );
    expect(
      container.querySelector(".hours-option.is-suggested"),
    ).not.toBeNull();
    expect(text(container.querySelector(".hours-splitnote"))).toContain(
      "split between 2 projects",
    );
    expect(container.querySelectorAll(".hours-gap")).toHaveLength(1);
    expect(text(container.querySelector(".hours-days"))).toContain("Submitted");
    expect(button(container, "Preview submit")!.disabled).toBe(true);
    await unmount();
  });

  test("an answer goes with remember, and the day is read again", async () => {
    reset();
    const { container, unmount } = await mount();
    calls.length = 0;
    const checkbox = container.querySelector<HTMLInputElement>(
      ".hours-question input[type=checkbox]",
    )!;
    expect(checkbox.checked).toBe(true);
    await click(button(container, /^Suggested/));
    expect(ops()).toEqual(["block-answer", "day", "days"]);
    expect(calls[0]!.params).toEqual({
      date: "2026-11-03",
      block: "q1",
      body: { option_id: "target:12", remember: true },
    });
    await unmount();
  });

  test("every block operation reads the day again", async () => {
    reset();
    const { container, unmount } = await mount();
    const card = () => container.querySelector(".hours-block")!;
    calls.length = 0;
    await click(button(card(), "Accept"));
    expect(ops().slice(0, 2)).toEqual(["block-accept", "day"]);
    calls.length = 0;
    await click(button(card(), "Edit"));
    await set(card().querySelector(".hours-form input[type=text]"), "review");
    await set(
      card().querySelectorAll(".hours-form input[type=time]")[1],
      "08:45",
    );
    await click(button(card(), "Save"));
    expect(calls[0]).toEqual({
      op: "block-update",
      params: {
        date: "2026-11-03",
        block: "b1",
        body: { description: "review", end: "2026-11-03T08:45:00-03:00" },
      },
    });
    expect(ops()[1]).toBe("day");
    calls.length = 0;
    await click(button(card(), "Split"));
    await click(button(card().querySelector(".hours-inline")!, "Split"));
    expect(calls[0]).toEqual({
      op: "block-split",
      params: {
        date: "2026-11-03",
        block: "b1",
        at: "2026-11-03T08:30:00-03:00",
      },
    });
    expect(ops()[1]).toBe("day");
    calls.length = 0;
    await click(button(card(), "Delete"));
    expect(ops()).toEqual([]);
    await click(button(card().querySelector(".hours-inline")!, "Delete"));
    expect(ops().slice(0, 2)).toEqual(["block-delete", "day"]);
    // A gap is claimed as a block of its own.
    calls.length = 0;
    const gap = container.querySelector(".hours-gap")!;
    await click(button(gap, "Claim..."));
    await set(gap.querySelector("select"), "12");
    await click(button(gap, "Claim"));
    expect(calls[0]).toEqual({
      op: "block-create",
      params: {
        date: "2026-11-03",
        body: {
          start: T("10:00"),
          end: T("10:30"),
          target: "12",
          task_type: null,
          description: "idle",
        },
      },
    });
    expect(ops()[1]).toBe("day");
    await unmount();
  });

  test("explain asks the provider once and shows why", async () => {
    reset();
    answers["block-explain"] = () => ({
      block_id: "b1",
      reasoning: "upstreaming is mapped 60/40",
      inputs: ["mapping upstreaming"],
      decided_by: "mapping",
    });
    const { container, unmount } = await mount();
    await click(button(container.querySelector(".hours-block")!, "Explain"));
    expect(text(container.querySelector(".hours-explain"))).toContain(
      "upstreaming is mapped 60/40",
    );
    expect(ops().filter((op) => op === "block-explain")).toHaveLength(1);
    await unmount();
  });

  test("a refreshing day is polled until done", async () => {
    reset();
    let polls = 0;
    answers.day = () => {
      polls++;
      return { ...day, refreshing: polls < 2 };
    };
    const { container, unmount } = await mount();
    expect(text(container.querySelector(".hours-refresh"))).toBe("Refreshing");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_100));
    });
    await settle();
    expect(polls).toBe(2);
    expect(text(container.querySelector(".hours-refresh"))).toBe("Refresh");
    await unmount();
  });

  test("submit needs a preview, the tick and the click; nothing else sends it", async () => {
    reset();
    (day.blocks as { status: string }[])[1]!.status = "skipped";
    (day.blocks as { status: string }[])[0]!.status = "accepted";
    const { container, unmount } = await mount();
    expect(ops()).not.toContain("submit");
    const preview = button(container, "Preview submit")!;
    expect(preview.disabled).toBe(false);
    await click(preview);
    const dialog = () => document.querySelector(".hours-submit")!;
    expect(text(dialog())).toContain("08:00-09:00 Just remote investment");
    expect(ops()).toContain("submit-preview");
    expect(ops()).not.toContain("submit");
    await click(button(dialog(), "Continue to submit..."));
    const submit = () => button(dialog(), /^Submit 1 change/)!;
    expect(submit().disabled).toBe(true);
    // Clicking a disabled Submit does nothing.
    await click(submit());
    expect(ops()).not.toContain("submit");
    await act(async () => {
      dialog().querySelector<HTMLInputElement>("input[type=checkbox]")!.click();
    });
    await settle();
    expect(submit().disabled).toBe(false);
    await click(submit());
    const sent = calls.filter((call) => call.op === "submit");
    expect(sent).toEqual([
      {
        op: "submit",
        params: { date: "2026-11-03", confirm_token: "tok-1", confirmed: true },
      },
    ]);
    expect(text(dialog())).toContain("written");
    await click(button(dialog(), "Close"));
    expect(document.querySelector(".hours-submit")).toBeNull();
    expect(calls.filter((call) => call.op === "submit")).toHaveLength(1);
    await unmount();
  });

  test("a deferred day says why the model did not run", async () => {
    reset();
    day.deferred = true;
    day.deferred_reason = "preflight failed: clauth: command not found";
    const { container, unmount } = await mount();
    expect(text(container.querySelector(".hours-deferred"))).toBe(
      "The model did not run: preflight failed: clauth: command not found. What it could not place stays a question; Refresh tries again.",
    );
    expect(
      container.querySelector(".hours-chip.is-red")?.getAttribute("title"),
    ).toBe("preflight failed: clauth: command not found");
    await unmount();
  });

  test("a rounded block shows the time worked; too_short is explained", async () => {
    reset();
    (day.blocks as Record<string, unknown>[])[0]!.minutes = 15;
    (day.blocks as Record<string, unknown>[])[0]!.worked_minutes = 9;
    failures["block-split"] = {
      error: "each half must last 15 min",
      code: "too_short",
    };
    const { container, unmount } = await mount();
    const card = () => container.querySelector(".hours-block")!;
    expect(text(card().querySelector(".hours-block-top"))).toContain(
      "15m (worked 9m)",
    );
    // Under 30 minutes there is no split leaving two 15-minute halves.
    expect(button(card(), "Split")!.disabled).toBe(true);
    expect(button(card(), "Split")!.title).toContain("cannot be split");
    (day.blocks as Record<string, unknown>[])[0]!.minutes = 60;
    await click(button(card(), "Accept"));
    await click(button(card(), "Split"));
    await click(button(card().querySelector(".hours-inline")!, "Split"));
    expect(text(container.querySelector(".hours-error"))).toBe(
      "A block must last at least 15 minutes: each half must last 15 min",
    );
    // The day is read again all the same.
    expect(ops().filter((op) => op === "day").length).toBeGreaterThan(1);
    await unmount();
  });
}
