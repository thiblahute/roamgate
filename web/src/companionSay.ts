import { logCompanion, setCompanionLine } from "./companionCall";
import {
  beginCompanionReading,
  companionReadingAt,
  endCompanionReading,
} from "./companionReading";
import { highlightReading } from "./readingHighlight";
import type { FrontVoice } from "./voiceFront";

/**
 * The front's voice on a call with the companion: what it says shows in
 * the call's strip and is logged in its conversation view, not in a bar
 * over a chat. As each sentence plays, the strip shows it
 * (companionReading.ts); an agent's answer read word for word is also
 * highlighted in its chat when that chat is on screen, as a reading in a
 * pane's voice chat is.
 */
export function companionFrontVoice(voice: FrontVoice): FrontVoice {
  return {
    ...voice,
    say(text, stop, options) {
      const logId = logCompanion({ kind: "said", text });
      const answer = options?.answer;
      let shown: number | null = null;
      return voice.say(text, stop, {
        ...options,
        onSentence: (index, sentences) => {
          if (index !== null && shown === null) {
            setCompanionLine(text);
            shown = beginCompanionReading(sentences, {
              logId,
              ...(answer ? { answer } : {}),
            });
          }
          if (shown === null) return;
          if (index === null) endCompanionReading(shown);
          else companionReadingAt(shown, index);
          if (answer)
            highlightReading(
              answer.ids,
              index === null ? null : sentences[index]!,
              { anywhere: true },
            );
          options?.onSentence?.(index, sentences);
        },
      });
    },
  };
}
