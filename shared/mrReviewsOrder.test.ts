import { runVectors } from "../contract/vectors/vectors";
import * as mrReviewsOrder from "./mrReviewsOrder";

// The cases are contract/vectors/mr-reviews-order.json, the Rust side's too.
runVectors("mr-reviews-order", { mrReviewsOrder });
