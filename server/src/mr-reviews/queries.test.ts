import { runVectors } from "../../../contract/vectors/vectors";
import * as queries from "./queries";

// The cases are contract/vectors/mr-queries.json, the Rust side's too.
runVectors("mr-queries", { queries });
