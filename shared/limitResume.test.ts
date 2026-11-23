import { runVectors } from "../contract/vectors/vectors";
import * as limitResume from "./limitResume";

// The cases are contract/vectors/limit-resume.json, the Rust side's too.
runVectors("limit-resume", { limitResume });
