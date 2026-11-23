import { runVectors } from "../../../contract/vectors/vectors";
import * as commitAnchors from "./commit-anchors";

// The cases are contract/vectors/commit-anchors.json, the Rust side's too.
runVectors("commit-anchors", { "commit-anchors": commitAnchors });
