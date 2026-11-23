import { runVectors } from "../contract/vectors/vectors";
import * as mrReviewsMerge from "./mrReviewsMerge";

// The cases are contract/vectors/mr-reviews-merge.json, the Rust side's too.
runVectors("mr-reviews-merge", { mrReviewsMerge });
