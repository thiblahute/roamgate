import { runVectors } from "../contract/vectors/vectors";
import * as agentMessage from "./agentMessage";
import * as injectedMessage from "./injectedMessage";

// The cases are contract/vectors/agent-message.json, the Rust side's too.
runVectors("agent-message", { agentMessage, injectedMessage });
