import { inIsolatedChild } from "../testIsolated";
import { describe, expect, test } from "bun:test";

/**
 * FEATURES.md against the keys (plan: review into the inspector, each
 * phase's docs step): the review's app shortcuts it names are the default
 * bindings, and the review keys its Review section documents are the ones
 * the review's shortcut list (`?`) shows. Runs against every review
 * surface (reviewSurfaces.testkit.ts).
 */
if (
  inIsolatedChild(
    import.meta.path,
    "review keys against FEATURES.md in an isolated DOM runtime",
    "ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST",
    30_000,
  )
) {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { installReviewDom, file, hunk } = await import(
    "./reviewSurface.testkit"
  );
  await installReviewDom();
  const { reviewSurfacesWith } = await import("./reviewSurfaces.testkit");
  const { defaultShortcutBindings, formatShortcut } = await import(
    "../shortcutBindings"
  );

  const features = readFileSync(
    join(import.meta.dir, "../../../FEATURES.md"),
    "utf8",
  );
  /** A `## ` section of FEATURES.md, up to the next one. */
  const section = (title: string) => {
    const start = features.indexOf(`\n## ${title}\n`);
    if (start < 0) throw new Error(`no section ${title}`);
    const end = features.indexOf("\n## ", start + 1);
    return features.slice(start, end < 0 ? undefined : end);
  };
  const review = section("Review");
  /** Every key a section names in backticks (`gu`/`gU`, `R`, `gr`, `:e`). */
  const documented = (text: string) =>
    new Set(
      [...text.matchAll(/`([^`]+)`/g)].flatMap((match) =>
        match[1]!.split(/[\s/]+/).filter(Boolean),
      ),
    );

  /**
   * The review keys the Review section documents, as the review's own
   * shortcut list writes them.
   */
  const REVIEW_SECTION_KEYS = [
    "R",
    "gr",
    ":e",
    "c",
    "C",
    "t",
    "T",
    ":conversations",
    "gn",
    "gN",
    "gH",
    ":unresolved",
    "za",
    "gl",
    "g;",
    "e",
    "gf",
    "<",
    ">",
    "gc",
    ":commits",
    "o",
    "r",
    "gu",
    "gU",
    ":unreviewed",
    "V",
    "v",
    "p",
    "(",
    ")",
    ":hold",
    ":send",
    "gm",
    ":switch",
    "zo",
    "zO",
    "zR",
    "n",
    "N",
    "j",
    "k",
    ":files",
    ":overall",
    ":vim",
    ":all",
  ];

  test("the review's app shortcuts FEATURES.md names are the default bindings; its shortcut table has their rows", () => {
    const mac = defaultShortcutBindings("mac");
    const linux = defaultShortcutBindings("linux");
    const windows = defaultShortcutBindings("windows");
    const shown = (keys: string[]) => formatShortcut(keys[0]!, "mac");
    // "Option+R (Ctrl+Alt+R elsewhere) ... opens a review"
    expect(shown(mac["review.toggle"])).toBe("Option+R");
    expect(formatShortcut(linux["review.toggle"][0]!, "linux")).toBe(
      "Ctrl+Alt+R",
    );
    expect(formatShortcut(windows["review.toggle"][0]!, "windows")).toBe(
      "Ctrl+Alt+R",
    );
    expect(review).toContain("Option+R (Ctrl+Alt+R elsewhere)");
    // "Option+Shift+R lists the reviews in progress"; the section names no
    // key for elsewhere (Ctrl+Alt+Shift+R).
    expect(shown(mac["reviews.list"])).toBe("Option+Shift+R");
    expect(formatShortcut(linux["reviews.list"][0]!, "linux")).toBe(
      "Ctrl+Alt+Shift+R",
    );
    expect(review).toContain("Option+Shift+R lists the reviews");
    expect(review).not.toContain("Ctrl+Alt+Shift+R");
    // Mark the file reviewed: Option+V on a Mac, Alt+V elsewhere.
    expect(formatShortcut("Alt+V", "mac")).toBe("Option+V");
    expect(formatShortcut("Alt+V", "linux")).toBe("Alt+V");
    expect(review).toContain(
      "`Option+V` (`Alt+V` on Windows/Linux, or `v`) marks the whole file",
    );
    // The Keyboard Shortcuts table: the review's, the reviews list's and
    // the reviews inbox's rows are the bindings.
    const table = section("Keyboard Shortcuts");
    const row = (action: string) =>
      table
        .split("\n")
        .find((line) => line.startsWith(`| ${action} `))
        ?.split("|")
        .slice(2, 4)
        .map((cell) => cell.trim());
    expect(row("Reviews inbox")).toEqual([
      `\`${shown(mac["reviews.inbox"])}\``,
      `\`${formatShortcut(linux["reviews.inbox"][0]!, "linux")}\``,
    ]);
    expect(row("Review of this branch (open / close)")).toEqual([
      `\`${shown(mac["review.toggle"])}\``,
      `\`${formatShortcut(linux["review.toggle"][0]!, "linux")}\``,
    ]);
    expect(row("Reviews in progress")).toEqual([
      `\`${shown(mac["reviews.list"])}\``,
      `\`${formatShortcut(linux["reviews.list"][0]!, "linux")}\``,
    ]);
  });

  for (const { name, mount } of reviewSurfacesWith("commands"))
    describe(name, () => {
      test("the keys FEATURES.md's Review section documents are the review's shortcut list's", async () => {
        const surface = await mount({
          files: [file("a.ts", hunk(1, 1, ["+one"]))],
        });
        await surface.press("?");
        const rows = surface.shortcutKeys();
        expect(rows.length).toBeGreaterThan(40);
        const listed = new Set(rows.flat());
        const inDocs = documented(review);
        for (const key of REVIEW_SECTION_KEYS) {
          expect({ key, documented: inDocs.has(key) }).toEqual({
            key,
            documented: true,
          });
          expect({ key, listed: listed.has(key) }).toEqual({
            key,
            listed: true,
          });
        }
        // The file key: the platform's Alt+V beside v.
        expect(
          rows.some(
            (keys) =>
              keys.includes("v") &&
              (keys.includes("Alt+V") || keys.includes("Option+V")),
          ),
        ).toBe(true);
        await surface.unmount();
      });
    });
}
