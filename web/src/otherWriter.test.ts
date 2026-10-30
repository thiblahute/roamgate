import { describe, expect, test } from "bun:test";
import { otherWriterPlaceIn } from "./otherWriter";
import type { Tab, Workspace } from "./types";

const writer = {
  pane_id: "w2:p12",
  workspace_id: "w2",
  tab_id: "w2:t2",
  workspace_label: "herdr name",
  tab_label: "Tab 2",
  agent_name: "Claude",
  status: "idle" as const,
};
const workspace = { workspace_id: "w2", label: "roamgate" } as Workspace;
const tab = (label: string) =>
  ({ tab_id: "w2:t2", workspace_id: "w2", label, number: 2 }) as Tab;

describe("where another Claude on the session is", () => {
  test("as the sidebar and the tab bar name it", () => {
    expect(
      otherWriterPlaceIn(writer, {
        workspaces: [workspace],
        tabs: [tab("review")],
      }),
    ).toBe("roamgate / review");
    // A tab named by its number is "Tab 2".
    expect(
      otherWriterPlaceIn(writer, { workspaces: [workspace], tabs: [tab("2")] }),
    ).toBe("roamgate / Tab 2");
  });

  test("by Herdr's names when the page does not know the pane", () => {
    expect(otherWriterPlaceIn(writer, { workspaces: [], tabs: [] })).toBe(
      "herdr name / Tab 2",
    );
    expect(
      otherWriterPlaceIn(
        { pane_id: "w2:p12", agent_name: "Claude", status: "working" },
        { workspaces: [], tabs: [] },
      ),
    ).toBe("pane w2:p12");
  });

  test("with the connection when it is not local", () => {
    const known = { workspaces: [workspace], tabs: [tab("2")] };
    expect(
      otherWriterPlaceIn(writer, {
        ...known,
        connection: { label: "desktop", type: "ssh" },
      }),
    ).toBe("roamgate / Tab 2 on desktop");
    expect(
      otherWriterPlaceIn(writer, {
        ...known,
        connection: { label: "This Mac", type: "local" },
      }),
    ).toBe("roamgate / Tab 2");
  });
});
