import { runVectors } from "../contract/vectors/vectors";
import * as fileEdits from "./fileEdits";

// The cases are contract/vectors/file-edits.json, the Rust side's too.
runVectors("file-edits", { fileEdits });
