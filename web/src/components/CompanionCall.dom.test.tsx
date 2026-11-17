import { inIsolatedChild } from "../testIsolated";
import { expect, mock, test } from "bun:test";

if (
  inIsolatedChild(
    import.meta.path,
    "the companion call in an isolated browser runtime",
    "ROAMGATE_COMPANION_CALL_DOM_TEST",
    30_000,
  )
) {
  test("switching workspace mid-sentence: the sentence ends, the call stays", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      NodeFilter: browser.NodeFilter,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      MutationObserver: browser.MutationObserver,
      Event: browser.Event,
      getComputedStyle: browser.getComputedStyle.bind(browser),
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    const React = await import("react");
    const { act } = React;
    const { createRoot } = await import("react-dom/client");
    const { createFrontVoice } = await import("../voiceFront");
    const { claimSpeaker } = await import("../voiceChat");

    // The companion says a sentence that takes a while to play; what a
    // workspace switch does must not cut it.
    let played: "playing" | "ended" | "cut" = "playing";
    let finish: () => void = () => {};
    const voice = createFrontVoice(
      {
        fetchAudio: async () => "audio",
        playAudio: (_audio: string, stop: AbortSignal) =>
          new Promise<void>((resolve) => {
            stop.addEventListener("abort", () => {
              if (played === "playing") played = "cut";
              resolve();
            });
            finish = () => {
              if (played === "playing") played = "ended";
              resolve();
            };
          }),
      },
      claimSpeaker,
    );
    let hookUnmounted = false;
    const callSignal = new AbortController();
    // The call's voice chat (its listening and its reading), as the
    // companion call runs it: started once, stopped only by its own end.
    mock.module("./useVoiceChat", () => ({
      useVoiceChat: () => {
        React.useEffect(() => {
          void voice.say(
            "La session roamgate a fini : les tests passent.",
            callSignal.signal,
          );
          return () => {
            hookUnmounted = true;
            callSignal.abort();
          };
        }, []);
        return {
          available: true,
          state: "speaking",
          level: 0,
          muted: false,
          heard: "",
          speechRate: 1,
          reader: null,
          moveQuestion: null,
          notSent: null,
          toggle: () => {},
          toggleMute: () => {},
          stop: () => {},
          cycleSpeechRate: () => {},
          answerMove: () => {},
          sendNotSent: () => {},
        };
      },
    }));
    const { showCompanionCall } = await import("./CompanionCallRoot");

    // The app's workspace view, in its own root: a pane chat that does on
    // unmount what pane chats do (its own reading stopped).
    const { stopReading } = await import("../voiceChat");
    const PaneChat = ({ id }: { id: string }) => {
      React.useEffect(() => () => stopReading(id), [id]);
      return <div className="pane-chat">{id}</div>;
    };
    const { CompanionChip, CompanionStrip, companionChipText } = await import(
      "./CompanionChip"
    );
    // The app: its top bar with the companion's chip, the line under it,
    // then the workspace shown.
    const App = ({ children }: { children: React.ReactNode }) => (
      <div className="app">
        <header className="topbar">
          <CompanionChip />
        </header>
        <CompanionStrip />
        <main>{children}</main>
      </div>
    );
    const app = document.createElement("div");
    document.body.append(app);
    const appRoot = createRoot(app);
    await act(async () => {
      appRoot.render(
        <App>
          <PaneChat key="w2:p2" id="w2:p2" />
        </App>,
      );
    });
    await act(async () => {
      showCompanionCall("local/w2:p2");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    // The call is in the top bar, its controls in the chip: no card floats
    // over the app's content.
    const card = () =>
      document.querySelector(".topbar .companion-chip.is-call");
    expect(card()).not.toBeNull();
    expect(card()!.getAttribute("aria-label")).toBe("Call with Companion");
    expect(card()!.querySelector('[aria-label="Hang up"]')).not.toBeNull();
    expect(document.querySelector(".voice-chat-overlay")).toBeNull();

    // What it says shows in one line of the page's own flow, under the top
    // bar, with its name, not in a note over a chat.
    const companion = await import("../companionCall");
    await act(async () => {
      companion.setCompanionLine("Je lance ça sur la session roamgate.");
    });
    const strip = document.querySelector(".app > .companion-strip");
    expect(strip?.textContent).toBe(
      "CompanionJe lance ça sur la session roamgate.",
    );
    expect(strip?.previousElementSibling?.className).toBe("topbar");
    expect(document.querySelector(".agent-history-composer-router")).toBeNull();

    // Mid-sentence, the user goes to another workspace: the pane chat goes,
    // another comes.
    await act(async () => {
      appRoot.render(
        <App>
          <PaneChat key="w5:p1" id="w5:p1" />
        </App>,
      );
    });
    await act(async () => {
      appRoot.render(
        <App>
          <div className="review">review</div>
        </App>,
      );
    });
    expect(played).toBe("playing");
    expect(hookUnmounted).toBe(false);
    expect(card()).not.toBeNull();

    // The line plays to its end, both its sentences.
    for (let part = 0; part < 2; part++)
      await act(async () => {
        finish();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    expect(played as string).toBe("ended");
    expect(voice.playing()).toBe(false);
    expect(card()).not.toBeNull();
    expect(hookUnmounted).toBe(false);

    // Its chip and its conversation: what it heard and said, and the work
    // it started on which session.
    const { CompanionPanel } = await import("./CompanionPanel");
    const { setVoiceFronting } = await import("../voiceFrontFlag");
    setVoiceFronting(true);
    expect(companionChipText("listening", 0)).toBe("listening");
    expect(companionChipText("waiting", 2)).toBe("on a call · 2 jobs running");
    await act(async () => {
      companion.setCompanionPresence("speaking");
      companion.logCompanion({
        kind: "heard",
        text: "Demande à gst2 de rebaser.",
      });
      companion.logCompanion({ kind: "said", text: "Je demande à gst2." });
      const job = companion.logCompanion({
        kind: "job",
        session: "local/w5:p1",
        label: "gst2",
        words: "rebase.",
        said: "Demande à gst2 de rebaser.",
        status: "running",
      });
      companion.updateCompanionJob(job, {
        status: "answered",
        answer: "Rebased on main, no conflicts.",
      });
      appRoot.render(
        <>
          <CompanionChip />
          <CompanionPanel onClose={() => {}} />
        </>,
      );
    });
    const chip = document.querySelector(".companion-chip-main");
    expect(chip?.querySelector(".companion-chip-name")?.textContent).toBe(
      "Companion",
    );
    expect(chip?.querySelector(".companion-chip-state")?.textContent).toBe(
      "speaking",
    );
    expect(chip?.querySelector(".companion-chip-timer")?.textContent).toBe(
      "00:00",
    );
    const panel = document.querySelector(".companion-panel")!;
    expect(panel.querySelector("h2")?.textContent).toBe("Companion");
    expect(
      [...panel.querySelectorAll(".companion-panel-line p")].map(
        (line) => line.textContent,
      ),
    ).toEqual(["Demande à gst2 de rebaser.", "Je demande à gst2."]);
    expect(panel.querySelector(".companion-panel-session")?.textContent).toBe(
      "gst2",
    );
    expect(panel.querySelector(".companion-panel-status")?.textContent).toBe(
      "Answered",
    );
    // Both: what it gave the session, and what was said.
    expect(panel.querySelector(".companion-panel-words")?.textContent).toBe(
      "rebase.",
    );
    expect(panel.querySelector(".companion-panel-said")?.textContent).toBe(
      "You said: Demande à gst2 de rebaser.",
    );
    expect(panel.querySelector(".companion-panel-answer")?.textContent).toBe(
      "Rebased on main, no conflicts.",
    );
    appRoot.unmount();
  });
}
