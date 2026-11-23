import { runVectors } from "../contract/vectors/vectors";
import * as speechRate from "./speechRate";

// The cases are contract/vectors/speech-rate.json, the Rust side's too.
runVectors("speech-rate", { speechRate });
