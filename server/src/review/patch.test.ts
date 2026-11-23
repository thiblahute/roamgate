import { runVectors } from "../../../contract/vectors/vectors";
import * as patch from "./patch";

// The cases are contract/vectors/patch.json, the Rust side's too.
runVectors("patch", { patch });
