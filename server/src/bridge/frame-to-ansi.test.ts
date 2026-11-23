import { runVectors } from "../../../contract/vectors/vectors";
import * as frameToAnsi from "./frame-to-ansi";

// The cases are contract/vectors/frame-to-ansi.json, the Rust side's too.
runVectors("frame-to-ansi", { "frame-to-ansi": frameToAnsi });
