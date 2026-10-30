import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnClaude, VoiceCleaner } from "./voice-cleaner";

// A Claude Code that answers each message with the effort it was started at.
const FAKE_CLAUDE = `#!/bin/sh
effort=default
while [ $# -gt 0 ]; do
  [ "$1" = "--effort" ] && effort="$2"
  shift
done
while read -r line; do
  cat <<EOF
{"type":"result","result":"{\\"text\\":\\"$effort\\"}"}
EOF
done
`;

test.skipIf(process.platform === "win32")(
  "the background sessions answer at low effort, not thinking for seconds",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "roamgate-claude-"));
    const program = join(dir, "claude");
    writeFileSync(program, FAKE_CLAUDE);
    chmodSync(program, 0o755);
    const cleaner = new VoiceCleaner(() => spawnClaude("opus", program), 1);
    try {
      expect((await cleaner.ask("PIECE\nhello")).text).toBe("low");
    } finally {
      cleaner.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
