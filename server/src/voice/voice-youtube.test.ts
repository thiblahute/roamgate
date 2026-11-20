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

/** Whether Python has GStreamer's bindings, to run the player's code. */
const PLAYER_PYTHON =
  !!Bun.which("python3") &&
  Bun.spawnSync([
    "python3",
    "-I",
    "-c",
    "import gi; gi.require_version('Gst', '1.0'); from gi.repository import Gst",
  ]).exitCode === 0;

/**
 * Runs the player's code on a scenario, with a fake playing pipeline, a
 * fake pactl answering `streams` (the Spotify app's sink inputs, one list
 * a poll, the last one repeated; null: pactl fails) and a fake Spotify
 * MPRIS saying Playing: "signal" sends its PropertiesChanged, "pause"
 * starts a video (pause_spotify), "pactl" runs PACTL itself.
 */
const PLAYER_DRIVER = String.raw`import json
import sys

scenario = json.loads(sys.argv[1])
sys.argv = ["player", "test-sink", "org.mpris.MediaPlayer2.fake"]
player = {"__name__": "player_test"}
exec(compile(sys.stdin.read(), "player", "exec"), player)
from gi.repository import GLib, Gst

said = []
calls = []
polls = []
player["say"] = said.append
player["GRACE_S"] = 0.3
player["POLL_MS"] = 20
streams = scenario.get("streams")


def pactl_json(*args):
    if streams is None:
        raise OSError("no pactl")
    if args[-1] == "sinks":
        return [{"index": 1, "name": "test-sink"}, {"index": 2, "name": "speakers"}]
    polls.append(args)
    return streams[min(len(polls), len(streams)) - 1]


class Pipeline:
    state = Gst.State.PLAYING

    def get_state(self, _timeout):
        return (Gst.StateChangeReturn.SUCCESS, self.state, Gst.State.VOID_PENDING)

    def set_state(self, state):
        self.state = state
        calls.append("set_state")

    def get_bus(self):
        return self

    def remove_signal_watch(self):
        pass


def dbus(_name, _path, _iface, method, _args=None):
    calls.append(method)
    return ("Playing",) if method == "Get" else ()


if scenario["run"] == "pactl":
    player["PACTL"] = [sys.executable, "-c", "import json, sys; print(json.dumps(sys.argv[1:]))"]
    print(json.dumps(player["pactl_json"]("list", "sink-inputs")))
    sys.exit(0)
player["pactl_json"] = pactl_json
player["pipeline"] = Pipeline()
player["owners"] = lambda: {":1.5"}
player["spotify_names"] = lambda: ["org.mpris.MediaPlayer2.fake"]
player["dbus"] = dbus
if scenario["run"] == "signal":
    player["on_properties"](
        None, ":1.5", "/org/mpris/MediaPlayer2", "org.freedesktop.DBus.Properties",
        "PropertiesChanged",
        GLib.Variant("(sa{sv}as)", (
            "org.mpris.MediaPlayer2.Player",
            {"PlaybackStatus": GLib.Variant("s", "Playing")}, [],
        )),
        None,
    )
    loop = GLib.MainLoop()
    GLib.timeout_add(600, loop.quit)
    loop.run()
else:
    player["pause_spotify"]()
print(json.dumps({
    "said": said,
    "playing": player["pipeline"] is not None,
    "paused": "Pause" in calls,
    "polls": len(polls),
}))
`;

async function runPlayer(scenario: {
  run: "signal" | "pause" | "pactl";
  streams?: unknown[][] | null;
}): Promise<{
  said: Record<string, unknown>[];
  playing: boolean;
  paused: boolean;
  polls: number;
}> {
  const child = Bun.spawn(
    ["python3", "-I", "-c", PLAYER_DRIVER, JSON.stringify(scenario)],
    {
      stdin: new TextEncoder().encode(PLAYER_SCRIPT),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the player's code failed: ${err}`);
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

/** A sink input of the Spotify app's, into `sink` (1: the player's). */
function spotifyStream(sink = 1, corked = false) {
  return {
    index: 9,
    sink,
    corked,
    properties: { "node.name": "spotify", "application.name": "spotify" },
  };
}

const YOUTUBE_STREAM = {
  index: 8,
  sink: 1,
  corked: false,
  properties: { "application.name": "Roamgate YouTube" },
};

describe.skipIf(!PLAYER_PYTHON)("the player and the Spotify app", () => {
  test("Spotify playing on another device leaves the video", async () => {
    // Spotify Connect: the desktop app mirrors the account's playing on
    // someone else's phone, saying Playing with no sound of its own.
    const done = await runPlayer({
      run: "signal",
      streams: [[YOUTUBE_STREAM]],
    });
    expect(done.playing).toBe(true);
    expect(done.said).toEqual([{ event: "spotify_elsewhere" }]);
    expect(done.polls).toBeGreaterThan(1);
  });

  test("the Spotify app playing into the sink stops it, once its stream comes", async () => {
    const done = await runPlayer({
      run: "signal",
      streams: [[YOUTUBE_STREAM], [YOUTUBE_STREAM], [spotifyStream()]],
    });
    expect(done.playing).toBe(false);
    expect(done.said).toEqual([
      { event: "stopped", reason: "Spotify started playing" },
    ]);
  });

  test("a corked Spotify stream, or one on another sink, leaves it", async () => {
    for (const stream of [spotifyStream(1, true), spotifyStream(2)]) {
      const done = await runPlayer({ run: "signal", streams: [[stream]] });
      expect(done.playing).toBe(true);
    }
  });

  test("when pactl cannot tell, Spotify's Playing stops it as before", async () => {
    const done = await runPlayer({ run: "signal", streams: null });
    expect(done.playing).toBe(false);
  });

  test("starting a video pauses the Spotify app only when it plays here", async () => {
    const elsewhere = await runPlayer({ run: "pause", streams: [[]] });
    expect(elsewhere.paused).toBe(false);
    expect(elsewhere.said).toEqual([]);
    const here = await runPlayer({
      run: "pause",
      streams: [[spotifyStream()]],
    });
    expect(here.paused).toBe(true);
    expect(here.said).toEqual([{ event: "spotify_paused" }]);
  });

  test("pactl is asked for JSON", async () => {
    const child = Bun.spawn(
      ["python3", "-I", "-c", PLAYER_DRIVER, '{"run":"pactl"}'],
      { stdin: new TextEncoder().encode(PLAYER_SCRIPT), stdout: "pipe" },
    );
    const out = await new Response(child.stdout).text();
    expect(JSON.parse(out)).toEqual(["-f", "json", "list", "sink-inputs"]);
  });
});
