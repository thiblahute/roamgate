import { runVectors } from "../../../../contract/vectors/vectors";
import * as drivers from "./index";

// The cases are contract/vectors/driver-contract.json, the Rust side's too.
runVectors("driver-contract", { drivers });
