import { expect, test } from "bun:test";

/** The declarations of `selector`'s rule in the Files preview's sheet. */
async function rule(selector: string): Promise<Record<string, string>> {
  const css = (
    await Bun.file(new URL("./FilePreviewContent.css", import.meta.url)).text()
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const found = css
    .split("}")
    .map((part) => part.split("{"))
    .find(([selectors]) =>
      selectors!
        .split(",")
        .map((each) => each.trim().replace(/\s+/g, " "))
        .includes(selector),
    );
  if (!found) throw new Error(`no rule for ${selector}`);
  return Object.fromEntries(
    found[1]!
      .split(";")
      .map((each) => each.split(":").map((part) => part.trim()))
      .filter(([name]) => name)
      .map(([name, ...value]) => [name!, value.join(":")]),
  );
}

test("the comments on no line take part of the column and scroll, never the rendered page's room", async () => {
  // The column clips (overflow hidden) and the page's frame is the one that
  // shrinks (min-height 0): a list that neither shrinks nor scrolls took the
  // whole column on a phone, the page gone and nothing to scroll.
  const column = await rule(".file-preview-file-content");
  expect(column.overflow).toBe("hidden");
  expect((await rule(".file-preview-html"))["min-height"]).toBe("0");
  const list = await rule(
    ".file-preview-file-content > .file-preview-detached",
  );
  expect(list["min-height"]).toBe("0");
  expect(list.overflow).toBe("auto");
  expect(list["max-height"]).toBe("40%");
});
