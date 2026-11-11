import { expect, test } from "bun:test";
import {
  findInspectorCommand,
  type InspectorCommand,
  inspectorCompletions,
  inspectorViewNamed,
  opensCommandLine,
  runInspectorCommand,
} from "./inspectorCommands";

const ran: string[] = [];
const commands: InspectorCommand[] = [
  { name: "files", description: "the tree", run: () => ran.push("files") },
  {
    name: "only",
    aliases: ["o", "zen"],
    description: "no chrome",
    run: () => ran.push("only"),
  },
  {
    name: "scripts",
    description: "scripts",
    run: (argument) => ran.push(`scripts ${argument}`),
  },
];

test("completes the names typed, with what they do", () => {
  expect(inspectorCompletions(commands, "")).toEqual([
    ["files", "the tree"],
    ["only", "no chrome"],
    ["scripts", "scripts"],
  ]);
  expect(inspectorCompletions(commands, " o")).toEqual([["only", "no chrome"]]);
  expect(inspectorCompletions(commands, "x")).toEqual([]);
});

test("finds a command by its name or an alias, with its argument", () => {
  expect(findInspectorCommand(commands, ":zen")?.command.name).toBe("only");
  expect(findInspectorCommand(commands, "scripts  on ")).toMatchObject({
    command: { name: "scripts" },
    argument: "on",
  });
  // Exact words only: a prefix is completed, not run.
  expect(findInspectorCommand(commands, "fil")).toBeNull();
  expect(findInspectorCommand(commands, "")).toBeNull();
});

test("runs a command, :N where the view has lines, and says what is not one", () => {
  ran.length = 0;
  const lines: number[] = [];
  expect(runInspectorCommand(commands, ":files")).toBeNull();
  expect(runInspectorCommand(commands, "o")).toBeNull();
  expect(runInspectorCommand(commands, "scripts off")).toBeNull();
  expect(ran).toEqual(["files", "only", "scripts off"]);
  expect(runInspectorCommand(commands, "12", (n) => lines.push(n))).toBeNull();
  expect(lines).toEqual([12]);
  expect(runInspectorCommand(commands, "12")).toBe(
    "Not a command here: :12 (try :files, :only, :scripts)",
  );
  expect(runInspectorCommand(commands, "nope")).toBe(
    "Not a command here: :nope (try :files, :only, :scripts)",
  );
  expect(runInspectorCommand([], "nope")).toBe("Not a command here: :nope");
  // Nothing typed: nothing run, nothing said.
  expect(runInspectorCommand(commands, "  ")).toBeNull();
});

test("`:` opens the prompt but where it is typed text, or with Ctrl / Cmd", () => {
  const event = (target: EventTarget | null, init = {}) => ({
    key: ":",
    ctrlKey: false,
    metaKey: false,
    target,
    ...init,
  });
  expect(opensCommandLine(event(null))).toBe(true);
  expect(opensCommandLine(event(null, { key: ";" }))).toBe(false);
  expect(opensCommandLine(event(null, { ctrlKey: true }))).toBe(false);
  expect(opensCommandLine(event(null, { metaKey: true }))).toBe(false);
});

test("completes a command's argument after its name, an alias's too", () => {
  const view: InspectorCommand = {
    name: "view",
    aliases: ["v"],
    description: "a view",
    complete: () => [
      ["files", "the files"],
      ["changes", "the changes"],
      ["commits", "the commits"],
    ],
    run: () => {},
  };
  const both = [view, ...commands];
  expect(inspectorCompletions(both, "view ")).toEqual([
    ["view files", "the files"],
    ["view changes", "the changes"],
    ["view commits", "the commits"],
  ]);
  expect(inspectorCompletions(both, ":v c")).toEqual([
    ["v changes", "the changes"],
    ["v commits", "the commits"],
  ]);
  // A command without arguments to complete: its name, as before.
  expect(inspectorCompletions(both, "files ")).toEqual([["files", "the tree"]]);
  // One name once, the first part's (a view's before the inspector's).
  expect(
    inspectorCompletions(
      [...commands, { name: "files", description: "again", run: () => {} }],
      "f",
    ),
  ).toEqual([["files", "the tree"]]);
});

test(":view NAME takes a whole name or the start of one, in the tabs' order", () => {
  const views = ["files", "changes", "commits"] as const;
  expect(inspectorViewNamed(views, "commits")).toBe("commits");
  expect(inspectorViewNamed(views, "c")).toBe("changes");
  expect(inspectorViewNamed(views, "COM")).toBe("commits");
  expect(inspectorViewNamed(views, "history")).toBeNull();
  expect(inspectorViewNamed(views, " ")).toBeNull();
});
