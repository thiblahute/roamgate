import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVoiceConfig } from "./voice-helper";
import {
  PLAYER_SCRIPT,
  type PlayerProcess,
  parseYtDlp,
  playerCommand,
  resolveYoutube,
  SPOTIFY_MPRIS,
  YoutubeError,
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
  });

  test("its JSON gives the title, page, length, stream and headers", () => {
    const line = JSON.stringify({
      title: TRACK.title,
      webpage_url: TRACK.url,
      channel: TRACK.channel,
      duration: 241.6,
      url: TRACK.stream,
      http_headers: TRACK.headers,
    });
    expect(parseYtDlp(`[info] noise\n${line}\n`)).toEqual(TRACK);
    expect(() => parseYtDlp("")).toThrow("nothing was found on YouTube");
    expect(() => parseYtDlp('{"title":"x"}')).toThrow("no audio stream");
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

/** A player process the test answers, as PLAYER_SCRIPT would. */
function fakePlayer(
  answer?: (
    process: ReturnType<typeof fakePlayer>,
    command: Record<string, unknown>,
  ) => void,
) {
  const queued: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const process = {
    written: [] as Record<string, unknown>[],
    closed: false,
    lines: (async function* () {
      for (;;) {
        while (queued.length) yield queued.shift()!;
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    })(),
    write(line: string) {
      const command = JSON.parse(line);
      process.written.push(command);
      process.reply?.(command);
    },
    close() {
      process.closed = true;
      ended = true;
      wake?.();
    },
    exited: Promise.resolve(0),
    push(line: unknown) {
      queued.push(JSON.stringify(line));
      wake?.();
    },
    /** Answers each command; replaced to answer otherwise. */
    reply: null as ((command: Record<string, unknown>) => void) | null,
  };
  process.reply = (command) => {
    if (answer) return answer(process, command);
    const state =
      command.cmd === "pause"
        ? "paused"
        : command.cmd === "stop"
          ? "stopped"
          : "playing";
    process.push({
      id: command.id,
      ok: true,
      state,
      position: 12,
      duration: 242,
      volume: 1,
    });
  };
  return process;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function player(answer?: Parameters<typeof fakePlayer>[0]) {
  const spawned: ReturnType<typeof fakePlayer>[] = [];
  const asked: string[] = [];
  const using = new YoutubePlayer(
    () => {
      const process = fakePlayer(answer);
      spawned.push(process);
      return process as PlayerProcess;
    },
    async (what) => {
      asked.push(what);
      return TRACK;
    },
    1000,
  );
  return { using, spawned, asked };
}

describe("the YouTube player", () => {
  test("play starts the player and gives it the stream and headers", async () => {
    const { using, spawned, asked } = player();
    const status = await using.play("around the world");
    expect(asked).toEqual(["around the world"]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.written[0]).toEqual({
      id: 1,
      cmd: "play",
      uri: TRACK.stream,
      headers: TRACK.headers,
    });
    expect(status).toEqual({
      state: "playing",
      position: 12,
      duration: 242,
      volume: 100,
      track: { title: TRACK.title, url: TRACK.url, channel: TRACK.channel },
    });
  });

  test("pause, resume, volume, seek and status go to the same player", async () => {
    const { using, spawned } = player();
    await using.play("x");
    expect((await using.pause()).state).toBe("paused");
    expect((await using.resume()).state).toBe("playing");
    expect((await using.volume(40)).volume).toBe(40);
    await using.seek({ by: 30 });
    await using.seek({ position: 5 });
    expect((await using.nowPlaying()).track?.title).toBe(TRACK.title);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.written.map((each) => each.cmd)).toEqual([
      "play",
      "pause",
      "resume",
      "volume",
      "status",
      "seek",
      "seek",
      "status",
    ]);
    expect(spawned[0]!.written[3]!.volume).toBe(0.4);
    // 12 s in, 30 s ahead.
    expect(spawned[0]!.written[5]!.position).toBe(42);
    expect(spawned[0]!.written[6]!.position).toBe(5);
  });

  test("with nothing playing, nothing starts", async () => {
    const { using, spawned } = player();
    await expect(using.pause()).rejects.toThrow("nothing is playing");
    expect(await using.nowPlaying()).toEqual({ state: "stopped", volume: 100 });
    expect((await using.stop()).state).toBe("stopped");
    expect(spawned).toHaveLength(0);
  });

  test("stop ends the player's process", async () => {
    const { using, spawned } = player();
    await using.play("x");
    const stopped = await using.stop();
    expect(stopped.state).toBe("stopped");
    expect(stopped.track).toBeUndefined();
    expect(spawned[0]!.closed).toBe(true);
    // The next video starts a new one.
    await using.play("y");
    expect(spawned).toHaveLength(2);
  });

  test("a failed start is told with the player's reason", async () => {
    const { using } = player((process, command) =>
      process.push({ id: command.id, ok: false, error: "Forbidden" }),
    );
    await expect(using.play("x")).rejects.toThrow("Forbidden");
  });

  test("Spotify paused for it, and the video's end, are told", async () => {
    const { using, spawned } = player();
    const playing = using.play("x");
    await settle();
    spawned[0]!.push({ event: "spotify_paused" });
    await settle();
    expect((await playing).spotifyPaused).toBeUndefined();
    spawned[0]!.reply = (command) => {
      spawned[0]!.push({ event: "spotify_paused" });
      spawned[0]!.push({ id: command.id, ok: true, state: "playing" });
    };
    expect((await using.resume()).spotifyPaused).toBe(true);
    spawned[0]!.push({ event: "ended" });
    await settle();
    await settle();
    expect(spawned[0]!.closed).toBe(true);
    expect(await using.nowPlaying()).toEqual({
      state: "stopped",
      volume: 100,
      ended: "the video ended",
    });
  });

  test("Spotify starting stops YouTube", async () => {
    const { using, spawned } = player();
    await using.play("x");
    await using.spotifyStarted();
    expect(spawned[0]!.written.at(-1)!.cmd).toBe("stop");
    expect(spawned[0]!.closed).toBe(true);
    expect((await using.nowPlaying()).ended).toBe("Spotify started playing");
    // Nothing to stop: nothing is started for it.
    await using.spotifyStarted();
    expect(spawned).toHaveLength(1);
  });

  test("a player that dies fails what waited", async () => {
    const { using, spawned } = player();
    await using.play("x");
    spawned[0]!.reply = () => spawned[0]!.close();
    await expect(using.pause()).rejects.toThrow("the player stopped");
  });
});

describe("voice.json's YouTube", () => {
  test("on with call_background, into roamgate-music by default", () => {
    expect(youtubeConfig({ helper: "h" })).toBeNull();
    expect(
      youtubeConfig({ helper: "h", call_background: "x", youtube_sink: false }),
    ).toBeNull();
    expect(youtubeConfig({ helper: "h", call_background: "x" })).toEqual({
      sink: "roamgate-music",
      wrapper: [],
      ytDlp: ["yt-dlp"],
    });
    const on = youtubeConfig({
      helper: "h",
      call_background: "x",
      youtube_sink: "scratch",
      youtube_player_wrapper: ["systemd-run", "--user", "--pipe", "--"],
      yt_dlp: ["/opt/yt-dlp"],
    })!;
    expect(on.ytDlp).toEqual(["/opt/yt-dlp"]);
    const command = playerCommand(on);
    expect(command.slice(0, 6)).toEqual([
      "systemd-run",
      "--user",
      "--pipe",
      "--",
      "python3",
      "-I",
    ]);
    expect(command.slice(-2)).toEqual(["scratch", SPOTIFY_MPRIS]);
  });

  test("its keys are checked", () => {
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
      expect(read({ youtube_sink: 3 })).toEqual({
        error: expect.stringContaining("youtube_sink must be"),
      });
      expect(read({ yt_dlp: [] })).toEqual({
        error: expect.stringContaining("yt_dlp must be"),
      });
      expect(read({ youtube_player_wrapper: "systemd-run" })).toEqual({
        error: expect.stringContaining("youtube_player_wrapper must be"),
      });
      expect(
        read({
          youtube_sink: false,
          yt_dlp: ["yt-dlp"],
          youtube_player_wrapper: [],
        }),
      ).not.toHaveProperty("error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the player script", () => {
  test.skipIf(!Bun.which("python3"))("is valid Python", async () => {
    const child = Bun.spawn(
      [
        "python3",
        "-I",
        "-c",
        "import sys; compile(sys.stdin.read(), 'player', 'exec')",
      ],
      { stdin: new TextEncoder().encode(PLAYER_SCRIPT), stderr: "pipe" },
    );
    expect(await child.exited).toBe(0);
  });
});
