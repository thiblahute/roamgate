import { runVectors } from "../../../contract/vectors/vectors";
import * as sessionHistory from "./session-history";

// The cases are contract/vectors/session-history-agent-message.json, the Rust side's too.
runVectors("session-history-agent-message", {
  "session-history": sessionHistory,
});
