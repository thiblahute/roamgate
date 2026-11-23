#!/usr/bin/env python3
"""Types contract RPC entries from parity recordings.

  PARITY_RECORDINGS_DIR=/tmp/recs cargo test -p roamgate-parity --test scenarios -- <dir>/
  python3 parity/tools/type-from-census.py /tmp/recs <family> [<family>...]

For each RPC method of the given families still `inventoried` (or with
`--force`, any), writes `params` and `reply` (and `error` when seen) as JSON
Schemas of what the recordings saw: a key every object had is required,
others optional; types are the union seen. The entry becomes `typed` with
`x-typed-from: parity recordings`. Review the result: it says what the
scenarios saw, not every value the server may send.
"""
import json
import re
import sys
from pathlib import Path

ORDER = ["null", "boolean", "number", "string", "array", "object"]
DYNAMIC = re.compile(r"[/:\\]|^[0-9a-f-]{8,}$|^[0-9]+$")


def merge(into, shape):
    for kind, count in shape.get("types", {}).items():
        into["types"][kind] = into["types"].get(kind, 0) + count
    if shape.get("props") is not None:
        props = into.setdefault("props", {})
        for key, prop in shape["props"].items():
            target = props.setdefault(key, {"types": {}, "present": 0})
            target["present"] += prop.get("present", 0)
            merge(target, prop)
    if shape.get("items"):
        merge(into.setdefault("items", {"types": {}}), shape["items"])


def schema(shape, count=None):
    types = [t for t in ORDER if shape.get("types", {}).get(t)]
    out = {}
    if len(types) == 1:
        out["type"] = types[0]
    elif types:
        out["type"] = types
    if "object" in types and shape.get("props") is not None and any(
        DYNAMIC.search(key) for key in shape["props"]
    ):
        # A map keyed by paths or ids: its values' shape, any key.
        merged = {"types": {}}
        for prop in shape["props"].values():
            merge(merged, prop)
        out["additionalProperties"] = schema(merged)
        return out
    if "object" in types and shape.get("props") is not None:
        objects = shape["types"]["object"]
        props = {}
        required = []
        for key, prop in sorted(shape["props"].items()):
            props[key] = schema(prop)
            if prop["present"] >= objects:
                required.append(key)
        out["properties"] = props
        if required:
            out["required"] = required
    if "array" in types and shape.get("items") and shape["items"].get("types"):
        out["items"] = schema(shape["items"])
    if "number" in types:
        # Integers stay integers.
        pass
    return out


def add(shape, value, depth=0):
    kind = (
        "null" if value is None else "boolean" if isinstance(value, bool)
        else "number" if isinstance(value, (int, float)) else "string" if isinstance(value, str)
        else "array" if isinstance(value, list) else "object"
    )
    shape.setdefault("types", {})
    shape["types"][kind] = shape["types"].get(kind, 0) + 1
    if depth > 32:
        return
    if kind == "object":
        props = shape.setdefault("props", {})
        for key, item in value.items():
            prop = props.setdefault(key, {"types": {}, "present": 0})
            prop["present"] += 1
            add(prop, item, depth + 1)
    elif kind == "array":
        items = shape.setdefault("items", {"types": {}})
        for item in value[:16]:
            add(items, item, depth + 1)


ENVELOPE = {"connection_id", "connection_generation"}


def census_of(directory):
    """rpc.request, rpc.reply and rpc.error shapes by method."""
    census = {}
    for path in sorted(Path(directory).rglob("rec-*.jsonl")):
        pending = {}
        for line in path.read_text().splitlines():
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if record.get("ch") != "ws" or not isinstance(record.get("msg"), dict):
                continue
            msg = record["msg"]
            key = (record.get("sock"), str(msg.get("id")))
            if record.get("ev") == "in" and isinstance(msg.get("method"), str):
                pending[key] = msg["method"]
                entry = census.setdefault(f"rpc.request {msg['method']}", {"shape": {"types": {}}})
                add(entry["shape"], msg.get("params", {}))
            elif record.get("ev") == "out" and "id" in msg and ("result" in msg or "error" in msg):
                method = pending.pop(key, None)
                if not method:
                    continue
                kind, payload = ("rpc.reply", msg["result"]) if "result" in msg else ("rpc.error", msg["error"])
                entry = census.setdefault(f"{kind} {method}", {"shape": {"types": {}}})
                add(entry["shape"], payload)
    return census


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv
    census = census_of(args[0])
    families = set(args[1:])
    root = Path(__file__).resolve().parents[2] / "contract" / "rpc"
    changed = []
    for path in sorted(root.glob("*/*.json")):
        entry = json.loads(path.read_text())
        if entry.get("family") not in families and path.parent.name not in families:
            continue
        if entry.get("status") != "inventoried" and not force:
            continue
        method = entry.get("method")
        request = census.get(f"rpc.request {method}")
        reply = census.get(f"rpc.reply {method}")
        if not request and not reply:
            continue
        if request:
            entry["params"] = schema(request["shape"])
        if reply:
            entry["reply"] = schema(reply["shape"])
        error = census.get(f"rpc.error {method}")
        if error:
            entry["error"] = schema(error["shape"])
        entry["status"] = "typed"
        entry["x-typed-from"] = "parity recordings"
        path.write_text(json.dumps(entry, indent=2) + "\n")
        changed.append(method)
    print("\n".join(changed))


main()
