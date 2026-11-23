import { runVectors } from "../contract/vectors/vectors";
import * as toolSummary from "./toolSummary";

// The cases are contract/vectors/tool-summary.json, the Rust side's too.
runVectors("tool-summary", { toolSummary });
