import { runVectors } from "../../../contract/vectors/vectors";
import * as vtInputClassifier from "./vt-input-classifier";
import * as bincode from "./bincode";

// The cases are contract/vectors/vt-input-classifier.json, the Rust side's too.
runVectors("vt-input-classifier", {
  "vt-input-classifier": vtInputClassifier,
  bincode,
});
