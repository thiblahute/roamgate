/**
 * The Pi sidecar (contract/wire/pi-sidecar.md): Pi's drivers served over
 * stdin and stdout, for a server that does not run Pi itself. Compiled to
 * the standalone `roamgate-pi` (`bun run compile:pi`), or run from source
 * as `bun server/src/assistant/pi-sidecar-main.ts`. It exits when its stdin
 * closes.
 */
import { createPiDriver } from "./pi-driver";
import { servePiSidecarStdio } from "./pi-sidecar-server";

await servePiSidecarStdio((directory, credentialDirectory) =>
  createPiDriver(directory, undefined, credentialDirectory),
);
