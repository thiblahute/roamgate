import { runVectors } from "../../../contract/vectors/vectors";
import * as sshCommand from "./ssh-command";

// The cases are contract/vectors/ssh-command.json, the Rust side's too.
runVectors("ssh-command", { "ssh-command": sshCommand });
