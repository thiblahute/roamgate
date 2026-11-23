import { runVectors } from "../../../contract/vectors/vectors";
import * as tokenUsage from "./token-usage";

// The cases are contract/vectors/token-usage.json, the Rust side's too.
runVectors("token-usage", { "token-usage": tokenUsage });
