
import os, sys
from pathlib import Path
root = Path(os.path.expanduser(os.environ.get("CODEX_HOME") or "~/.codex"))
matches = []
for directory in ("sessions", "archived_sessions"):
    matches.extend((root / directory).glob("**/*-" + sys.argv[1] + ".jsonl"))
matches = [path for path in matches if path.is_file()]
if len(matches) > 1:
    sys.exit("Multiple transcripts match this Codex session ID.")
if matches:
    print(matches[0].resolve())
