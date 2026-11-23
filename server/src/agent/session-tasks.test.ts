import { runVectors } from "../../../contract/vectors/vectors";
import * as sessionTasks from "./session-tasks";
import * as sessionRewind from "./session-rewind";

// The cases are contract/vectors/session-tasks.json, the Rust side's too.
runVectors("session-tasks", {
  "session-tasks": sessionTasks,
  "session-rewind": sessionRewind,
});
