import { describe, expect, test } from "bun:test";
import { messageImagePieces } from "./chatImages";

const PNG =
  "/var/folders/9w/T/roamgate-uploads-501/upload-PkYw2p/img-1793284936305-iiuqcn.png";

describe("messageImagePieces", () => {
  test("separates an uploaded image from the words around it", () => {
    expect(
      messageImagePieces(`${PNG}  I can't access the 2 comments on top`),
    ).toEqual([
      { image: PNG },
      { text: "I can't access the 2 comments on top" },
    ]);
    expect(messageImagePieces(`Look: ${PNG}\nand ${PNG}`)).toEqual([
      { text: "Look:" },
      { image: PNG },
      { text: "and" },
      { image: PNG },
    ]);
  });

  test("takes a remote macOS upload, whose TMPDIR ends with a slash", () => {
    const path =
      "/var/folders/9w/s7tm2hnn7y7d_jv5q_pn8mkc0000gn/T//roamgate-uploads-501/upload-yKyMNdvu/img-1794332697314-v59v6g.png";
    expect(messageImagePieces(`${path} what is this?`)).toEqual([
      { image: path },
      { text: "what is this?" },
    ]);
    expect(messageImagePieces(`foo${path}`)).toEqual([{ text: `foo${path}` }]);
  });

  test("takes Windows paths", () => {
    const path =
      "C:\\Users\\me\\AppData\\Local\\Temp\\roamgate-uploads-me\\upload-x\\a.JPG";
    expect(messageImagePieces(path)).toEqual([{ image: path }]);
  });

  test("leaves other paths and files as text", () => {
    for (const text of [
      "/tmp/shot.png is broken",
      "/tmp/roamgate-uploads-501/upload-x/notes.pdf",
      `${PNG}.bak`,
    ])
      expect(messageImagePieces(text)).toEqual([{ text }]);
  });

  test("takes a path between quotes, brackets or before punctuation", () => {
    for (const [before, after] of [
      ["see ", ", then"],
      ["(", ")"],
      ["`", "`"],
      ['"', '".'],
      ["", "."],
    ])
      expect(messageImagePieces(`${before}${PNG}${after}`)).toContainEqual({
        image: PNG,
      });
  });

  test("takes only whole paths", () => {
    for (const text of [
      "C:\\Users\\John Smith\\AppData\\Local\\Temp\\roamgate-uploads-me\\upload-x\\a.png",
      `foo${PNG}`,
    ])
      expect(messageImagePieces(text)).toEqual([{ text }]);
  });
});
