import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVoiceConfig } from "./voice-helper";
import {
  helperFailure,
  NEEDS_HELPER,
  NO_CALL,
  NO_OPUS,
  parseYtDlp,
  resolveYoutube,
  SPOTIFY_MPRIS,
  YoutubeError,
  type YoutubeHelper,
  YoutubePlayer,
  type YoutubeTrack,
  youtubeConfig,
  youtubeTarget,
  ytDlpArgs,
  ytDlpFailure,
} from "./voice-youtube";

const TRACK: YoutubeTrack = {
  title: "Around the World",
  url: "https://www.youtube.com/watch?v=K0HSD_i2DvA",
  channel: "Daft Punk",
  duration: 242,
  stream: "https://rr3.googlevideo.com/videoplayback?x=1",
  headers: { "User-Agent": "UA", Accept: "*/*" },
};

describe("finding a video", () => {
  test("words search, a YouTube link plays as is, another site is refused", () => {
    expect(youtubeTarget(" daft punk ")).toBe("ytsearch1:daft punk");
    expect(youtubeTarget("https://youtu.be/K0HSD_i2DvA")).toBe(
      "https://youtu.be/K0HSD_i2DvA",
    );
    expect(youtubeTarget("https://music.youtube.com/watch?v=x")).toBe(
      "https://music.youtube.com/watch?v=x",
    );
    expect(() => youtubeTarget("https://evil.example/watch?v=x")).toThrow(
      "evil.example is not YouTube",
    );
    expect(() => youtubeTarget("  ")).toThrow(YoutubeError);
  });

  test("yt-dlp gets the target after --, never as an option", () => {
    const args = ytDlpArgs(["yt-dlp"], "ytsearch1:--exec rm");
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("ytsearch1:--exec rm");
    expect(args).toContain("--no-playlist");
    // Only WebM with Opus: the helper has no AAC decoder.
    expect(args[args.indexOf("--format") + 1]).toBe(
      "bestaudio[acodec=opus]/bestaudio[ext=webm]",
    );
  });

  test("its JSON gives the title, page, length, stream and headers", () => {
    const line = JSON.stringify({
      title: TRACK.title,
      webpage_url: TRACK.url,
      channel: TRACK.channel,
      duration: 241.6,
      url: TRACK.stream,
      ext: "webm",
      acodec: "opus",
      http_headers: TRACK.headers,
    });
    expect(parseYtDlp(`[info] noise\n${line}\n`)).toEqual(TRACK);
    expect(() => parseYtDlp("")).toThrow("nothing was found on YouTube");
    expect(() => parseYtDlp('{"title":"x"}')).toThrow("no audio stream");
  });

  test("a video with only AAC audio says the helper cannot play it", () => {
    const m4a = JSON.stringify({
      title: "x",
      url: TRACK.stream,
      ext: "m4a",
      acodec: "mp4a.40.2",
    });
    expect(() => parseYtDlp(m4a)).toThrow(NO_OPUS);
    expect(
      ytDlpFailure(
        "ERROR: [youtube] x: Requested format is not available. Use --list-formats for a list of available formats",
        1,
      ),
    ).toBe(NO_OPUS);
  });

  test("a failure says why, and an outdated yt-dlp says to update it", () => {
    expect(
      ytDlpFailure(
        "WARNING: x\nERROR: [youtube] K0HSD_i2DvA: Video unavailable\n",
        1,
      ),
    ).toBe("Video unavailable");
    expect(
      ytDlpFailure(
        "ERROR: unable to download video data: HTTP Error 403: Forbidden",
        1,
      ),
    ).toContain("yt-dlp -U");
    expect(ytDlpFailure("", 2)).toBe("yt-dlp ended with 2");
  });

  test("resolving runs the configured yt-dlp and tells its failure", async () => {
    const ran: string[][] = [];
    await expect(
      resolveYoutube("miles davis", ["host-spawn", "yt-dlp"], async (args) => {
        ran.push(args);
        return {
          code: 1,
          stdout: "",
          stderr: "ERROR: [youtube] x: Sign in to confirm you're not a bot",
        };
      }),
    ).rejects.toThrow(/Sign in to confirm.*yt-dlp -U/);
    expect(ran[0]!.slice(0, 2)).toEqual(["host-spawn", "yt-dlp"]);
    expect(ran[0]!.at(-1)).toBe("ytsearch1:miles davis");
    await expect(
      resolveYoutube("x", ["missing-yt-dlp"], async () => {
        throw new Error("ENOENT");
      }),
    ).rejects.toThrow("missing-yt-dlp could not be run (ENOENT)");
  });
});

