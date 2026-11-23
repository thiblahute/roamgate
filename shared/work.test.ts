import { runVectors } from "../contract/vectors/vectors";
import * as work from "./work";

// The cases are contract/vectors/work.json, the Rust side's too.
runVectors("work", { work });
