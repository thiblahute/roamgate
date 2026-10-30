import { expect, test } from "bun:test";
import {
  bashModeTexts,
  shellLine,
  splitBashMode,
  truncateBashOutput,
} from "./bashMode";

test("a `!` first, past any spaces, makes a shell line, as in the terminal", () => {
  expect(shellLine("!ls")).toBe("ls");
  expect(shellLine("  ! git push origin HEAD")).toBe(" git push origin HEAD");
  // A real shell: chains, variables, several lines.
  expect(shellLine("!FOO=1 make && echo $FOO\nls")).toBe(
    "FOO=1 make && echo $FOO\nls",
  );
  // A `!` elsewhere is a normal message, and a lone `!` is not a command.
  expect(shellLine("Hello!")).toBeNull();
  expect(shellLine("Run !ls for me")).toBeNull();
  expect(shellLine("!")).toBeNull();
  expect(shellLine("!   ")).toBeNull();
  expect(shellLine("")).toBeNull();
});

test("Claude reads a run in Claude Code's own format: the output escaped, the command not", () => {
  expect(
    bashModeTexts({
      command: " cd x && git push",
      stdout: "a -> b\n",
      stderr: "<warn> & co",
    }),
  ).toEqual([
    "<bash-input> cd x && git push</bash-input>",
    "<bash-stdout>a -&gt; b\n</bash-stdout><bash-stderr>&lt;warn&gt; &amp; co</bash-stderr>",
  ]);
});

test("output past the cap is cut as Claude Code cuts it", () => {
  expect(truncateBashOutput("short")).toEqual({
    text: "short",
    truncated: false,
  });
  const cut = truncateBashOutput("abc\ndef\nghi", 5);
  expect(cut).toEqual({
    text: "abc\nd\n\n... [2 lines truncated] ...",
    truncated: true,
  });
});

test("runs read back from a transcript: the terminal's two records, and one message", () => {
  // The terminal: the command, then its output, as records of their own.
  expect(splitBashMode("<bash-input> glab auth login</bash-input>")).toEqual({
    parts: [{ command: " glab auth login" }],
    rest: "",
  });
  expect(
    splitBashMode(
      "<bash-stdout></bash-stdout><bash-stderr>ERROR: a -&gt; b\n</bash-stderr>",
    ),
  ).toEqual({ parts: [{ stdout: "", stderr: "ERROR: a -> b\n" }], rest: "" });
  // Conversation mode: both, then the user's message, in one.
  const [input, output] = bashModeTexts({
    command: "echo hi",
    stdout: "hi\n",
    stderr: "",
  });
  expect(
    splitBashMode(`${input}\n${output}\nwhat did my last command print?`),
  ).toEqual({
    parts: [{ command: "echo hi", stdout: "hi\n", stderr: "" }],
    rest: "what did my last command print?",
  });
  expect(splitBashMode("Tell me about <bash-input>")).toBeNull();
});
