import { runVectors } from "../contract/vectors/vectors";
import * as renderedPage from "./renderedPage";

// The cases are contract/vectors/rendered-page.json, the Rust side's too.
runVectors("rendered-page", { renderedPage });
