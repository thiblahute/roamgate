import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BLOCK_ENTRIES,
  CompanionMemory,
  companionMemoryPath,
  frontCompaction,
  MAX_ENTRIES,
  MAX_SUMMARY_CHARS,
} from "./voice-memory";
import { CompanionMemoryFiles } from "./voice-memory-files";
import type { ClaudeProcess } from "./voice-cleaner";

function setup(
  compact: (prompt: string) => Promise<string> = async () => "A summary.",
  extra: Partial<ConstructorParameters<typeof CompanionMemory>[0]> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "companion-memory-"));
  const path = companionMemoryPath(root);
  const make = () => new CompanionMemory({ path, compact, ...extra });
  return { path, memory: make(), make };
}

const said = (text: string) => ({ kind: "heard" as const, text });

describe("CompanionMemory", () => {
  test("keeps nothing at first: no memory block", () => {
    const { memory } = setup();
    expect(memory.block()).toBe("");
    expect(memory.epoch).toBe(0);
  });

  test("a call's words come back after a restart", async () => {
    const { memory, make } = setup();
    memory.record(said("lance les tests"));
    memory.record({ kind: "work", text: "lance les tests", who: "roamgate" });
    memory.record({ kind: "said", text: "Je lance les tests." });
    await memory.flushForTests();
    const back = make();
    expect(back.entries).toHaveLength(3);
    expect(back.block(Date.now())).toContain('the user: "lance les tests"');
    expect(back.block(Date.now())).toContain("you gave roamgate:");
  });

  test("the block is bounded, whatever is kept", () => {
    const { memory } = setup(() => new Promise(() => {}));
    for (let at = 0; at < MAX_ENTRIES * 3; at++)
      memory.record(said(`mot ${at} ${"x".repeat(2000)}`));
    expect(memory.entries.length).toBeLessThanOrEqual(MAX_ENTRIES);
    const lines = memory
      .block()
      .split("\n")
      .filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(BLOCK_ENTRIES);
    expect(memory.block().length).toBeLessThan(3700);
  });

  test("the end of a call folds the log into the summary", async () => {
    let prompt = "";
    const { memory, make } = setup(async (text) => {
      prompt = text;
      return "  Ils ont lancé les tests de roamgate. ";
    });
    memory.record(said("lance les tests"));
    memory.callEnded();
    await Bun.sleep(1);
    expect(prompt).toContain("Memory so far:\n(nothing yet)");
    expect(prompt).toContain('the user: "lance les tests"');
    expect(memory.summary).toBe("Ils ont lancé les tests de roamgate.");
    expect(memory.entries).toHaveLength(0);
    await memory.flushForTests();
    expect(make().summary).toBe("Ils ont lancé les tests de roamgate.");
  });

  test("what is said during a summary stays after it", async () => {
    let finish: (text: string) => void = () => {};
    const { memory } = setup(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    memory.record(said("premier"));
    memory.callEnded();
    memory.record(said("deuxième"));
    finish("résumé");
    await Bun.sleep(1);
    expect(memory.summary).toBe("résumé");
    expect(memory.entries.map((entry) => entry.text)).toEqual(["deuxième"]);
  });

  test("a failed summary keeps the log", async () => {
    const { memory } = setup(async () => {
      throw new Error("no model");
    });
    memory.record(said("garde ça"));
    memory.callEnded();
    await Bun.sleep(1);
    expect(memory.entries).toHaveLength(1);
    expect(memory.summary).toBe("");
  });

  test("a summary is capped", async () => {
    const { memory } = setup(async () => "y".repeat(MAX_SUMMARY_CHARS * 2));
    memory.record(said("parle"));
    memory.callEnded();
    await Bun.sleep(1);
    expect(memory.summary).toHaveLength(MAX_SUMMARY_CHARS);
  });

  test("a corrupted file starts fresh, kept aside", async () => {
    const root = mkdtempSync(join(tmpdir(), "companion-memory-"));
    const path = companionMemoryPath(root);
    writeFileSync(path, "{ not json");
    const memory = new CompanionMemory({ path, compact: async () => "" });
    expect(memory.block()).toBe("");
    expect(existsSync(`${path}.corrupt`)).toBe(true);
    memory.record(said("ça marche encore"));
    await memory.flushForTests();
    expect(JSON.parse(readFileSync(path, "utf8")).log).toHaveLength(1);
  });

  test("a file of the wrong shape starts fresh", () => {
    const root = mkdtempSync(join(tmpdir(), "companion-memory-"));
    const path = companionMemoryPath(root);
    writeFileSync(path, JSON.stringify({ version: 9, summary: 3 }));
    const memory = new CompanionMemory({ path, compact: async () => "" });
    expect(memory.summary).toBe("");
  });

  test("entries that make no sense are dropped, the summary clipped", () => {
    const root = mkdtempSync(join(tmpdir(), "companion-memory-"));
    const path = companionMemoryPath(root);
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        epoch: 2,
        summary: "z".repeat(MAX_SUMMARY_CHARS + 500),
        summarized_at: 1,
        log: [
          { seq: 1, at: 1, kind: "heard", text: "bon" },
          { at: "x", kind: "heard", text: "non" },
          { at: 1, kind: "nope", text: "non" },
        ],
      }),
    );
    const memory = new CompanionMemory({ path, compact: async () => "" });
    expect(memory.epoch).toBe(2);
    expect(memory.summary).toHaveLength(MAX_SUMMARY_CHARS);
    expect(memory.entries).toHaveLength(1);
  });

  test("reset forgets all, keeps counting, drops a summary in progress", async () => {
    let finish: (text: string) => void = () => {};
    const { memory, make } = setup(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    memory.record(said("secret"));
    memory.callEnded();
    expect(memory.reset()).toBe(1);
    finish("résumé d'avant");
    await Bun.sleep(1);
    expect(memory.block()).toBe("");
    await memory.flushForTests();
    const back = make();
    expect(back.epoch).toBe(1);
    expect(back.block()).toBe("");
  });

  test("the same answer, heard twice, is one entry and gets its author", () => {
    const { memory } = setup();
    memory.record({ kind: "answer", text: "Les tests passent." });
    memory.record({
      kind: "answer",
      text: "Les tests passent.",
      who: "roamgate",
    });
    expect(memory.entries).toHaveLength(1);
    expect(memory.entries[0]!.who).toBe("roamgate");
  });

  test("onCompacted tells why, and a long log compacts on its own", async () => {
    const reasons: string[] = [];
    const { memory } = setup(async () => "résumé", {
      onCompacted: (reason) => reasons.push(reason),
    });
    for (let at = 0; at < 60; at++) memory.record(said(`phrase ${at}`));
    await Bun.sleep(1);
    expect(reasons).toEqual(["size"]);
  });
});

