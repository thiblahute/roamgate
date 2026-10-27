import { expect, test } from "bun:test";
import { handOffVoice, takeVoiceHandoff } from "./voiceRoute";

test("a pane shown again goes on awaiting the answer it awaited", () => {
  handOffVoice({
    connectionId: "local",
    paneId: "w2:p2",
    message: null,
    resume: { sent: "[Voice] No, the other one.", read: ["a1"] },
  });
  // Another pane does not take it.
  expect(takeVoiceHandoff("local", "w2:p3")).toBeNull();
  expect(takeVoiceHandoff("local", "w2:p2")).toEqual({
    message: null,
    resume: { sent: "[Voice] No, the other one.", read: ["a1"] },
  });
  // Taken once.
  expect(takeVoiceHandoff("local", "w2:p2")).toBeNull();
});
