import { expect, test } from "bun:test";
import {
  browserCallNote,
  speechEngineSummary,
} from "./components/SpeechSettings";
import { browserCallBlock, decideSpeechEngine } from "./speechEngine";

test("the server's engine reads when it has one, the browser's otherwise", () => {
  expect(decideSpeechEngine(true, true, "server")).toBe("server");
  expect(decideSpeechEngine(true, false, "server")).toBe("server");
  // Not known yet, or missing: the browser reads.
  expect(decideSpeechEngine(null, true, "server")).toBe("browser");
  expect(decideSpeechEngine(false, true, "server")).toBe("browser");
  expect(decideSpeechEngine(false, false, "server")).toBeNull();
});

test("a browser set to its own voices reads with them, when it has some", () => {
  expect(decideSpeechEngine(true, true, "browser")).toBe("browser");
  expect(decideSpeechEngine(true, false, "browser")).toBe("server");
});

test("Speech settings say which engine reads and whether voice chat listens", () => {
  expect(speechEngineSummary({ engine: "server", server: true })).toBe(
    "Replies are read by Roamgate's voice engine on the server. Voice chat listens through the server's voice engine.",
  );
  expect(speechEngineSummary({ engine: "browser", server: false })).toBe(
    "Replies are read by this browser's speech synthesis. The server has no voice engine, so voice chat cannot listen.",
  );
  expect(speechEngineSummary({ engine: null, server: null })).toBe(
    "Nothing here can read replies aloud.",
  );
});

test("the browser's voice is known not to be heard in Android calls", () => {
  expect(
    browserCallBlock(
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
    ),
  ).toBe("android");
  expect(browserCallNote("android")).toBe(
    "This browser's voice can't play during voice calls on Android: the microphone opens as a phone call, and the browser's speech is cut off or not heard beside it. Calls read with Roamgate's voice engine.",
  );
});
