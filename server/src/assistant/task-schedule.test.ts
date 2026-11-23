import { runVectors } from "../../../contract/vectors/vectors";
import * as taskSchedule from "./task-schedule";

// The cases are contract/vectors/task-schedule.json, the Rust side's too.
runVectors("task-schedule", { "task-schedule": taskSchedule });
