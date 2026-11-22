#!/usr/bin/env bun
// Contract recordings (ROAMGATE_CONTRACT_RECORD, server/src/contract-record):
// check them against contract/, census their shapes, list their sockets and
// seed parity scenarios from them.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkRecordings } from "../server/src/contract-record/check";
import { contractRecordDirectory } from "../server/src/contract-record/recorder";
import {
  listSockets,
  seedScenario,
  seedYaml,
} from "../server/src/contract-record/seed";
import {
  type Census,
  compareCensus,
  mergeCensus,
} from "../server/src/contract-record/shapes";

const USAGE = `Usage: bun scripts/contract-record.ts <command> [recordings...] [options]

Recordings are rec-*.jsonl files or directories of them; the default is the
directory ROAMGATE_CONTRACT_RECORD names (<data dir>/contract-record for 1).

Commands:
  check     validate every message against contract/ and report mismatches,
            unknown fields and unlisted messages (exit 1 when any)
              --contract <dir>   contract directory (default: ./contract)
              --baseline <file>  also report what a shape census does not know
              --shapes <file>    write this recording's shape census
              --surface <name>   only this surface (repeatable): rpc.request,
                                 rpc.reply, push, http, agent, ...
              --json             the report as JSON
  shapes    write the shape census (--out <file>, default stdout); with
            --merge <file>, merged into that census
  list      the recorded sockets with their span, calls and pushes
  seed      a scenario seed (YAML) from one socket or a time span
              --sock <id>  --from <iso>  --to <iso>  --name <name>
              --keep-all   keep terminal frames
              --out <file> (default stdout)
`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    contract: { type: "string" },
    baseline: { type: "string" },
    shapes: { type: "string" },
    surface: { type: "string", multiple: true },
    json: { type: "boolean" },
    out: { type: "string" },
    merge: { type: "string" },
    sock: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    name: { type: "string" },
    "keep-all": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, ...rest] = positionals;
if (values.help || !command) {
  console.log(USAGE);
  process.exit(command || values.help ? 0 : 2);
}

function recordings(): string[] {
  if (rest.length) return rest;
  const directory = contractRecordDirectory(
    process.env.ROAMGATE_CONTRACT_RECORD ||
      process.env.HERDR_GUI_CONTRACT_RECORD
      ? process.env
      : { ROAMGATE_CONTRACT_RECORD: "1" },
  );
  if (!directory || !existsSync(directory)) {
    console.error(`No recordings: ${directory ?? "record mode is off"}`);
    process.exit(2);
  }
  return [directory];
}

function output(text: string) {
  if (values.out) writeFileSync(values.out, text);
  else process.stdout.write(text);
}

function readCensus(path: string): Census {
  return JSON.parse(readFileSync(path, "utf8")) as Census;
}

switch (command) {
  case "check": {
    const contract = resolve(values.contract ?? "contract");
    const report = await checkRecordings(
      recordings(),
      existsSync(contract) ? contract : null,
      values.surface ? { surfaces: new Set(values.surface) } : {},
    );
    if (values.shapes)
      writeFileSync(
        values.shapes,
        `${JSON.stringify(report.census, null, 2)}\n`,
      );
    const differences = values.baseline
      ? compareCensus(readCensus(values.baseline), report.census)
      : [];
    if (values.json) {
      console.log(
        JSON.stringify(
          {
            messages: report.messages,
            checked: report.checked,
            findings: report.findings,
            differences,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        `${report.messages} messages, ${report.checked} checked against ${existsSync(contract) ? join(contract) : "no contract (shapes only)"}`,
      );
      for (const finding of report.findings)
        console.log(
          `${finding.kind.padEnd(13)} ${finding.surface} ${finding.name} ${finding.path}: ${finding.detail} (x${finding.count}, first ${finding.first})`,
        );
      for (const difference of differences)
        console.log(
          `${difference.kind.padEnd(13)} ${difference.key} ${difference.path}: ${difference.detail}`,
        );
    }
    process.exit(report.findings.length || differences.length ? 1 : 0);
    break;
  }
  case "shapes": {
    const report = await checkRecordings(recordings(), null);
    const census =
      values.merge && existsSync(values.merge)
        ? mergeCensus(readCensus(values.merge), report.census)
        : report.census;
    output(`${JSON.stringify(census, null, 2)}\n`);
    break;
  }
  case "list": {
    for (const socket of listSockets(recordings())) {
      const top = Object.entries(socket.methods)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([method, count]) => `${method} x${count}`)
        .join(", ");
      console.log(
        `${socket.sock}  ${socket.from} .. ${socket.to}  ${socket.calls} calls, ${socket.pushes} pushes${top ? `  (${top})` : ""}`,
      );
    }
    break;
  }
  case "seed": {
    const seed = seedScenario(recordings(), {
      sock: values.sock,
      from: values.from,
      to: values.to,
      name: values.name,
      keepAll: values["keep-all"],
    });
    output(seedYaml(seed));
    break;
  }
  default:
    console.error(USAGE);
    process.exit(2);
}
