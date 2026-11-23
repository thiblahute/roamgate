import { runVectors } from "../contract/vectors/vectors";
import * as agentProfiles from "./agentProfiles";

// The cases are contract/vectors/agent-profiles.json, the Rust side's too.
runVectors("agent-profiles", { agentProfiles });
