# Vectors

The cases of the server's and `shared/`'s pure logic (parsers, builders,
validators, transcript readers), as JSON in and JSON out. They are the only
case source of those functions: `bun test` replays each file against the TS
functions (`runVectors` in `vectors.ts`, called by the `*.test.ts` named in
the file's `description`), and the Rust crates replay the same files against
theirs. A change of behaviour is a change of a vector.

A file that is not in the format below says what it holds in its
`description` (`voice-frames.json`: the voice helper's frame codec).

## Format

```json
{
  "description": "What it covers. Read by `bun test` in shared/x.test.ts.",
  "modules": { "x": "shared/x.ts" },
  "normalize": { "generated_ids": "^[wg][0-9a-z]{12,}$" },
  "cases": [
    {
      "name": "a case, named as the test it replaces",
      "group": ["its describe blocks"],
      "calls": [{ "fn": "x.parse", "args": ["text"], "result": { "ok": true } }]
    }
  ]
}
```

A case is one test: its calls run in order, each compared with what it
gave. A call is one of:

| Call                      | Meaning                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `fn`, `args`              | call the export `fn` (`<module>.<export>`; a static method is `<module>.<Class>.<method>`) |
| `fn`, `new: true`, `args` | construct the class `fn` names                                                             |
| `on`, `method`, `args`    | call a method of the object that is handle `on`                                            |
| `on`, `get`               | read a property of handle `on`                                                             |
| `value`                   | an exported constant, compared with `result`                                               |

and carries what it gave: `result`, or `throws` (the error's message);
`async` when it returns a promise, awaited first; `args_after` when it
changed its arguments; `same_as_arg: n` when it returns the very object
passed as argument `n`; `now` (ms since the epoch) when it reads the clock.

`normalize.generated_ids` names ids the code makes up from the clock and
random numbers: each comparison renames the strings matching it `$id1`,
`$id2`... in order of appearance, so only where they appear counts.

## Values

JSON values stand for themselves; an object with one of these keys is a
value JSON has no form for:

| Tag                                                    | Value                                                                                                                                                                                  |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{"$undefined": true}`                                 | `undefined` (in an array or as an argument; an undefined property is left out)                                                                                                         |
| `{"$num": "NaN"}`                                      | `NaN`, `Infinity`, `-Infinity`, `-0`                                                                                                                                                   |
| `{"$bigint": "10"}`                                    | a big integer                                                                                                                                                                          |
| `{"$text": ["head", ["x", 4096], "tail"]}`             | a long string: its parts, `[unit, count]` a run                                                                                                                                        |
| `{"$map": [[k, v]]}`, `{"$set": [v]}`                  | a Map, a Set                                                                                                                                                                           |
| `{"$date": "2026-01-02T03:04:05.000Z"}`                | a Date (`"Invalid"` for an invalid one)                                                                                                                                                |
| `{"$regexp": ["source", "flags"]}`                     | a RegExp                                                                                                                                                                               |
| `{"$bytes": "hex"}`, `{"$buffer": "hex"}`              | a Uint8Array, a Node Buffer                                                                                                                                                            |
| `{"$error": {"name": "Error", "message": "..."}}`      | an Error                                                                                                                                                                               |
| `{"$handle": 1}`                                       | an object with methods (a class instance, a driver) the case keeps: later calls name it with `on`                                                                                      |
| `{"$fn": {"calls": [{"args": [...], "result": ...}]}}` | a callback: each call answers what the recorded call with the same arguments gave (`throws`, `async` as for calls), and by the end of the case every recorded call must have been made |
| `{"$object": {...}}`                                   | a plain object whose only key is one of these tags                                                                                                                                     |
