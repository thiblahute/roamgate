import { runVectors } from "../contract/vectors/vectors";
import * as workspaceTree from "./workspaceTree";

// The cases are contract/vectors/workspace-tree.json, the Rust side's too.
runVectors("workspace-tree", { workspaceTree });