/** A voice helper the test answers, as the helper's call_youtube would. */
function fakeHelper(
  answer?: (command: Record<string, unknown>) => Record<string, unknown>,
) {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  const helper = {
    call: true,
    sent: [] as Record<string, unknown>[],
    /** The requests that put the call's music on first. */
    musicOn: [] as string[],
    inCall: () => helper.call,
    async callYoutube(command: Record<string, unknown>, musicOn = false) {
      if (!helper.call) throw new Error("no call");
      helper.sent.push(command);
      if (musicOn) helper.musicOn.push(String(command.action));
      if (answer) return answer(command);
      return {
        state:
          command.action === "pause"
            ? "paused"
            : command.action === "stop"
              ? "stopped"
              : "playing",
        position: 12,
        duration: 242,
        volume: typeof command.volume === "number" ? command.volume : 1,
        music_muted: false,
        ...(command.action === "play" || command.action === "resume"
          ? { spotify_paused: false }
          : {}),
      };
    },
    onYoutube(listener: (event: Record<string, unknown>) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** The helper tells a call_youtube event. */
    tell(event: Record<string, unknown>) {
      for (const listener of listeners)
        listener({ event: "call_youtube", call: 1, ...event });
    },
  };
  return helper;
}

function player(answer?: Parameters<typeof fakeHelper>[0]) {
  const helper = fakeHelper(answer);
  const asked: string[] = [];
  const using = new YoutubePlayer(
    helper satisfies YoutubeHelper,
    async (what) => {
      asked.push(what);
      return TRACK;
    },
    1000,
  );
  return { using, helper, asked };
}

describe("the YouTube player drives the helper's call", () => {
  test("play gives the helper the stream and headers, the music put on", async () => {
    const { using, helper, asked } = player();
    const status = await using.play("around the world");
    expect(asked).toEqual(["around the world"]);
    expect(helper.sent).toEqual([
      { action: "status" },
      {
        action: "play",
        url: TRACK.stream,
        headers: TRACK.headers,
        volume: 1,
        pause_mpris: SPOTIFY_MPRIS,
      },
    ]);
    expect(helper.musicOn).toEqual(["play"]);
    expect(status).toEqual({
      state: "playing",
      position: 12,
      duration: 242,
      volume: 100,
      track: { title: TRACK.title, url: TRACK.url, channel: TRACK.channel },
    });
  });

  test("pause, resume, volume, seek and status go to the call", async () => {
    const { using, helper } = player();
    await using.play("x");
    expect((await using.pause()).state).toBe("paused");
    expect((await using.resume()).state).toBe("playing");
    expect((await using.volume(40)).volume).toBe(40);
    await using.seek({ by: 30 });
    await using.seek({ position: 5 });
    expect((await using.nowPlaying()).track?.title).toBe(TRACK.title);
    expect(helper.sent.map((each) => each.action)).toEqual([
      "status",
      "play",
      "pause",
      "resume",
      "volume",
      "status",
      "seek",
      "seek",
      "status",
    ]);
    expect(helper.sent[3]).toEqual({
      action: "resume",
      pause_mpris: SPOTIFY_MPRIS,
    });
    expect(helper.musicOn).toEqual(["play", "resume"]);
    expect(helper.sent[4]!.volume).toBe(0.4);
    // 12 s in, 30 s ahead.
    expect(helper.sent[6]!.position).toBe(42);
    expect(helper.sent[7]!.position).toBe(5);
    // The next video keeps the volume.
    await using.play("y");
    expect(helper.sent.at(-1)!.volume).toBe(0.4);
  });

  test("an older helper, or no call, is told before yt-dlp runs", async () => {
    const { using, asked, helper } = player(() => {
      throw new Error("unknown op call_youtube");
    });
    await expect(using.play("x")).rejects.toThrow(NEEDS_HELPER);
    expect(asked).toEqual([]);
    helper.call = false;
    await expect(using.play("x")).rejects.toThrow(NO_CALL);
    expect(asked).toEqual([]);
    expect(helperFailure("no call 3")).toBe(NO_CALL);
    expect(helperFailure("Resource 'the stream' not found")).toBe(
      "Resource 'the stream' not found",
    );
  });

  test("without a call nothing plays, and what played ended with it", async () => {
    const { using, helper } = player();
    helper.call = false;
    expect(await using.nowPlaying()).toEqual({ state: "stopped", volume: 100 });
    expect((await using.stop()).state).toBe("stopped");
    await expect(using.pause()).rejects.toThrow(NO_CALL);
    helper.call = true;
    await using.play("x");
    helper.call = false;
    expect(await using.nowPlaying()).toEqual({
      state: "stopped",
      volume: 100,
      ended: "the call ended",
    });
  });

  test("a failed start is told with the helper's reason", async () => {
    const { using } = player((command) => {
      if (command.action === "play")
        throw new Error("Request for 'the stream' failed: 403 Forbidden");
      return { state: "stopped" };
    });
    const failed = await using.play("x").catch((error) => error);
    expect(failed).toBeInstanceOf(YoutubeError);
    expect(failed.message).toBe(
      "Request for 'the stream' failed: 403 Forbidden",
    );
  });

  test("Spotify paused for it, its end and Spotify's start are told", async () => {
    const { using, helper } = player((command) => ({
      state: command.action === "status" ? "stopped" : "playing",
      spotify_paused: command.action === "play",
    }));
    expect((await using.play("x")).spotifyPaused).toBe(true);
    helper.tell({ state: "playing", position: 0, duration: 242 });
    helper.tell({ state: "stopped", why: "ended", reason: "the video ended" });
    expect(await using.nowPlaying()).toEqual({
      state: "stopped",
      volume: 100,
      ended: "the video ended",
    });
    await using.play("x");
    helper.tell({
      state: "stopped",
      why: "spotify",
      reason: "Spotify started playing",
    });
    expect((await using.nowPlaying()).ended).toBe("Spotify started playing");
    await using.play("x");
    helper.tell({ state: "stopped", why: "error", reason: "it failed: x" });
    expect((await using.nowPlaying()).ended).toBe("it failed: x");
    // Lost without a word (the helper restarted): said so.
    await using.play("x");
    expect((await using.nowPlaying()).ended).toBe("the call's audio restarted");
  });

  test("Spotify starting on the call's device stops YouTube", async () => {
    const { using, helper } = player((command) => ({
      state: command.action === "stop" ? "stopped" : "playing",
    }));
    await using.play("x");
    await using.spotifyStarted();
    expect(helper.sent.at(-1)!.action).toBe("stop");
    // Nothing to stop: nothing is asked for it.
    const sent = helper.sent.length;
    await using.spotifyStarted();
    expect(helper.sent).toHaveLength(sent);
  });

  test("a helper that does not answer fails the command", async () => {
    const helper = fakeHelper();
    helper.callYoutube = () => new Promise(() => {});
    const using = new YoutubePlayer(helper, async () => TRACK, 20);
    await expect(using.pause()).rejects.toThrow(
      "the voice helper did not answer",
    );
  });
});

describe("voice.json's YouTube", () => {
  test("on with call_background, unless youtube is false", () => {
    expect(youtubeConfig({ helper: "h" })).toBeNull();
    expect(
      youtubeConfig({ helper: "h", call_background: "x", youtube: false }),
    ).toBeNull();
    expect(youtubeConfig({ helper: "h", call_background: "x" })).toEqual({
      ytDlp: ["yt-dlp"],
    });
    expect(
      youtubeConfig({
        helper: "h",
        call_background: "x",
        yt_dlp: ["/opt/yt-dlp"],
      }),
    ).toEqual({ ytDlp: ["/opt/yt-dlp"] });
  });

  test("its keys are checked; the old player's are ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-youtube-"));
    try {
      const read = (extra: Record<string, unknown>) => {
        const path = join(dir, "voice.json");
        writeFileSync(
          path,
          JSON.stringify({
            helper: "/bin/sh",
            whisper_model: "/bin/sh",
            tts_models: [{ model: "kokoro" }],
            ...extra,
          }),
        );
        return readVoiceConfig(path);
      };
      expect(read({ youtube: "yes" })).toEqual({
        error: expect.stringContaining("youtube must be"),
      });
      expect(read({ yt_dlp: [] })).toEqual({
        error: expect.stringContaining("yt_dlp must be"),
      });
      const old = read({
        call_background: "x",
        youtube_sink: 3,
        youtube_player_wrapper: "systemd-run",
        yt_dlp: ["yt-dlp"],
      });
      expect(old).not.toHaveProperty("error");
      expect(youtubeConfig(old as Parameters<typeof youtubeConfig>[0])).toEqual(
        { ytDlp: ["yt-dlp"] },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
