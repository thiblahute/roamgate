import { runVectors } from "../contract/vectors/vectors";
import * as bashMode from "./bashMode";

// The cases are contract/vectors/bash-mode.json, the Rust side's too.
runVectors("bash-mode", { bashMode });
