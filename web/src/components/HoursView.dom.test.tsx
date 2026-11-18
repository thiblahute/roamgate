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
    KeyboardEvent: browser.KeyboardEvent,
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
            // A copy, as the wire gives: later changes do not reach it.
            return { ok: true, value: structuredClone(day) };
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
          case "block-accept": {
            // As a working provider: the block is accepted.
            const block = (day.blocks as Record<string, unknown>[]).find(
              (entry) => entry.id === (rest as { block: string }).block,
            );
            if (block) block.status = "accepted";
            return { ok: true, value: block ?? {} };
          }
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
  /** Mounts the day; `open` opens every project line and the timeline. */
  const mount = async ({ open = true } = {}) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <HoursView date="2026-11-03" onDate={() => {}} workspaces={[]} />,
      );
    });
    await settle();
    if (open)
      for (const toggle of container.querySelectorAll(
        'button[data-line-key][aria-expanded="false"], .hours-disclosure[aria-expanded="false"]',
      ))
        await click(toggle);
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

  /** Adds an accepted rounded block to b1's project, and a skipped one. */
  const projectDay = (shape: "blocks" | "projects") => {
    reset();
    const blocks = day.blocks as Record<string, unknown>[];
    blocks.push(
      {
        id: "b5",
        start: T("10:30"),
        end: T("10:45"),
        minutes: 15,
        worked_minutes: 7,
        status: "accepted",
        source: "manual",
        target: { id: "10", label: "Just remote investment" },
        task_type: "development",
      },
      {
        id: "s1",
        start: T("11:00"),
        end: T("11:30"),
        minutes: 30,
        status: "skipped",
        source: "answer",
      },
    );
    if (shape === "projects")
      day.projects = [
        {
          target: { id: "10", label: "Just remote investment" },
          task_type: "development",
          worked_minutes: 67,
          minutes: 75,
          blocks: ["b1", "b5"],
          accepted: false,
          submitted: false,
        },
        {
          target: null,
          task_type: null,
          worked_minutes: 60,
          minutes: 60,
          blocks: ["q1"],
          accepted: false,
          submitted: false,
        },
      ];
  };

  for (const shape of ["projects", "blocks"] as const)
    test(`the day is one line per project, its blocks behind it (${shape === "projects" ? "the provider's lines" : "lines computed from the blocks"})`, async () => {
      projectDay(shape);
      const { container, unmount } = await mount({ open: false });
      const toggles = () => [
        ...container.querySelectorAll<HTMLButtonElement>(
          "button[data-line-key]",
        ),
      ];
      const words = (toggle: Element) =>
        [...toggle.children].map(text).filter(Boolean).join(" ");
      expect(toggles().map(words)).toEqual([
        "Just remote investment · Development 1:15 Pending",
        "Waiting for an answer · 1 question 1:00 Question",
        "Not logged · 1 block, not reported Not logged",
      ]);
      expect(
        toggles()[0]!.querySelector(".hours-line-time")!.getAttribute("title"),
      ).toBe(
        "Worked 1h 07m, reported 1h 15m: rounded up to whole 15-minute units",
      );
      expect(
        words(container.querySelector(".hours-line-total .hours-line-toggle")!),
      ).toBe("Total 2:15");
      // The blocks, questions and timeline stay hidden until asked for.
      expect(container.querySelector(".hours-block")).toBeNull();
      expect(container.querySelector(".hours-question")).toBeNull();
      expect(container.querySelector(".hours-strip")).toBeNull();
      expect(
        toggles().every((t) => t.getAttribute("aria-expanded") === "false"),
      ).toBe(true);
      // A click opens a line on its blocks, found by id.
      await click(toggles()[0]);
      expect(toggles()[0]!.getAttribute("aria-expanded")).toBe("true");
      expect(
        [...container.querySelectorAll(".hours-block")].map((card) =>
          card.getAttribute("aria-label"),
        ),
      ).toEqual(["08:00 to 09:00", "10:30 to 10:45"]);
      // `za` opens the waiting line, and the question is answered there.
      for (const key of ["z", "a"])
        await act(async () => {
          toggles()[1]!.dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true }),
          );
        });
      expect(text(container.querySelector(".hours-question strong"))).toBe(
        "Where should 60 min on roamgate be logged?",
      );
      calls.length = 0;
      await click(button(container, /^Suggested/));
      expect(ops().slice(0, 2)).toEqual(["block-answer", "day"]);
      // `za` again folds it.
      for (const key of ["z", "a"])
        await act(async () => {
          toggles()[1]!.dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true }),
          );
        });
      expect(container.querySelector(".hours-question")).toBeNull();
      // A line's Accept accepts its proposed blocks, and only those.
      calls.length = 0;
      await click(
        button(container.querySelector(".hours-line-row")!, "Accept"),
      );
      expect(calls.filter((call) => call.op === "block-accept")).toEqual([
        { op: "block-accept", params: { date: "2026-11-03", block: "b1" } },
      ]);
      expect(ops()).toContain("day");
      await unmount();
    });

  test("the timeline and its gaps open on request", async () => {
    reset();
    const { container, unmount } = await mount({ open: false });
    const disclosure = container.querySelector(".hours-disclosure")!;
    expect(text(disclosure.closest("h3"))).toBe(
      "Timeline the blocks over the day, 1 gap (30m unexplained)",
    );
    expect(container.querySelector(".hours-gap")).toBeNull();
    await click(disclosure);
    expect(container.querySelector(".hours-strip")).not.toBeNull();
    expect(container.querySelectorAll(".hours-gap")).toHaveLength(1);
    await unmount();
  });

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

  test("a rounded block shows the time worked; a one-unit block cannot split; too_short is explained", async () => {
    reset();
    const first = (day.blocks as Record<string, unknown>[])[0]!;
    first.minutes = 15;
    first.end = T("08:15");
    first.worked_minutes = 9;
    failures["block-split"] = {
      error: "each half must last 15 min",
      code: "too_short",
    };
    const { container, unmount } = await mount();
    const card = () => container.querySelector(".hours-block")!;
    expect(text(card().querySelector(".hours-worked"))).toBe("worked 9m");
    expect(button(card(), "Split")!.disabled).toBe(true);
    expect(button(card(), "Split")!.title).toContain("cannot be split");
    first.minutes = 60;
    first.end = T("09:00");
    await click(button(card(), "Accept"));
    await click(button(card(), "Split"));
    // Only whole units are offered.
    expect(
      [...card().querySelectorAll(".hours-inline option")].map(
        (o) => o.textContent,
      ),
    ).toEqual(["08:15", "08:30", "08:45"]);
    await click(button(card().querySelector(".hours-inline")!, "Split"));
    expect(text(container.querySelector(".hours-error"))).toBe(
      "A block must last at least 15 minutes: each half must last 15 min",
    );
    expect(ops().filter((op) => op === "day").length).toBeGreaterThan(1);
    await unmount();
  });

  test("a reopened block says why it needs accepting again", async () => {
    reset();
    const blocks = day.blocks as Record<string, unknown>[];
    blocks.push(
      {
        id: "b2",
        start: T("10:45"),
        end: T("11:00"),
        minutes: 15,
        status: "proposed",
        source: "manual",
        target: { id: "12", label: "Igalia internal" },
        reopened: {
          reason: "neighbour_moved",
          previously_accepted_at: T("10:20"),
        },
      },
      {
        id: "b3",
        start: T("11:00"),
        end: T("11:30"),
        minutes: 30,
        status: "proposed",
        source: "ai",
        target: { id: "12", label: "Igalia internal" },
        reopened: { reason: "recomputed", previously_accepted_at: T("10:21") },
      },
      {
        id: "b4",
        start: T("11:30"),
        end: T("12:00"),
        minutes: 30,
        status: "proposed",
        source: "pin",
        target: { id: "10", label: "Just remote investment" },
        reopened: {
          reason: "target_changed",
          previously_accepted_at: T("10:22"),
        },
      },
    );
    const { container, unmount } = await mount();
    const chip = (label: string) =>
      container
        .querySelector(`[aria-label="${label}"]`)!
        .querySelector(".hours-chip.is-yellow")!;
    expect(text(chip("10:45 to 11:00"))).toBe(
      "Moved by a neighbour: accept again",
    );
    expect(chip("10:45 to 11:00").getAttribute("title")).toStartWith(
      "A neighbour's rounding moved this block. Accepted before on",
    );
    expect(text(chip("11:00 to 11:30"))).toBe("Recomputed: accept again");
    expect(text(chip("11:30 to 12:00"))).toBe("Project changed: accept again");
    expect(chip("11:30 to 12:00").getAttribute("title")).toStartWith(
      "This block's project changed",
    );
    // Once accepted again, the provider clears it.
    answers["block-accept"] = () => {
      delete blocks[2]!.reopened;
      blocks[2]!.status = "accepted";
      return {};
    };
    await click(
      button(
        container.querySelector('[aria-label="10:45 to 11:00"]')!,
        "Accept",
      ),
    );
    expect(
      container
        .querySelector('[aria-label="10:45 to 11:00"]')!
        .querySelector(".hours-chip.is-yellow"),
    ).toBeNull();
    await unmount();
  });

  test("the preview shows the time worked beside the time reported", async () => {
    reset();
    const blocks = day.blocks as Record<string, unknown>[];
    blocks[1]!.status = "skipped";
    blocks[0]!.status = "accepted";
    blocks[0]!.worked_minutes = 52;
    const { container, unmount } = await mount();
    await click(button(container, "Preview submit"));
    expect(text(document.querySelector(".hours-worked-total"))).toBe(
      "Worked 52m, reported 1h: each block is rounded up to whole 15-minute units.",
    );
    await click(button(document.querySelector(".hours-submit")!, "Close"));
    expect(calls.filter((call) => call.op === "submit")).toHaveLength(0);
    await unmount();
  });

  test("the strip zooms: work hours, the full day, and back", async () => {
    reset();
    const { useState } = await import("react");
    const Zoomable = () => {
      const [zoom, setZoom] = useState<{ start: number; end: number } | null>(
        null,
      );
      return (
        <HoursView
          date="2026-11-03"
          onDate={() => {}}
          workspaces={[]}
          zoom={zoom}
          onZoom={setZoom}
        />
      );
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Zoomable />);
    });
    await settle();
    await click(container.querySelector(".hours-disclosure"));
    const range = () => text(container.querySelector(".timeline-zoom-range"));
    expect(container.querySelector(".timeline-zoom-range")).toBeNull();
    await click(button(container, "Work hours"));
    expect(range()).toMatch(/^07:50 to \d\d:\d0$/);
    await click(button(container, "Full day"));
    expect(range()).toBe("00:00 to 24:00");
    // Ticks follow the width shown: three hours apart over the whole day.
    expect(
      [...container.querySelectorAll(".hours-axis span")].map(text),
    ).toContain("03:00");
    await click(button(container, "Reset"));
    expect(container.querySelector(".timeline-zoom-range")).toBeNull();
    await act(async () => root.unmount());
  });

  test("an acceptance the provider does not keep is said on the block", async () => {
    reset();
    // The provider answers, but the day still has the block proposed.
    answers["block-accept"] = () => ({});
    const { container, unmount } = await mount();
    const card = () => container.querySelector(".hours-block")!;
    await click(button(card(), "Accept"));
    expect(text(card().querySelector(".hours-block-error"))).toBe(
      "The provider did not keep the acceptance: this block is proposed again. Try again, or tell the provider's maintainer.",
    );
    // A refused acceptance says why, on the block too.
    delete answers["block-accept"];
    failures["block-accept"] = { error: "blocks overlap", code: "conflict" };
    await click(button(card(), "Accept"));
    expect(text(card().querySelector(".hours-block-error"))).toBe(
      "blocks overlap",
    );
    // Once it takes, the message goes.
    delete failures["block-accept"];
    await click(button(card(), "Accept"));
    expect(card().querySelector(".hours-block-error")).toBeNull();
    expect(text(card().querySelector(".hours-chip"))).toBe("Accepted");
    await unmount();
  });

  test("evidence is grouped per workspace, with the details behind an expander", async () => {
    reset();
    (day.blocks as Record<string, unknown>[])[0]!.evidence = [
      { kind: "workspace", title: "clauth", minutes: 3 },
      { kind: "workspace", title: "roamgate", minutes: 2 },
      { kind: "note", title: "includes 5 min of clauth" },
      { kind: "note", title: "includes 2 min of clauth" },
      { kind: "note", title: "includes 1 min of roamgate" },
      { kind: "note", title: "includes 0 min of upstream" },
      {
        kind: "commit",
        title: "tracer: add span api",
        url: "https://example.com/c/1",
      },
    ];
    const { container, unmount } = await mount();
    const card = container.querySelector(".hours-block")!;
    expect(
      [...card.querySelectorAll(".hours-evidence-group")].map(text),
    ).toEqual(["clauth 10m", "roamgate 3m"]);
    expect(card.querySelector(".hours-evidence a")?.textContent).toBe(
      "tracer: add span api",
    );
    const details = card.querySelector("details.hours-evidence-details")!;
    expect(text(details.querySelector("summary"))).toBe("Details (7)");
    expect(details.querySelectorAll("li")).toHaveLength(7);
    await unmount();
  });
}
