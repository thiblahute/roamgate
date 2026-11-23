import { describe, expect, test } from "bun:test";
import { parseLogLevel } from "./logger";
import { runVectors } from "../../../contract/vectors/vectors";
import * as logger from "./logger";

describe("log level parsing", () => {
  test("rejects unstringifiable values without masking the error", () => {
    expect(() => parseLogLevel(10n)).toThrow(
      "invalid log level 10; expected error, warn, info, debug",
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => parseLogLevel(circular)).toThrow(
      "invalid log level [object Object]; expected error, warn, info, debug",
    );
  });
});

// The cases are contract/vectors/logger.json, the Rust side's too.
runVectors("logger", { logger });
