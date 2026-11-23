import { runVectors } from "../../../contract/vectors/vectors";
import * as sessionCommands from "./session-commands";

// The cases are contract/vectors/session-commands.json, the Rust side's too.
runVectors("session-commands", { "session-commands": sessionCommands });
