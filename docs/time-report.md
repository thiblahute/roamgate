# Time-report provider

A time-report provider turns the [activity log](./activity.md) into time to
report (for example to a company's time tracker): blocks of time with a target
project, task type and description, questions it needs answered, and a submit
step. Roamgate knows no tracker: a provider is any command that implements
this protocol, configured in `settings.json`. Without one, the activity
timeline works as usual and the provider's parts are hidden.

```json
"time_report": {
  "command": ["/path/to/olmo-reporter", "provider"],
  "timeout_seconds": 60
}
```

`command` is the program and its first arguments (read on every call, no
restart needed); `timeout_seconds` (5 to 600, default 60) is how long one run
may take before Roamgate kills it, with whatever it started.

Schemas: [`time-report.schema.json`](./time-report.schema.json) (`$defs`:
`DayInput`, `Segment`, `Day`, `DaySummary`, `Block`, `BlockPatch`,
`BlockCreate`, `Gap`, `Target`, `TaskType`, `Evidence`, `Question`,
`QuestionOption`, `Explanation`, `Preview`, `Change`, `SubmitResult`,
`Health`, `Allocation`, `MappingSet`, `Mapping`, `Mappings`,
`MappingDelete`). The activity
shapes it refers to are in [`activity.schema.json`](./activity.schema.json).

## Running the command

Roamgate runs the command once per operation with the operation appended, for
example `olmo-reporter provider day 2026-11-02`, a JSON body on stdin and one
JSON document read from stdout. It runs from a new empty directory with the
user's environment; the provider holds its own credentials and Roamgate passes
none. On a non-zero exit, stderr carries `{"error": "message", "code": "..."}`:

| Exit | `code`      | Meaning                                                                            |
| ---- | ----------- | ---------------------------------------------------------------------------------- |
| 0    |             | Success, JSON on stdout.                                                           |
| 2    | `invalid`   | Invalid arguments or content.                                                      |
| 2    | `too_short` | A block would last less than 15 minutes (a claim, an edit, a split half or share). |
| 3    | `not_found` | Unknown day or block.                                                              |
| 4    | `conflict`  | Overlaps another block, already submitted, or the day changed since the preview.   |
| 5    | `forbidden` | Invalid, reused, expired or mismatched `confirm_token`.                            |
| 6    | `upstream`  | The external system failed; for `submit`, stdout has the partial `SubmitResult`.   |
| 1    | `error`     | Anything else.                                                                     |

Roamgate never runs two provider processes for one day at once, and never
retries a call by itself.

## Operations

`DATE` is `YYYY-MM-DD`. Times are ISO 8601 with offset, durations are minutes.

| Operation                              | Stdin                                     | Stdout                                            | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------- | ----------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health`                               | none                                      | `Health`                                          | Provider name, version, capabilities (`clock_times`, `split`, `explain`, `answer`, `refresh`, `mapping`), and whether classification is deferred.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `days --from DATE --to DATE`           | none                                      | `{"days": [DaySummary]}`                          | One summary per day in the range (inclusive), including empty days.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `day DATE`                             | `DayInput`                                | `Day`                                             | The day, cleaned and enriched: the `timeline` segments, plus blocks, gaps and questions. Roamgate passes everything it recorded for the day as input. If the input is unchanged (same `input_hash`) the provider may return its cached result. On a cache miss it may return a partial `Day` with `refreshing: true` and finish in the background; Roamgate then polls with backoff only while the view is open and never runs two provider processes for one day.                                                                                                                                |
| `refresh DATE`                         | `DayInput`                                | `Day` or `{"accepted": true}`                     | Same, but forced: re-collect the provider's own sources and re-propose. Blocks the user edited or accepted are kept. Never writes to the external system. A long run may return `accepted` and set `Day.refreshing` until done.                                                                                                                                                                                                                                                                                                                                                                   |
| `targets`                              | none                                      | `{"targets": [Target], "task_types": [TaskType]}` | The destinations a block can be assigned to and the task types.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `block-create DATE`                    | `BlockCreate`                             | `Block`                                           | Add a manual block, for example to claim a gap. It must lie within the day and may not overlap another block. It is the user's own: a recompute never removes it.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `block-update DATE ID`                 | `BlockPatch`                              | `Block`                                           | Edit target, task type, description or times. Editing teaches the provider and submits nothing, and resets acceptance. Changing the times of a computed block replaces it by a block of the user's own with a new id, which the response returns.                                                                                                                                                                                                                                                                                                                                                 |
| `block-delete DATE ID`                 | none                                      | `{}`                                              | Remove a block from the proposal only. A recompute does not bring it back. A submitted block cannot be deleted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `block-split DATE ID --at T`           | none                                      | `[Block, Block]`                                  | Split at a point strictly inside the block. Both halves are the user's own blocks with new ids and start unaccepted. A question stays a question for each half.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `block-answer DATE ID`                 | `{"option_id": "...", "remember": false}` | `Block`                                           | Answer a `needs_input` block. The block becomes `proposed` or `skipped` ("do not log").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `block-accept DATE ID`                 | none                                      | `Block`                                           | Mark accepted. Local only, not submitted. Refused for a `needs_input` block.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `block-explain DATE ID`                | none                                      | `Explanation`                                     | Why this target: reasoning, inputs and what decided it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `submit-preview DATE [--block ID ...]` | none                                      | `Preview`                                         | Writes nothing. Returns the exact changes (after a dry-run diff against what already exists, to avoid duplicates) and a one-time `confirm_token` bound to that content and the day's state.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `submit DATE`                          | `{"confirm_token": "..."}`                | `SubmitResult`                                    | Writes the previewed changes. Only with a valid token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `mapping-set`                          | `MappingSet`                              | `Mapping`                                         | Correct where a workspace's time goes (or, with `subject`, where every workspace of that subject goes). `allocations` are shares whose percents add up to 100: one share maps all the time, several split each block's time between projects (`target: null` is a share not logged). Always recorded as an answer the model sees as a precedent. With `remember: true` it becomes a standing mapping that every later `day` applies, and cached days are recomputed. A workspace mapping beats a subject mapping, which beats pins and remembered answers. Writes nothing to the external system. |
| `mappings`                             | none                                      | `Mappings`                                        | The standing mappings, so Roamgate can show each workspace's current mapping.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `mapping-delete`                       | `MappingDelete`                           | `{}`                                              | Remove a standing mapping, by `workspace_id` or by `subject` label (exactly one). Not found is an error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

`mapping-set` takes the workspace's id and name and, for a subject correction,
its `Subject`, and `allocations`: shares of the time, each a `Target` from
`targets` (or null, not logged), a task type and a whole percent, adding up to
100. One share of 100 is a plain mapping; with several, the provider cuts each
block of that time into consecutive pieces in proportion. Roamgate keeps no
mapping itself: the timeline's **Project** column shows `mappings` and sends
corrections with `mapping-set`.

## What leaves Roamgate

`day` and `refresh` get a `DayInput`: the day's events, the workspaces they
refer to with their [subjects](./activity.md#subjects), the day's recording
gaps, the `timezone`, `day_start` and `idle_seconds` (how long a sign of a
person lasts; Herdr's TUI focus counts only within it). Connections in
`activity.exclude.connections` and workspaces whose subject, or one of its
groups, is in `activity.exclude.subjects` (by id or label) are left out: the
time they had the attention is sent as recording gaps with `excluded: true` and
nothing else.

## Submitting

Nothing reaches the external system but `submit`, and only when the user asks:

- `submit-preview` writes nothing and returns the exact changes and a one-time
  `confirm_token`.
- Roamgate forwards `submit` only with `confirmed: true`, which only the
  explicit confirmation of a shown preview sends, and only with a token that a
  `submit-preview` of the same day returned through this bridge within the
  last 15 minutes. A token is forwarded once, whatever the outcome; to retry,
  preview again.
- Nothing in Roamgate submits on its own: no schedule, no agent or assistant
  tool can.

A provider must reject a missing, reused, expired or mismatched token, never
submit a `needs_input` block, and diff against what already exists so that a
repeated preview cannot duplicate entries.

## The Hours view

The activity timeline's **Hours** tab (also in the command menu and the
application menu) shows the provider's day: `day` when a date is shown, polled
every few seconds (2 s up to 15 s) while the day says `refreshing`; **Refresh**
runs `refresh`. After every block operation the day is read again, since a
block's id can change. Questions are answered with `block-answer` (the
**Remember** box is `remember`). **Preview submit** is off while a block is
`needs_input`; it runs `submit-preview`, then a confirmation step whose
**I checked these entries** box enables **Submit**, which sends the token with
`confirmed: true`. A failed submit shows what was written. A deferred day shows the provider's
`deferred_reason`. Reported time is whole 15-minute units, rounded up
(37 minutes worked is reported as 45); when rounding runs into the next block,
that block gives way, and an accepted block moved that way is proposed again,
which the view points out ("Moved by a neighbour: accept again"). A block shows
its reported `minutes` and, when it differs, the time worked
(`worked_minutes`). Split offers whole units only, so a one-unit block cannot
be split. The preview shows the time worked beside the time reported. A
`too_short` refusal (a safety check of `submit-preview`) says that a block must
last at least 15 minutes.

## In the bridge

The browser calls `bridge.time_report` with `{"op": "...", ...}`: `date`,
`block`, `at`, `from`, `to`, `blocks` (for `submit-preview`), `body` (stdin)
and, for `submit`, `confirm_token` and `confirmed`. The reply is
`{"ok": true, "value": ...}`, or `{"ok": false, "error", "code", "partial"}`
with the provider's code, `timeout`, or `not_configured`.
