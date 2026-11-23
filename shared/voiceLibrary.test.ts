import { runVectors } from "../contract/vectors/vectors";
import * as voiceLibrary from "./voiceLibrary";

// The cases are contract/vectors/voice-library.json, the Rust side's too.
runVectors("voice-library", { voiceLibrary });
