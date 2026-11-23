import { runVectors } from "../../../contract/vectors/vectors";
import * as agentSessions from "./agent-sessions";

// The cases are contract/vectors/session-tasks-sessions.json, the Rust side's too.
runVectors("session-tasks-sessions", { "agent-sessions": agentSessions });
