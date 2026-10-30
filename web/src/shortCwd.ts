/**
 * A directory as a short label: the home directory as `~` (macOS, Linux,
 * Windows homes and root's), and a long path cut to its last parts.
 */
export function shortCwd(path: string, max = 40): string {
  const trimmed = path.replace(/[\\/]+$/, "") || path;
  const home =
    /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)(?=$|[\\/])/;
  const short = trimmed.replace(home, "~");
  if (short.length <= max) return short;
  const separator = short.includes("\\") && !short.includes("/") ? "\\" : "/";
  const parts = short.split(separator);
  let tail = parts.pop() ?? short;
  while (parts.length > 1) {
    const next = `${parts[parts.length - 1]}${separator}${tail}`;
    if (next.length + 5 > max) break;
    tail = next;
    parts.pop();
  }
  const head = parts[0] === "~" ? "~" : "";
  return `${head}${head ? separator : ""}...${separator}${tail}`;
}
