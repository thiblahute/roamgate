import { runVectors } from "../contract/vectors/vectors";
import * as mrReviewsFilter from "./mrReviewsFilter";

// The cases are contract/vectors/mr-reviews-filter.json, the Rust side's too.
runVectors("mr-reviews-filter", { mrReviewsFilter });
