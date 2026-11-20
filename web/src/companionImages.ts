import { bridge, type ConnectionSummary } from "./api";
import { messageImagePieces } from "./chatImages";
import { downscaleImage } from "./imageDownscale";
import { store } from "./store";
import { uploadTerminalImage } from "./terminalImageUpload";
import { parseVoiceSessionId } from "./voiceRoute";

/**
 * Images given to the companion: uploaded to this host, where its model
 * runs (the chat composers' /upload-image), and named in the words by
 * their path, which the server reads to show the model.
 */

/** A connection of this host: the companion's own. */
function local(connections: readonly ConnectionSummary[]) {
  const here = connections.filter(
    (connection) => connection.type !== "ssh" && !connection.ssh_destination,
  );
  return here.find((connection) => connection.state === "ready") ?? here[0];
}

/** The images uploaded lately, by their path: sent on to another host. */
const uploaded = new Map<string, File>();
const KEPT = 32;

/**
 * An image put in the companion's message box, made the size a model
 * takes (a phone's photo is far larger) and uploaded to this host; its
 * path, as the box writes it.
 */
export async function uploadCompanionImage(file: File): Promise<string> {
  const connection = local(store.get().connections);
  if (!connection) throw new Error("No connection to this machine");
  const image = await downscaleImage(file);
  const path = await uploadTerminalImage(
    bridge.connection(connection.id, connection.generation),
    image,
  );
  uploaded.set(path, image);
  while (uploaded.size > KEPT) uploaded.delete(uploaded.keys().next().value!);
  return path;
}

/** Where an image of this host shows, by its absolute path. */
export function companionImageUrl(path: string): string {
  return `/api/voice/image?path=${encodeURIComponent(path)}`;
}

// An absolute path to an image file, as a word of its own (or quoted).
const IMAGE_PATH =
  /(?<![^\s"'`(<[])\/(?:[^\s/"'`<>()[\]]+\/)*[^\s/"'`<>()[\]]+\.(?:png|jpe?g|gif|webp)(?=[.,;:!?]*(?:[\s)\]>"'`]|$))/gi;

/**
 * The images a line of the conversation names: those the user gave, and
 * any image file the companion refers to or made, by its absolute path.
 */
export function companionImages(text: string): string[] {
  return [...new Set(text.match(IMAGE_PATH) ?? [])];
}

/** The images the user gave with some words (uploaded ones). */
function givenImages(text: string): string[] {
  return messageImagePieces(text).flatMap((piece) =>
    "image" in piece ? [piece.image] : [],
  );
}

/**
 * The words the companion sends a session, with the images given with
 * what the user wrote: the front may have left their paths out. On
 * another host, the session gets them uploaded there, as its own chat
 * box would (a path of this host means nothing there).
 */
export async function wordsWithImages(
  words: string,
  said: string,
  pane: string,
): Promise<string> {
  const images = givenImages(said);
  if (!images.length) return words;
  const missing = images.filter((path) => !words.includes(path));
  let text = missing.length ? `${words}\n\n${missing.join("\n")}` : words;
  const target = parseVoiceSessionId(pane);
  const state = store.get();
  const here = local(state.connections);
  const there = state.connections.find(
    (connection) => connection.id === target?.connectionId,
  );
  if (!there || !here || there.id === here.id) return text;
  if (there.type !== "ssh" && !there.ssh_destination) return text;
  for (const path of images) {
    const file = uploaded.get(path);
    if (!file) continue;
    try {
      const moved = await uploadTerminalImage(
        bridge.connection(there.id, there.generation),
        file,
      );
      text = text.split(path).join(moved);
    } catch {
      // Kept as this host's path: the session says it cannot read it.
    }
  }
  return text;
}
