import { runVectors } from "../contract/vectors/vectors";
import * as instanceName from "./instanceName";

// The cases are contract/vectors/instance-name.json, the Rust side's too.
runVectors("instance-name", { instanceName });
