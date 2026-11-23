import { runVectors } from "../contract/vectors/vectors";
import * as fileAnchors from "./fileAnchors";

// The cases are contract/vectors/file-anchors.json, the Rust side's too.
runVectors("file-anchors", { fileAnchors });
