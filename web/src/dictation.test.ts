import { describe, expect, test } from "bun:test";
import { insertDictation } from "./dictation";

describe("insertDictation", () => {
  test("an empty box takes the text as it is", () => {
    expect(insertDictation("", 0, 0, "Hello.")).toEqual({
      value: "Hello.",
      caret: 6,
    });
  });

  test("after a word, a space first; before one, a space after", () => {
    expect(insertDictation("Salut ça va", 5, 5, "Gwenaëlle,")).toEqual({
      value: "Salut Gwenaëlle, ça va",
      caret: 16,
    });
  });

  test("no space after a space, a line start or an opening bracket", () => {
    expect(insertDictation("Note: ", 6, 6, "done").value).toBe("Note: done");
    expect(insertDictation("one\n", 4, 4, "two").value).toBe("one\ntwo");
    expect(insertDictation("(", 1, 1, "aside").value).toBe("(aside");
  });

  test("a selection is replaced", () => {
    expect(insertDictation("say foo now", 4, 7, "bar")).toEqual({
      value: "say bar now",
      caret: 7,
    });
  });

  test("nothing said changes nothing", () => {
    expect(insertDictation("keep", 2, 2, "")).toEqual({
      value: "keep",
      caret: 2,
    });
  });
});
