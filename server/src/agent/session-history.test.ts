import { runVectors } from "../../../contract/vectors/vectors";
import * as sessionTrajectory from "./session-trajectory";
import * as sessionHistory from "./session-history";
import * as sessionMessages from "./session-messages";

// The cases are contract/vectors/session-history.json, the Rust side's too.
runVectors("session-history", {
  "session-trajectory": sessionTrajectory,
  "session-history": sessionHistory,
  "session-messages": sessionMessages,
});
