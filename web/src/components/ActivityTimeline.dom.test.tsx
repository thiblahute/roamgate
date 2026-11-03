import { expect, mock, test } from "bun:test";

if (process.env.ROAMGATE_ACTIVITY_TIMELINE_DOM_TEST !== "1") {
  test("the activity timeline's subjects and projects in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_ACTIVITY_TIMELINE_DOM_TEST: "1" },
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
    localStorage: browser.localStorage,
    HTMLElement: browser.HTMLElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    HTMLInputElement: browser.HTMLInputElement,
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

  const at = (hh: number) => new Date(2026, 10, 3, hh).toISOString();
  const ocio = {
    id: "dir:~/devel/gstreamer/ocio",
    label: "ocio",
    source: "directory",
    path: "/Users/me/devel/gstreamer/ocio",
    groups: [
      { id: "dir:~/devel/gstreamer", label: "gstreamer" },
      { id: "dir:~/devel/gstreamer/ocio", label: "ocio" },
    ],
  };
  const totals = (id: string, hours: number) => ({
    workspace_id: id,
    attended_ms: hours * 3_600_000,
    browser_ms: hours * 3_600_000,
    phone_ms: 0,
    herdr_ms: 0,
    working_ms: 0,
    blocked_ms: 0,
  });
  const timeline = {
    recording: true,
    day_start: "00:00",
    now: at(18),
    from: at(0),
    to: new Date(2026, 10, 4).toISOString(),
    recorder_running: true,
    days: [
      {
        date: "2026-11-03",
        start: at(0),
        end: new Date(2026, 10, 4).toISOString(),
        focus: [],
        attention: [
          { start: at(9), end: at(10), workspace_id: "a", source: "browser" },
          { start: at(10), end: at(11), workspace_id: "b", source: "browser" },
          { start: at(11), end: at(12), workspace_id: "c", source: "browser" },
        ],
        idle: [],
        agents: [],
        gaps: [],
        totals: {
          attended_ms: 3 * 3_600_000,
          idle_ms: 0,
          unrecorded_ms: 0,
          workspaces: [totals("a", 1), totals("b", 1), totals("c", 1)],
          subjects: [
            {
              subject_id: ocio.id,
              label: "ocio",
              ...totals("x", 2),
              workspace_ids: ["a", "b"],
            },
            {
              subject_id: null,
              label: null,
              ...totals("x", 1),
              workspace_ids: ["c"],
            },
          ],
        },
      },
    ],
    workspaces: [
      {
        id: "a",
        connection_id: "local",
        name: "ocio-plugin",
        path: "/a",
        herdr_workspace_id: "w1",
        subject: ocio,
      },
      {
        id: "b",
        connection_id: "local",
        name: "ocio-tests",
        path: "/b",
        herdr_workspace_id: "w2",
        subject: ocio,
      },
      {
        id: "c",
        connection_id: "local",
        name: "roamgate",
        path: "/c",
        herdr_workspace_id: "w3",
        subject: null,
      },
    ],
  };
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let mappings: unknown[] = [];
  let provider = true;
  mock.module("../api", () => ({
    bridge: {
      call: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        if (method === "bridge.activity.timeline") return timeline;
        if (method !== "bridge.time_report") throw new Error(method);
        if (!provider)
          return { ok: false, error: "No provider", code: "not_configured" };
        switch (params.op) {
          case "health":
            return {
              ok: true,
              value: { ok: true, provider: "Olmo", capabilities: ["mapping"] },
            };
          case "targets":
            return {
              ok: true,
              value: {
                targets: [
                  { id: "10", label: "OpenColorIO", group: "STF" },
                  { id: "11", label: "Old", active: false },
                ],
                task_types: [{ id: "development", label: "Development" }],
              },
            };
          case "mappings":
            return { ok: true, value: { mappings } };
          case "mapping-set": {
            const body = params.body as Record<string, any>;
            mappings = [
              {
                scope: body.subject ? "subject" : "workspace",
                workspace_id: body.workspace_id,
                workspace_name: body.workspace_name,
                subject_label: body.subject?.label,
                allocations: body.allocations,
                remembered_at: "now",
              },
            ];
            return { ok: true, value: mappings[0] };
          }
        }
        return { ok: false, error: "unexpected", code: "invalid" };
      },
    },
  }));
  mock.module("../store", () => ({
    store: {
      get: () => ({ activeConnectionId: "local", workspaces: [] }),
      jumpToConnectionWorkspace: async () => {},
    },
  }));

  const { ActivityTimeline } = await import("./ActivityTimeline");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  const settle = async () => {
    for (let i = 0; i < 5; i++)
      await act(async () => {
        await Promise.resolve();
      });
  };
  const mount = async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ActivityTimeline onClose={() => {}} />);
    });
    await settle();
    return {
      container,
      unmount: () => act(async () => root.unmount()),
    };
  };
  const text = (element: Element | null) =>
    element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const click = async (element: Element | null | undefined) => {
    await act(async () => {
      (element as HTMLElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await settle();
  };
  const change = async (element: Element | null, value: string | boolean) => {
    await act(async () => {
      const input = element as HTMLInputElement;
      if (typeof value === "boolean") input.checked = value;
      else {
        // Past React's value tracker, as typing would.
        const proto = Object.getPrototypeOf(input);
        Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(
          input,
          value,
        );
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
  };

  test("grouping by subject gathers workspaces and is remembered", async () => {
    localStorage.clear();
    const { container, unmount } = await mount();
    // By workspace, each row names its subject.
    expect(
      [...container.querySelectorAll(".activity-subject-chip")].map(text),
    ).toEqual(["ocio", "ocio"]);
    expect(container.querySelector(".activity-subject")).toBeNull();
    const subjects = container.querySelector<HTMLInputElement>(
      'input[name="activity-group-by"][value="subject"]',
    );
    await act(async () => {
      subjects!.click();
    });
    await settle();
    const sections = [...container.querySelectorAll(".activity-subject")];
    expect(
      sections.map((section) => section.getAttribute("aria-label")),
    ).toEqual(["Subject ocio", "Subject No subject"]);
    expect(
      [...sections[0]!.querySelectorAll(".activity-workspace-name")].map(text),
    ).toEqual(["ocio-plugin", "ocio-tests"]);
    expect(text(container.querySelector(".activity-totals thead"))).toContain(
      "Subject",
    );
    expect(localStorage.getItem("roamgate.activity.groupBy")).toBe("subject");
    await unmount();
    const again = await mount();
    expect(again.container.querySelectorAll(".activity-subject")).toHaveLength(
      2,
    );
    await again.unmount();
  });

  test("a project correction goes to the provider and shows at once", async () => {
    localStorage.clear();
    calls.length = 0;
    const { container, unmount } = await mount();
    const buttons = () => [
      ...container.querySelectorAll(".activity-project-cell .activity-project"),
    ];
    expect(buttons().map(text)).toEqual(["Set", "Set", "Set"]);
    await click(buttons()[0]);
    const dialog = document.querySelector(
      '[aria-label="Project for ocio-plugin"]',
    );
    expect(dialog).not.toBeNull();
    // Inactive projects are not offered.
    expect(
      [...dialog!.querySelectorAll("option")].map(
        (option) => option.textContent,
      ),
    ).toEqual([
      "Choose a project",
      "OpenColorIO",
      "Do not log",
      "None",
      "Development",
    ]);
    const radios = dialog!.querySelectorAll<HTMLInputElement>(
      'input[name="project-mapping-scope"]',
    );
    await act(async () => {
      radios[1]!.click();
    });
    await settle();
    const [project, type] = dialog!.querySelectorAll("select");
    await change(project!, "10");
    await change(type!, "development");
    await click(
      [...dialog!.querySelectorAll("button")].find((b) => text(b) === "Save"),
    );
    const set = calls.find((call) => call.params.op === "mapping-set");
    expect(set?.params.body).toEqual({
      workspace_id: "a",
      workspace_name: "ocio-plugin",
      subject: timeline.workspaces[0]!.subject,
      allocations: [
        {
          target: { id: "10", label: "OpenColorIO", group: "STF" },
          task_type: "development",
          percent: 100,
        },
      ],
      remember: true,
    });
    expect(document.querySelector(".project-mapping")).toBeNull();
    // Both ocio workspaces now show it, as their subject's.
    expect(buttons().map(text)).toEqual(["OpenColorIO", "OpenColorIO", "Set"]);
    expect(buttons()[1]!.className).toContain("is-inherited");
    await unmount();
  });

  test("without a provider there is no project column", async () => {
    localStorage.clear();
    provider = false;
    const { container, unmount } = await mount();
    expect(container.querySelector(".activity-project")).toBeNull();
    expect(
      text(container.querySelector(".activity-totals thead")),
    ).not.toContain("Project");
    provider = true;
    await unmount();
  });

  test("a task split between projects sends shares that add up to 100", async () => {
    localStorage.clear();
    calls.length = 0;
    mappings = [];
    const { container, unmount } = await mount();
    const buttons = () => [
      ...container.querySelectorAll(".activity-project-cell .activity-project"),
    ];
    await click(buttons()[2]);
    const dialog = document.querySelector(".project-mapping")!;
    const button = (label: string) =>
      [...dialog.querySelectorAll("button")].find((b) => text(b) === label);
    await click(button("Split between projects"));
    let shares = dialog.querySelectorAll(".project-mapping-share");
    expect(shares).toHaveLength(2);
    const percents = () =>
      [
        ...dialog.querySelectorAll<HTMLInputElement>('input[type="number"]'),
      ].map((input) => Number(input.value));
    expect(percents()).toEqual([50, 50]);
    await change(shares[0]!.querySelector("select"), "10");
    await change(shares[1]!.querySelector("select"), "__skip__");
    await change(dialog.querySelectorAll('input[type="number"]')[0]!, "70");
    // 70 + 50: not 100, so nothing can be saved.
    expect(text(dialog.querySelector('[role="status"]'))).toContain("120%");
    expect(button("Save")!.hasAttribute("disabled")).toBe(true);
    await change(dialog.querySelectorAll('input[type="number"]')[1]!, "30");
    expect(button("Save")!.hasAttribute("disabled")).toBe(false);
    await click(button("Save"));
    const set = calls.find((call) => call.params.op === "mapping-set");
    expect((set!.params.body as { allocations: unknown }).allocations).toEqual([
      {
        target: { id: "10", label: "OpenColorIO", group: "STF" },
        task_type: null,
        percent: 70,
      },
      { target: null, task_type: null, percent: 30 },
    ]);
    expect(buttons().map(text)[2]).toBe("OpenColorIO 70% · Do not log 30%");
    // Removing a share gives its percent back.
    await click(buttons()[2]);
    const again = document.querySelector(".project-mapping")!;
    shares = again.querySelectorAll(".project-mapping-share");
    expect(shares).toHaveLength(2);
    await click(again.querySelector('[aria-label="Remove share 2"]'));
    expect(again.querySelectorAll(".project-mapping-share")).toHaveLength(1);
    expect(again.querySelector('input[type="number"]')).toBeNull();
    await unmount();
  });
}
