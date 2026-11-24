import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shQuote } from "../utils/process-utils";
import { createFileHandlers } from "./files";
import { runBinaryProcessWithTimeout, spawnStreamingProcess } from "./process";

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "herdr-gui-handler-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("workspace file handlers", () => {
  test("commit history reports a non-Git workspace without inventing an empty history", async () => {
    const processes: string[][] = [];
    const diagnostic =
      "fatal: not a git repository (or any of the parent directories): .git";
    const handlers = createFileHandlers({
      herdr: {
        call: async (method: string) => {
          if (method === "workspace.get")
            return { workspace: { cwd: "/preview" } };
          if (method === "pane.list")
            return {
              panes: [
                { workspace_id: "w1", focused: true, cwd: "/preview" },
                { workspace_id: "other", cwd: "/unrelated-repo" },
              ],
            };
          throw new Error(`unexpected call ${method}`);
        },
      } as any,
      sshHost: () => undefined,
      shQuote,
      runProcessWithCodeTimeout: async (argv) => {
        processes.push(argv);
        return { code: 128, stdout: "", stderr: diagnostic };
      },
    });
    await expect(
      handlers.readGitCommits({ workspace_id: "w1" }),
    ).rejects.toThrow(diagnostic);
    expect(processes).toEqual([
      ["git", "-C", "/preview", "rev-parse", "--show-toplevel"],
    ]);
  });

  test("commit history uses the workspace checkout and renders an unborn HEAD as empty", async () => {
    const processes: string[][] = [];
    const handlers = createFileHandlers({
      herdr: {
        call: async (method: string) => {
          if (method === "workspace.get")
            return {
              workspace: {
                worktree: { checkout_path: "/checkout" },
                cwd: "/preview",
              },
            };
          throw new Error(`unexpected call ${method}`);
        },
      } as any,
      sshHost: () => undefined,
      shQuote,
      runProcessWithCodeTimeout: async (argv) => {
        processes.push(argv);
        return processes.length === 1
          ? { code: 0, stdout: "/checkout\n", stderr: "" }
          : { code: 1, stdout: "", stderr: "" };
      },
    });
    await expect(
      handlers.readGitCommits({ workspace_id: "w1" }),
    ).resolves.toEqual({
      head: null,
      commits: [],
      has_more: false,
      shallow: false,
    });
    expect(processes).toHaveLength(2);
    expect(processes[0]).toEqual([
      "git",
      "-C",
      "/checkout",
      "rev-parse",
      "--show-toplevel",
    ]);
    expect(processes[1]?.at(-1)).toContain(
      "git -C '/checkout' rev-parse -q --verify 'HEAD^{commit}'",
    );
  });

  test("PR/MR reads accept only available worktrees listed for the source repository, locally and over SSH", async () => {
    for (const host of [undefined, "user@server"]) {
      const processes: string[][] = [];
      const target = "/repo with 'quote/topic";
      const handlers = createFileHandlers({
        herdr: {
          call: async (method: string, params: Record<string, unknown>) => {
            expect(params.workspace_id).toBe("w1");
            if (method === "workspace.get")
              return { workspace: { worktree: { checkout_path: "/repo" } } };
            if (method === "worktree.list")
              return {
                worktrees: [
                  { path: target },
                  { path: "/repo/bare", is_bare: true },
                  { path: "/repo/gone", is_prunable: true },
                ],
              };
            throw new Error(`unexpected call ${method}`);
          },
        } as any,
        sshHost: () => host,
        shQuote,
        runProcessWithCodeTimeout: async (argv, _timeout, options) => {
          processes.push(argv);
          if (argv.join(" ").includes("rev-parse"))
            return { code: 0, stdout: "/repo\n", stderr: "" };
          if (host) {
            expect(argv[0]).toBe("ssh");
            expect(argv.at(-1)).toContain(`cd ${shQuote(target)} &&`);
          } else {
            expect(options?.cwd).toBe(target);
          }
          return { code: 1, stdout: "", stderr: "" };
        },
      });
      const status = await handlers.readWorkspacePullRequest({
        workspace_id: "w1",
        worktree_path: target,
        summary: true,
      });
      expect(status.root).toBe(target);
      expect(status.state).toBe("detached");
      for (const worktree_path of ["/other/repo", 42]) {
        processes.length = 0;
        const result = await handlers.readWorkspacePullRequest({
          workspace_id: "w1",
          worktree_path,
        });
        expect(result.state).toBe("error");
        expect(result.message).toContain("Worktree is unavailable");
        expect("retryable" in result).toBe(false);
        expect(processes).toHaveLength(1);
      }
      for (const worktree_path of ["/repo/bare", "/repo/gone"]) {
        processes.length = 0;
        const result = await handlers.readWorkspacePullRequest({
          workspace_id: "w1",
          worktree_path,
        });
        expect(result.state).toBe("unsupported");
        expect(result.message).toContain("Bare or prunable");
        expect(processes).toHaveLength(1);
      }
    }
  });
  test("falls back to focused pane cwd when workspace has no checkout path", async () => {
    await withTempDir(async (root) => {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "README.md"), "hello");
      const calls: string[] = [];
      const handlers = createFileHandlers({
        herdr: {
          call: async (method: string) => {
            calls.push(method);
            if (method === "workspace.get") {
              return { workspace: { workspace_id: "w1", label: "Repo" } };
            }
            if (method === "pane.list") {
              return {
                panes: [
                  {
                    workspace_id: "w1",
                    focused: true,
                    foreground_cwd: root,
                  },
                ],
              };
            }
            throw new Error(`unexpected call ${method}`);
          },
        } as any,
        sshHost: () => undefined,
        runProcessWithCodeTimeout: async () => ({
          code: 0,
          stdout: root,
          stderr: "",
        }),
        shQuote,
      });

      const list = await handlers.listWorkspaceFiles({ workspace_id: "w1" });
      expect(list).toMatchObject({
        workspace_id: "w1",
        repo_name: "Repo",
        checkout_path: root,
      });
      expect(list.entries.map((entry) => entry.name)).toEqual([
        "src",
        "README.md",
      ]);
      expect(calls).toEqual(["workspace.get", "pane.list"]);
    });
  });

  test("a ~/ path is read from the host's home, and a missing one says so", async () => {
    await withTempDir(async (dir) => {
      const home = join(dir, "home");
      const checkout = join(dir, "checkout");
      await mkdir(join(home, "out"), { recursive: true });
      await mkdir(checkout);
      await writeFile(join(home, "out", "notes.md"), "# Notes");
      const handlers = createFileHandlers({
        herdr: {
          call: async (method: string) => {
            if (method === "workspace.get")
              return { workspace: { worktree: { checkout_path: checkout } } };
            throw new Error(`unexpected call ${method}`);
          },
        } as any,
        sshHost: () => undefined,
        runProcessWithCodeTimeout: async () => ({
          code: 0,
          stdout: "",
          stderr: "",
        }),
        shQuote,
        localHome: () => home,
      });
      const read = await handlers.readWorkspaceFile({
        workspace_id: "w1",
        path: "~/out/notes.md",
      });
      expect(read.path).toBe(join(home, "out", "notes.md"));
      expect(read.text).toBe("# Notes");
      const stat = await handlers.statWorkspaceFile({
        workspace_id: "w1",
        path: "~/out/notes.md",
      });
      expect(stat.type).toBe("file");
      await expect(
        handlers.readWorkspaceFile({
          workspace_id: "w1",
          path: "~/out/gone.wav",
        }),
      ).rejects.toThrow(`${join(home, "out", "gone.wav")} was not found`);
    });
  });

  test("a ~/ path on an SSH host is in the home the host says, asked once", async () => {
    const commands: string[] = [];
    const handlers = createFileHandlers({
      herdr: {
        call: async (method: string) => {
          if (method === "workspace.get")
            return { workspace: { worktree: { checkout_path: "/repo" } } };
          throw new Error(`unexpected call ${method}`);
        },
      } as any,
      sshHost: () => "remote",
      runProcessWithCodeTimeout: async (argv) => {
        const command = argv.at(-1)!;
        commands.push(command);
        if (command === 'printf %s "$HOME"')
          return { code: 0, stdout: "/home/far\n", stderr: "" };
        return { code: 1, stdout: "", stderr: "stop" };
      },
      shQuote,
    });
    for (let i = 0; i < 2; i++)
      await expect(
        handlers.readWorkspaceFile({ workspace_id: "w1", path: "~/a.wav" }),
      ).rejects.toThrow("stop");
    expect(commands.filter((each) => each.includes("$HOME"))).toHaveLength(1);
    expect(commands.at(-1)).toContain(shQuote("/home/far/a.wav"));
  });

  test("prefers pane cwd over an agent foreground directory for git operations", async () => {
    const calls: string[][] = [];
    const handlers = createFileHandlers({
      herdr: {
        call: async (method: string) => {
          if (method === "workspace.get") {
            return { workspace: { workspace_id: "w1", label: "Repo" } };
          }
          if (method === "pane.list") {
            return {
              panes: [
                {
                  workspace_id: "w1",
                  focused: true,
                  cwd: "/repo",
                  foreground_cwd: "/agent/plugin",
                },
              ],
            };
          }
          throw new Error(`unexpected call ${method}`);
        },
      } as any,
      sshHost: () => undefined,
      runProcessWithCodeTimeout: async (argv) => {
        calls.push(argv);
        return { code: 0, stdout: "/repo\n", stderr: "" };
      },
      shQuote,
    });

    await expect(
      handlers.resolveWorkspaceGitRoot({ workspace_id: "w1" }),
    ).resolves.toMatchObject({ root: "/repo" });
    expect(calls).toEqual([
      ["git", "-C", "/repo", "rev-parse", "--show-toplevel"],
    ]);
  });

  test("finds the repository of another pane when none of the workspace is focused", async () => {
    // Herdr focuses one pane in all of its workspaces: here another
    // workspace's. The workspace's folder holds repositories without being
    // one; its second pane is in one of them.
    const calls: string[][] = [];
    const handlers = createFileHandlers({
      herdr: {
        call: async (method: string) => {
          if (method === "workspace.get")
            return { workspace: { workspace_id: "w1", label: "blog" } };
          if (method === "pane.list")
            return {
              panes: [
                { workspace_id: "other", focused: true, cwd: "/elsewhere" },
                {
                  workspace_id: "w1",
                  cwd: "/devel",
                  foreground_cwd: "/devel",
                },
                {
                  workspace_id: "w1",
                  cwd: "/devel/blog",
                  foreground_cwd: "/devel/blog",
                },
              ],
            };
          throw new Error(`unexpected call ${method}`);
        },
      } as any,
      sshHost: () => undefined,
      runProcessWithCodeTimeout: async (argv) => {
        calls.push(argv);
        return argv[2] === "/devel/blog"
          ? { code: 0, stdout: "/devel/blog\n", stderr: "" }
          : {
              code: 128,
              stdout: "",
              stderr:
                "fatal: not a git repository (or any of the parent directories): .git",
            };
      },
      shQuote,
    });

    await expect(
      handlers.resolveWorkspaceGitRoot({ workspace_id: "w1" }),
    ).resolves.toMatchObject({ root: "/devel/blog" });
    expect(calls).toEqual([
      ["git", "-C", "/devel", "rev-parse", "--show-toplevel"],
      ["git", "-C", "/devel/blog", "rev-parse", "--show-toplevel"],
    ]);
  });

  test("tries the focused pane of the workspace before its others", async () => {
    const handlers = createFileHandlers({
      herdr: {
        call: async (method: string) => {
          if (method === "workspace.get")
            return { workspace: { workspace_id: "w1" } };
          if (method === "pane.list")
            return {
              panes: [
                { workspace_id: "w1", cwd: "/first" },
                { workspace_id: "w1", focused: true, cwd: "/focused" },
              ],
            };
          throw new Error(`unexpected call ${method}`);
        },
      } as any,
      sshHost: () => undefined,
      runProcessWithCodeTimeout: async (argv) => ({
        code: 0,
        stdout: `${argv[2]}\n`,
        stderr: "",
      }),
      shQuote,
    });

    await expect(
      handlers.resolveWorkspaceGitRoot({ workspace_id: "w1" }),
    ).resolves.toMatchObject({ root: "/focused" });
  });

  test("reads another repository of the workspace when asked by its root, and no other", async () => {
    const calls: string[][] = [];
    const handlers = createFileHandlers({
      herdr: {
        call: async (method: string) => {
          if (method === "workspace.get")
            return { workspace: { workspace_id: "w1", label: "Repo" } };
          if (method === "pane.list")
            return {
              panes: [
                { workspace_id: "w1", focused: true, cwd: "/ws/app" },
                { workspace_id: "w2", cwd: "/elsewhere" },
              ],
            };
          throw new Error(`unexpected call ${method}`);
        },
      } as any,
      sshHost: () => undefined,
      runProcessWithCodeTimeout: async (argv) => {
        calls.push(argv);
        const at = argv.indexOf("-C");
        const dir = argv[at + 1] ?? "";
        // /ws/app/lib is a subdirectory of /ws/app, not a repository.
        return {
          code: 0,
          stdout: `${dir === "/ws/app/lib" ? "/ws/app" : dir}\n`,
          stderr: "",
        };
      },
      shQuote,
    });
    // Under a pane's directory, or holding it: read there.
    for (const root of ["/ws/app/vendor/sub", "/ws"]) {
      calls.length = 0;
      await expect(
        handlers.resolveWorkspaceGitRoot({ workspace_id: "w1", root }),
      ).resolves.toMatchObject({ root });
      expect(calls).toEqual([
        ["git", "-C", root, "rev-parse", "--show-toplevel"],
      ]);
    }
    // Another workspace's directory, a relative path, not a top level.
    for (const root of ["/elsewhere", "ws/app", "/ws/app/../../etc"]) {
      await expect(
        handlers.resolveWorkspaceGitRoot({ workspace_id: "w1", root }),
      ).rejects.toThrow();
    }
    await expect(
      handlers.resolveWorkspaceGitRoot({
        workspace_id: "w1",
        root: "/ws/app/lib",
      }),
    ).rejects.toThrow("top level");
  });

  test("reads the repository of a review held for the connection in any workspace, exactly its root", async () => {
    const calls: string[][] = [];
    const handlers = createFileHandlers({
      herdr: {
        call: async (method: string) => {
          if (method === "workspace.get")
            return { workspace: { workspace_id: "w1", label: "Repo" } };
          if (method === "pane.list")
            return { panes: [{ workspace_id: "w1", cwd: "/ws/app" }] };
          throw new Error(`unexpected call ${method}`);
        },
      } as any,
      sshHost: () => undefined,
      runProcessWithCodeTimeout: async (argv) => {
        calls.push(argv);
        const at = argv.indexOf("-C");
        return { code: 0, stdout: `${argv[at + 1] ?? ""}\n`, stderr: "" };
      },
      shQuote,
      // A review from elsewhere: its repository is no pane's.
      reviewRoots: () => ["/reviews/other/"],
    });
    await expect(
      handlers.resolveWorkspaceGitRoot({
        workspace_id: "w1",
        root: "/reviews/other",
      }),
    ).resolves.toMatchObject({ root: "/reviews/other" });
    // Not what lies below or above it, nor anything else.
    for (const root of ["/reviews/other/sub", "/reviews", "/elsewhere"]) {
      await expect(
        handlers.resolveWorkspaceGitRoot({ workspace_id: "w1", root }),
      ).rejects.toThrow("not a repository of this workspace");
    }
  });

  test("returns download responses with safe headers", async () => {
    await withTempDir(async (root) => {
      await writeFile(join(root, "测试.txt"), "hello");
      await writeFile(join(root, "guide.pdf"), "%PDF-1.7");
      const handlers = createFileHandlers({
        herdr: {
          call: async (method: string) => {
            if (method === "workspace.get") {
              return {
                workspace: {
                  workspace_id: "w1",
                  worktree: { checkout_path: root, repo_name: "Repo" },
                },
              };
            }
            throw new Error(`unexpected call ${method}`);
          },
        } as any,
        sshHost: () => undefined,
        runProcessWithCodeTimeout: async () => ({
          code: 0,
          stdout: root,
          stderr: "",
        }),
        shQuote,
      });

      const response = await handlers.downloadWorkspaceFile({
        workspace_id: "w1",
        path: "测试.txt",
      });
      expect(response.headers.get("content-disposition")).toContain(
        'filename="__.txt"',
      );
      expect(response.headers.get("x-file-path")).toBe(
        encodeURIComponent("测试.txt"),
      );
      expect(await response.text()).toBe("hello");

      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
      await writeFile(join(root, "vector.svg"), svg);
      const svgResponse = await handlers.downloadWorkspaceFile({
        workspace_id: "w1",
        path: "vector.svg",
        inline: true,
      });
      expect(svgResponse.headers.get("content-type")).toBe("image/svg+xml");
      expect(svgResponse.headers.get("content-security-policy")).toBe(
        "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      );
      expect(svgResponse.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await svgResponse.text()).toBe(svg);

      const inlineResponse = await handlers.downloadWorkspaceFile({
        workspace_id: "w1",
        path: "guide.pdf",
        inline: true,
      });
      expect(inlineResponse.headers.get("content-type")).toBe(
        "application/pdf",
      );
      expect(inlineResponse.headers.get("content-disposition")).toContain(
        "inline;",
      );
      expect(inlineResponse.headers.get("cache-control")).toBe(
        "private, no-store",
      );
      expect(inlineResponse.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
      expect(await inlineResponse.text()).toBe("%PDF-1.7");

      await writeFile(join(root, "take.wav"), "RIFF");
      const audioResponse = await handlers.downloadWorkspaceFile({
        workspace_id: "w1",
        path: "take.wav",
        inline: true,
      });
      expect(audioResponse.headers.get("content-type")).toBe("audio/wav");
      expect(audioResponse.headers.get("content-disposition")).toContain(
        "inline;",
      );
      expect(audioResponse.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
      expect(await audioResponse.text()).toBe("RIFF");
    });
  });

  test("downloads a large APK whole and streamed, as an Android package, locally and over SSH", async () => {
    await withTempDir(async (root) => {
      await mkdir(join(root, "app", "build"), { recursive: true });
      // Far past the 512 KB preview and the old base64 read over SSH.
      const size = 20 * 1024 * 1024 + 123;
      const bytes = Buffer.alloc(size);
      for (let i = 0; i < size; i += 4096) bytes[i] = (i / 4096) & 0xff;
      await writeFile(join(root, "app", "build", "app-debug.apk"), bytes);
      const digest = (data: ArrayBuffer | Buffer) =>
        new Bun.CryptoHasher("sha256").update(data).digest("hex");
      for (const host of [undefined, "user@server"]) {
        const streamed: string[][] = [];
        const runLocally = (argv: string[]) => [
          "bash",
          "-c",
          argv[argv.length - 1]!,
        ];
        const handlers = createFileHandlers({
          herdr: {
            call: async (method: string) => {
              if (method === "workspace.get")
                return {
                  workspace: {
                    workspace_id: "w1",
                    worktree: { checkout_path: root, repo_name: "Repo" },
                  },
                };
              throw new Error(`unexpected call ${method}`);
            },
          } as any,
          sshHost: () => host,
          // Over SSH only the metadata is read this way: never the file.
          runProcessWithCodeTimeout: async (argv, timeout) => {
            const result = await runBinaryProcessWithTimeout(
              runLocally(argv),
              timeout,
            );
            expect(result.stdout.length).toBeLessThan(4096);
            return { ...result, stdout: result.stdout.toString("utf8") };
          },
          streamProcess: async (argv) => {
            expect(argv[0]).toBe("ssh");
            streamed.push(argv);
            return spawnStreamingProcess(runLocally(argv));
          },
          shQuote,
        });
        const response = await handlers.downloadWorkspaceFile({
          workspace_id: "w1",
          path: "app/build/app-debug.apk",
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
          "application/vnd.android.package-archive",
        );
        expect(response.headers.get("content-length")).toBe(String(size));
        expect(response.headers.get("content-disposition")).toContain(
          'filename="app-debug.apk"',
        );
        expect(response.body).toBeInstanceOf(ReadableStream);
        const body = await response.arrayBuffer();
        expect(body.byteLength).toBe(size);
        expect(digest(body)).toBe(digest(bytes));
        expect(streamed).toHaveLength(host ? 1 : 0);
      }
    });
  });

  test("resolves existing workspace-relative files and directories in one batch", async () => {
    await withTempDir(async (root) => {
      await mkdir(join(root, "a", "b"), { recursive: true });
      await writeFile(join(root, "a", "b", "c.png"), "image");
      const handlers = createFileHandlers({
        herdr: {
          call: async (method: string) => {
            if (method === "workspace.get") {
              return {
                workspace: {
                  workspace_id: "w1",
                  worktree: { checkout_path: root, repo_name: "Repo" },
                },
              };
            }
            throw new Error(`unexpected call ${method}`);
          },
        } as any,
        sshHost: () => undefined,
        runProcessWithCodeTimeout: async () => ({
          code: 0,
          stdout: "",
          stderr: "",
        }),
        shQuote,
      });

      expect(
        await handlers.resolveWorkspaceFiles({
          workspace_id: "w1",
          paths: [
            "a/b/c.png",
            "./a/b/c.png",
            "a/b",
            "missing/file.png",
            "../outside.txt",
          ],
        }),
      ).toMatchObject({
        workspace_id: "w1",
        checkout_path: root,
        files: [
          { candidate: "a/b/c.png", path: "a/b/c.png" },
          { candidate: "./a/b/c.png", path: "a/b/c.png" },
          { candidate: "a/b", path: "a/b" },
        ],
      });
    });
  });

  test("validates required workspace ids", async () => {
    const handlers = createFileHandlers({
      herdr: { call: async () => ({}) } as any,
      sshHost: () => undefined,
      runProcessWithCodeTimeout: async () => ({
        code: 0,
        stdout: "",
        stderr: "",
      }),
      shQuote,
    });

    await expect(handlers.listWorkspaceFiles({})).rejects.toThrow(
      "file.list requires workspace_id",
    );
    await expect(
      handlers.readWorkspaceFile({ path: "README.md" }),
    ).rejects.toThrow("file.read requires workspace_id");
    await expect(handlers.resolveWorkspaceFiles({ paths: [] })).rejects.toThrow(
      "file.resolve requires workspace_id",
    );
  });
});
