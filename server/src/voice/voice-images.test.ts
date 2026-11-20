import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveVoiceImage, uploadedImages } from "./voice-images";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("only the upload folder's images, read for the model", async () => {
  const home = mkdtempSync(join(tmpdir(), "voice-images-"));
  try {
    const root = join(home, "roamgate-uploads-1");
    mkdirSync(join(root, "upload-a"), { recursive: true });
    const shot = join(root, "upload-a", "img-1.png");
    writeFileSync(shot, PNG);
    // Named .png, but not one.
    const fake = join(root, "upload-a", "img-2.png");
    writeFileSync(fake, "hello");
    const outside = join(home, "secret.png");
    writeFileSync(outside, PNG);
    // A link out of the folder.
    symlinkSync(outside, join(root, "upload-a", "img-3.png"));
    const said = `look ${shot} and ${fake}, ${join(root, "upload-a", "img-3.png")} and ${outside}`;
    expect(await uploadedImages(said, root)).toEqual([
      {
        media_type: "image/png",
        data: Buffer.from(PNG).toString("base64"),
      },
    ]);
    expect(await uploadedImages("no image here", root)).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the conversation's images are served by their path, only images", async () => {
  const home = mkdtempSync(join(tmpdir(), "voice-image-serve-"));
  try {
    const shot = join(home, "shot.png");
    writeFileSync(shot, PNG);
    const note = join(home, "note.png");
    writeFileSync(note, "text");
    const at = (path: string) =>
      serveVoiceImage(
        new URL(`http://x/api/voice/image?path=${encodeURIComponent(path)}`),
      );
    const served = await at(shot);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
    expect((await at(note)).status).toBe(404);
    expect((await at("relative.png")).status).toBe(404);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
