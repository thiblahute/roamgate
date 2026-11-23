/**
 * The sidecar's real server (server/src/assistant/pi-sidecar-server.ts)
 * with scripted drivers instead of Pi, for roamgate-pi's tests: the wire
 * across the two languages, without a model. A run's text picks its
 * script; `catalog` reports what the drivers saw.
 */
import { readFileSync } from "node:fs";
import { AssistantUserError } from "../../../../server/src/assistant/errors";
import type { AssistantDriver } from "../../../../server/src/assistant/pi-driver";
import { servePiSidecarStdio } from "../../../../server/src/assistant/pi-sidecar-server";

const log: string[] = [];
const created: string[] = [];
const disposed: string[] = [];

function driver(directory: string, credentials: string): AssistantDriver {
  created.push(`${directory}|${credentials}`);
  return {
    async catalog(source) {
      if (source === ("fail" as never))
        throw new Error("Invalid model configuration");
      return { providers: [], models: [], log, created, disposed } as never;
    },
    async configureModel(_input, save) {
      const path = `${directory}/models.json`;
      await save(path, { providers: {} });
      // Pi reads the file back: the server wrote it before answering.
      if (!readFileSync(path, "utf8")) throw new Error("not saved");
      log.push("reloaded");
    },
    async login(provider, method, interaction) {
      interaction.notify({ type: "info", message: `${provider} ${method}` });
      interaction.notify({
        type: "device_code",
        userCode: "ABCD",
        verificationUri: "https://example.test/device",
      });
      const answer = await interaction.prompt({
        type: "select",
        message: "Pick",
        options: [{ id: "a", label: "A" }],
      });
      interaction.notify({ type: "progress", message: `got ${answer}` });
      if (answer === "wait")
        await interaction.prompt({ type: "secret", message: "Key" });
    },
    async run(input) {
      switch (input.text) {
        case "events":
          input.delta("Hel");
          input.delta("lo");
          input.tool("t1", "workspace_status", "running");
          input.tool("t1", "workspace_status", "completed", {
            arguments: "{}",
            output: "ok",
          });
          input.thinking?.(["Thinking"]);
          input.sources?.([]);
          input.replace?.("Hello");
          input.steered?.(undefined, "more");
          input.steered?.("s2", "again");
          input.message("Hello");
          input.error();
          return [
            { type: "ranger-durable", id: "d1" },
            {
              request_id: input.requestId ?? null,
              steers: input.steers ?? null,
              recover: input.recover ?? false,
              entries: input.entries,
              config: input.config,
              present: [
                "checkpoint",
                "replace",
                "thinking",
                "sources",
                "steered",
                "propose",
                "task",
                "notify",
                "show",
                "arrange",
                "threads",
                "archive",
              ].filter(
                (name) =>
                  (input as Record<string, unknown>)[name] !== undefined,
              ),
            },
          ];
        case "checkpoint":
          await input.checkpoint?.([{ type: "ranger-durable", id: "d2" }]);
          input.delta("admitted");
          return [];
        case "tools": {
          const results: unknown[] = [];
          results.push(
            await input.read("status", { a: 1 }, new AbortController().signal),
          );
          results.push(await input.task!("list", {}));
          results.push(await input.notify!({ title: "T", body: "B" } as never));
          results.push(
            await input.show!({ connection_id: "c", workspace_id: "w" }),
          );
          results.push(input.archive ? "archive" : "no archive");
          return results;
        }
        case "errors": {
          for (const kind of ["user", "other"])
            try {
              await input.read(kind as never, {});
            } catch (error) {
              input.delta(
                JSON.stringify([
                  error instanceof AssistantUserError,
                  (error as Error).message,
                ]),
              );
            }
          throw new AssistantUserError("Model unavailable");
        }
        case "hang":
          input.delta("started");
          return new Promise((_, reject) =>
            input.signal.addEventListener("abort", () => {
              input.delta(`aborted ${(input.signal.reason as Error).message}`);
              reject(new Error("Ranger stopped"));
            }),
          );
        case "forever":
          input.delta("started");
          return new Promise(() => {});
        case "slow":
          await Bun.sleep(300);
          return [];
        case "pid":
          return [process.pid];
        default:
          throw new Error(`unknown script ${input.text}`);
      }
    },
    async steer({ text, requestId }) {
      log.push(`${directory} steer ${text} ${requestId}`);
    },
    async stop() {
      log.push(`${directory} stop`);
    },
    async dispose() {
      disposed.push(directory);
    },
  };
}

// A line that is not a message, which the server logs and skips.
process.stdout.write("this line is not a message\n");
await servePiSidecarStdio(driver);
