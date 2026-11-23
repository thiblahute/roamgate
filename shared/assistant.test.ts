import { runVectors } from "../contract/vectors/vectors";
import * as assistant from "./assistant";

// The cases are contract/vectors/assistant.json, the Rust side's too.
runVectors("assistant", { assistant });
