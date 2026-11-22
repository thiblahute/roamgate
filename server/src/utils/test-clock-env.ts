/**
 * Imported first by the server entry point, so every module reads time
 * from the test clock when `ROAMGATE_TEST_CLOCK` asks for it (see
 * test-clock.ts). Without the variable this does nothing.
 */
import { installTestClockFromEnv } from "./test-clock";

try {
  installTestClockFromEnv();
} catch (error) {
  process.stderr.write(`roamgate: ${(error as Error).message}\n`);
  process.exit(1);
}
