import { runVectors } from "../../../contract/vectors/vectors";
import * as sessionArtifacts from "./session-artifacts";

// The cases are contract/vectors/session-artifacts.json, the Rust side's too.
runVectors("session-artifacts", { "session-artifacts": sessionArtifacts });
