/** Common Files preview fixtures shared by the independent DOM suites. */
export const settlePreview = async () => {
  for (let i = 0; i < 20; i++)
    await new Promise((resolve) => setTimeout(resolve, 0));
};

export const previewEntry = (path: string) => ({
  name: path,
  path,
  type: "file" as const,
  size: 1,
  mtime_ms: 0,
  hidden: false,
});

export const previewFile = (path: string, text: string, mtime = 0) => ({
  workspace_id: "w1",
  checkout_path: "/repo",
  root: "/repo",
  path,
  size: text.length,
  mtime_ms: mtime,
  text,
  binary: false,
  truncated: false,
});
