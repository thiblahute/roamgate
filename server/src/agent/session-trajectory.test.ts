import { runVectors } from "../../../contract/vectors/vectors";
import * as sessionTrajectory from "./session-trajectory";
import * as sessionHistory from "./session-history";

// The cases are contract/vectors/session-trajectory.json, the Rust side's too.
runVectors("session-trajectory", {
  "session-trajectory": sessionTrajectory,
  "session-history": sessionHistory,
});
