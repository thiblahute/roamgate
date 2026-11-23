import { runVectors } from "../contract/vectors/vectors";
import * as agentModels from "./agentModels";

// The cases are contract/vectors/agent-models.json, the Rust side's too.
runVectors("agent-models", { agentModels });
