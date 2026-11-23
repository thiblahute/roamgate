import { runVectors } from "../contract/vectors/vectors";
import * as stateDelta from "./stateDelta";

// The cases are contract/vectors/state-delta.json, the Rust side's too.
runVectors("state-delta", { stateDelta });