describe("frontCompaction", () => {
  const ok = { front_model: "opus" } as never;

  test("summarizes on a session of its own, stopped afterwards", async () => {
    let killed = false;
    const spawn = (): ClaudeProcess => {
      const lines: string[] = [];
      let wake: (() => void) | null = null;
      return {
        write: () => {
          lines.push(JSON.stringify({ type: "result", result: "La mémoire." }));
          wake?.();
        },
        lines: (async function* () {
          for (;;) {
            while (lines.length) yield lines.shift()!;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        })(),
        kill: () => {
          killed = true;
        },
        exited: new Promise(() => {}),
      };
    };
    expect(
      await frontCompaction(() => ok, undefined, spawn)("prompt", false),
    ).toBe("La mémoire.");
    expect(killed).toBe(true);
  });

  test("without a front, it refuses", async () => {
    await expect(
      frontCompaction(() => ({}) as never)("prompt", false),
    ).rejects.toThrow();
  });

  test("past its timeout, it refuses", async () => {
    const spawn = (): ClaudeProcess => ({
      write: () => {},
      lines: (async function* () {
        await new Promise(() => {});
        yield "";
      })(),
      kill: () => {},
      exited: new Promise(() => {}),
    });
    await expect(
      frontCompaction(() => ok, undefined, spawn, 5)("prompt", false),
    ).rejects.toThrow("too long");
  });
});

describe("the long-term memories", () => {
  test("a reset leaves the memory directory untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memories-"));
    const files = new CompanionMemoryFiles(join(dir, "companion-memories"));
    writeFileSync(join(files.dir, "MEMORY.md"), "- [Cat](cat.md) - the cat\n");
    writeFileSync(
      join(files.dir, "cat.md"),
      "---\nname: Cat\ndescription: the cat\ntype: user\n---\nA cat.\n",
    );
    const before = readdirSync(files.dir).sort();
    const memory = new CompanionMemory({
      path: join(dir, "memory.json"),
      compact: async () => "summary",
      files,
    });
    memory.record({ kind: "heard", text: "hello" });
    memory.reset();
    await memory.flushForTests();
    expect(readdirSync(files.dir).sort()).toEqual(before);
    expect(readFileSync(join(files.dir, "cat.md"), "utf8")).toContain("A cat");
    expect(files.list().map((one) => one.file)).toEqual(["cat.md"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("forget asks a writing compaction, with what to forget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memories-"));
    const calls: { prompt: string; writes: boolean }[] = [];
    const memory = new CompanionMemory({
      path: join(dir, "memory.json"),
      compact: async (prompt, writes) => {
        calls.push({ prompt, writes });
        return "summary";
      },
    });
    memory.forget("que je préfère le thé");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.writes).toBe(true);
    expect(calls[0]!.prompt).toContain("To forget");
    expect(calls[0]!.prompt).toContain("que je préfère le thé");
    rmSync(dir, { recursive: true, force: true });
  });

  test("the block stays short however long the summary", () => {
    const dir = mkdtempSync(join(tmpdir(), "memories-"));
    const memory = new CompanionMemory({
      path: join(dir, "memory.json"),
      compact: async () => "x",
    });
    (memory as unknown as { state: { summary: string } }).state.summary =
      "ligne\n".repeat(2000);
    expect(memory.block().length).toBeLessThan(2000);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a compaction of size alone does not write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memories-"));
    const writes: boolean[] = [];
    const memory = new CompanionMemory({
      path: join(dir, "memory.json"),
      compact: async (_prompt, write) => {
        writes.push(write);
        return "summary";
      },
    });
    for (let i = 0; i < 60; i++)
      memory.record({ kind: "heard", text: `line ${i}` });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(writes).toEqual([false]);
    rmSync(dir, { recursive: true, force: true });
  });
});
