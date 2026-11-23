import { runVectors } from "../../../contract/vectors/vectors";
import * as sessionCompaction from "./session-compaction";

// The cases are contract/vectors/session-compaction.json, the Rust side's too.
runVectors("session-compaction", { "session-compaction": sessionCompaction });
