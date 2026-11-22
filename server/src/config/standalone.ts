/** Whether this process is the standalone binary rather than `bun src/index.ts`. */
export function isStandaloneBinary(runtime: {
  execPath: string;
  argv: readonly string[];
}): boolean {
  const executable = runtime.execPath.split(/[\\/]/).pop()?.toLowerCase();
  return (
    executable !== "bun" &&
    executable !== "bun.exe" &&
    !(runtime.argv[1] ?? "").endsWith("src/index.ts")
  );
}
