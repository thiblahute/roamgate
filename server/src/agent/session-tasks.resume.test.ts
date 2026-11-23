import { runVectors } from "../../../contract/vectors/vectors";
import * as sessionTasks from "./session-tasks";
import * as agentSessions from "./agent-sessions";

// The cases are contract/vectors/session-tasks-resume.json, the Rust side's too.
runVectors("session-tasks-resume", {
  "session-tasks": sessionTasks,
  "agent-sessions": agentSessions,
});
