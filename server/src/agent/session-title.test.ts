import { runVectors } from "../../../contract/vectors/vectors";
import * as sessionTitle from "./session-title";

// The cases are contract/vectors/session-title.json, the Rust side's too.
runVectors("session-title", { "session-title": sessionTitle });
