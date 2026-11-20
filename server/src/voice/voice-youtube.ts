import { serverLogger } from "../utils/logger";
import type { VoiceConfig } from "./voice-helper";

/**
 * YouTube as a source of a call's music, beside Spotify: yt-dlp finds the
 * video (a search or a link) and its audio stream where Roamgate runs, and
 * a small player plays that stream's sound, never a picture, into the sink
 * whose monitor call_background records (`roamgate-music` on the desktop),
 * so the call hears it as it hears the Spotify app.
 *
 * The player is its own long-lived process (PLAYER_SCRIPT): GStreamer's
 * playbin3 and pulsesink, through Python, started where the sound server is
 * (youtube_player_wrapper, as helper_wrapper starts the voice helper on the
 * host) and driven by JSON lines on its standard input and output. It is
 * not the voice helper's: the helper's statically linked GStreamer has no
 * HTTPS source or AAC decoder, and the music has to go on whether or not a
 * call, or the helper, runs. Its input closing ends it.
 *
 * Spotify and YouTube never play together: the player pauses the Spotify
 * app (its MPRIS player on the session bus) when it starts or resumes, and
 * stops when that app starts playing; the companion's tools stop it, too,
 * when they start Spotify on the call's music device (voice-tools.ts).
 * Only the Spotify app's own sound counts: with Spotify Connect, the app
 * also says Playing when the account plays on another device (someone
 * else's phone), and pausing it then pauses that device. So the player
 * checks that the app has a stream playing here (pactl's sink inputs),
 * into the sink for a stop.
 */

const log = serverLogger.child("voice-youtube");

/** The sink the player plays into when voice.json names none. */
export const DEFAULT_YOUTUBE_SINK = "roamgate-music";
/** The MPRIS bus name prefix of the Spotify app, paused by YouTube. */
export const SPOTIFY_MPRIS = "org.mpris.MediaPlayer2.spotify";
/** How long yt-dlp may take to find a video and its stream. */
const RESOLVE_MS = 45_000;
/** How long a command may wait for the player (a start waits for sound). */
const COMMAND_MS = 40_000;

/**
 * The player: argv[1] the sink, argv[2] the MPRIS name prefix to pause,
 * argv[3] (optional) the pactl command as a JSON list. Commands, one JSON object a line: {"id", "cmd": "play", "uri",
 * "headers"}, "pause", "resume", "stop", "volume" ("volume" 0 to 1),
 * "seek" ("position" in seconds), "status". Each is answered on its id
 * with {"ok": true, "state", "position", "duration", "volume"} or {"ok":
 * false, "error"}; a start is answered once sound plays. Events: "ready",
 * "ended", "error", "stopped" (Spotify started), "spotify_paused",
 * "spotify_elsewhere" (Spotify said Playing, but not here: it goes on).
 */
export const PLAYER_SCRIPT = String.raw`import json
import subprocess
import sys

import gi

gi.require_version("Gst", "1.0")
from gi.repository import Gio, GLib, Gst

SINK = sys.argv[1]
MPRIS = sys.argv[2]
PACTL = json.loads(sys.argv[3]) if len(sys.argv) > 3 else ["pactl"]
PLAYER_PATH = "/org/mpris/MediaPlayer2"
PLAYER_IFACE = "org.mpris.MediaPlayer2.Player"
START_S = 30
# How long the Spotify app has to open its stream once it says Playing.
GRACE_S = 5
POLL_MS = 250

Gst.init(None)
loop = GLib.MainLoop()
try:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
except GLib.Error:
    bus = None
pipeline = None
pending = None
volume = 1.0
watching = None


def say(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def seconds(value):
    return round(value / Gst.SECOND, 1) if value >= 0 else None


def state():
    if pipeline is None:
        return {"state": "stopped", "volume": volume}
    _, current, target = pipeline.get_state(0)
    playing = Gst.State.PLAYING in (current, target)
    ok, position = pipeline.query_position(Gst.Format.TIME)
    known, duration = pipeline.query_duration(Gst.Format.TIME)
    return {
        "state": "playing" if playing else "paused",
        "position": seconds(position) if ok else None,
        "duration": seconds(duration) if known else None,
        "volume": volume,
    }


def answer(request_id, error=None):
    if error:
        say({"id": request_id, "ok": False, "error": error})
    else:
        say({"id": request_id, "ok": True, **state()})


def dbus(name, path, iface, method, args=None):
    return bus.call_sync(
        name, path, iface, method, args, None, Gio.DBusCallFlags.NONE, 2000, None
    ).unpack()


def spotify_names():
    if bus is None:
        return []
    try:
        names = dbus(
            "org.freedesktop.DBus", "/org/freedesktop/DBus",
            "org.freedesktop.DBus", "ListNames",
        )[0]
    except GLib.Error:
        return []
    return [n for n in names if n == MPRIS or n.startswith(MPRIS + ".")]


def pactl_json(*args):
    done = subprocess.run(
        PACTL + ["-f", "json", *args], capture_output=True, timeout=3, check=True
    )
    return json.loads(done.stdout or b"[]")


def is_spotify(stream):
    props = stream.get("properties") or {}
    return any(
        "spotify" in str(props.get(key, "")).lower()
        for key in ("node.name", "application.name", "application.process.binary")
    )


def spotify_here(into_sink):
    # Whether the Spotify app plays sound here (into SINK when into_sink):
    # an uncorked stream of its. Connect mirrors another device's playing
    # in the app's MPRIS without a stream. None when pactl cannot tell.
    try:
        inputs = pactl_json("list", "sink-inputs")
        sinks = (
            {each.get("index"): each.get("name")
             for each in pactl_json("list", "short", "sinks")}
            if into_sink else {}
        )
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        sys.stderr.write("roamgate youtube: pactl failed: %s\n" % error)
        return None
    return any(
        is_spotify(each) and not each.get("corked")
        and (not into_sink or sinks.get(each.get("sink")) == SINK)
        for each in inputs
    )


def pause_spotify():
    paused = False
    here = None
    for name in spotify_names():
        try:
            status = dbus(
                name, PLAYER_PATH, "org.freedesktop.DBus.Properties", "Get",
                GLib.Variant("(ss)", (PLAYER_IFACE, "PlaybackStatus")),
            )[0]
            if status != "Playing":
                continue
            # Pausing an app that mirrors another device pauses that device.
            if here is None:
                here = spotify_here(False) is not False
            if here:
                dbus(name, PLAYER_PATH, PLAYER_IFACE, "Pause")
                paused = True
        except GLib.Error:
            continue
    if paused:
        say({"event": "spotify_paused"})


def owners():
    found = set()
    for name in spotify_names():
        try:
            found.add(dbus(
                "org.freedesktop.DBus", "/org/freedesktop/DBus",
                "org.freedesktop.DBus", "GetNameOwner",
                GLib.Variant("(s)", (name,)),
            )[0])
        except GLib.Error:
            continue
    return found


def video_playing():
    return (
        pipeline is not None and pending is None
        and Gst.State.PLAYING in pipeline.get_state(0)[1:]
    )


def on_properties(_bus, sender, _path, _iface, _signal, params, _data):
    iface, changed, _ = params.unpack()
    if iface != PLAYER_IFACE or changed.get("PlaybackStatus") != "Playing":
        return
    if not video_playing() or sender not in owners():
        return
    watch_spotify()


def watch_spotify():
    # The video stops once the Spotify app plays into SINK, within GRACE_S;
    # an app saying Playing for another device leaves it.
    global watching
    if watching is not None:
        return
    deadline = GLib.get_monotonic_time() + GRACE_S * 1000000

    def check():
        global watching
        if not video_playing():
            watching = None
            return False
        if spotify_here(True) is not False:
            watching = None
            stop()
            say({"event": "stopped", "reason": "Spotify started playing"})
            return False
        if GLib.get_monotonic_time() >= deadline:
            watching = None
            say({"event": "spotify_elsewhere"})
            return False
        return True

    if check():
        watching = GLib.timeout_add(POLL_MS, check)


def stop():
    global pipeline
    if pipeline is not None:
        pipeline.set_state(Gst.State.NULL)
        pipeline.get_bus().remove_signal_watch()
        pipeline = None


def finish_pending(error=None):
    global pending
    if pending is None:
        return
    request_id, timer = pending
    pending = None
    GLib.source_remove(timer)
    if error:
        stop()
    answer(request_id, error)


def on_message(_bus, message):
    if message.type == Gst.MessageType.ERROR:
        reason = message.parse_error()[0].message
        if pending is not None:
            finish_pending(reason)
        else:
            stop()
            say({"event": "error", "error": reason})
    elif message.type == Gst.MessageType.EOS:
        stop()
        say({"event": "ended"})
    elif (
        message.type == Gst.MessageType.STATE_CHANGED
        and message.src == pipeline
        and message.parse_state_changed()[1] == Gst.State.PLAYING
    ):
        finish_pending()


def on_source_setup(_playbin, source, headers):
    names = [p.name for p in source.list_properties()]
    for key, value in headers.items():
        if key.lower() == "user-agent" and "user-agent" in names:
            source.set_property("user-agent", value)
    if "extra-headers" in names:
        extra = Gst.Structure.new_empty("extra-headers")
        for key, value in headers.items():
            if key.lower() != "user-agent":
                extra.set_value(key, value)
        source.set_property("extra-headers", extra)


def play(request_id, uri, headers):
    global pipeline, pending
    finish_pending("another video was asked for")
    stop()
    playbin = Gst.ElementFactory.make("playbin3", None)
    sink = Gst.ElementFactory.make("pulsesink", None)
    if playbin is None or sink is None:
        answer(request_id, "GStreamer's playbin3 or pulsesink is missing")
        return
    pause_spotify()
    sink.set_property("device", SINK)
    sink.set_property("client-name", "Roamgate YouTube")
    playbin.set_property("audio-sink", sink)
    playbin.set_property("video-sink", Gst.ElementFactory.make("fakesink", None))
    # Sound only: no picture or subtitles decoded (audio | soft-volume).
    playbin.set_property("flags", 0x2 | 0x10)
    playbin.set_property("uri", uri)
    playbin.set_property("volume", volume)
    playbin.connect("source-setup", on_source_setup, headers or {})
    watch = playbin.get_bus()
    watch.add_signal_watch()
    watch.connect("message", on_message)
    pipeline = playbin

    def late():
        finish_pending("no sound came within %d s" % START_S)
        return False

    pending = (request_id, GLib.timeout_add_seconds(START_S, late))
    if playbin.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
        finish_pending("the sink %s could not be opened" % SINK)


def command(line):
    global volume
    try:
        request = json.loads(line)
        request_id = request.get("id")
        cmd = request.get("cmd")
    except (ValueError, AttributeError):
        return
    if cmd == "play":
        play(request_id, str(request.get("uri", "")), request.get("headers"))
    elif cmd == "status":
        answer(request_id)
    elif cmd == "stop":
        finish_pending("it was stopped")
        stop()
        answer(request_id)
    elif cmd == "volume":
        volume = min(1.0, max(0.0, float(request.get("volume", 1))))
        if pipeline is not None:
            pipeline.set_property("volume", volume)
        answer(request_id)
    elif cmd not in ("pause", "resume", "seek"):
        answer(request_id, "unknown command %r" % cmd)
    elif pipeline is None:
        answer(request_id, "nothing is playing")
    elif cmd == "pause":
        pipeline.set_state(Gst.State.PAUSED)
        answer(request_id)
    elif cmd == "resume":
        pause_spotify()
        pipeline.set_state(Gst.State.PLAYING)
        answer(request_id)
    else:
        at = max(0.0, float(request.get("position", 0)))
        known, duration = pipeline.query_duration(Gst.Format.TIME)
        if known and duration > 0:
            at = min(at, max(0.0, duration / Gst.SECOND - 1))
        if pipeline.seek_simple(
            Gst.Format.TIME, Gst.SeekFlags.FLUSH, int(at * Gst.SECOND)
        ):
            pipeline.get_state(5 * Gst.SECOND)
            answer(request_id)
        else:
            answer(request_id, "this video cannot seek")


def on_input(channel, condition):
    if condition & GLib.IOCondition.IN:
        line = channel.readline()
        if line:
            command(line)
            return True
    stop()
    loop.quit()
    return False


if __name__ == "__main__":
    if bus is not None:
        bus.signal_subscribe(
            None, "org.freedesktop.DBus.Properties", "PropertiesChanged",
            PLAYER_PATH, None, Gio.DBusSignalFlags.NONE, on_properties, None,
        )
    GLib.io_add_watch(
        GLib.IOChannel.unix_new(sys.stdin.fileno()), GLib.PRIORITY_DEFAULT,
        GLib.IOCondition.IN | GLib.IOCondition.HUP | GLib.IOCondition.ERR,
        on_input,
    )
    say({"event": "ready", "sink": SINK})
    loop.run()
`;

/** A video found: what plays, and the stream the player reads. */
export type YoutubeTrack = {
  title: string;
  /** Its YouTube page. */
  url: string;
  channel?: string;
  /** In seconds; none for a live stream. */
  duration?: number;
  /** The audio stream's URL and the HTTP headers it is read with. */
  stream: string;
  headers: Record<string, string>;
};

/** What the player does, as the companion's tools tell it. */
export type YoutubeStatus = {
  state: "playing" | "paused" | "stopped";
  /** In seconds. */
  position?: number;
  duration?: number;
  /** 0 to 100. */
  volume: number;
  track?: Pick<YoutubeTrack, "title" | "url" | "channel">;
  /** Why it stopped by itself: the video ended, Spotify started, ... */
  ended?: string;
  /** Whether starting or resuming it paused the Spotify app. */
  spotifyPaused?: boolean;
};

/** A failure told as is: "the video could not be played: <reason>". */
export class YoutubeError extends Error {}

const YOUTUBE_HOSTS =
  /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)$|^youtu\.be$/;

/**
 * yt-dlp's target for what was asked: a YouTube link as is, any other
 * words as a search taking the first video. A link elsewhere is refused.
 */
export function youtubeTarget(asked: string): string {
  const text = asked.trim();
  if (!text) throw new YoutubeError("nothing was asked for");
  if (/^https?:\/\//i.test(text)) {
    let host: string;
    try {
      host = new URL(text).hostname.toLowerCase();
    } catch {
      throw new YoutubeError(`${text} is not a link`);
    }
    if (!YOUTUBE_HOSTS.test(host))
      throw new YoutubeError(`${host} is not YouTube`);
    return text;
  }
  return `ytsearch1:${text}`;
}

/** yt-dlp's arguments: one video's JSON, its best audio-only stream. */
export function ytDlpArgs(command: string[], target: string): string[] {
  return [
    ...command,
    "--dump-json",
    "--no-playlist",
    "--no-warnings",
    "--format",
    "bestaudio[acodec=opus]/bestaudio/best",
    "--",
    target,
  ];
}

/** Why yt-dlp failed, from what it wrote, with what to do about it. */
export function ytDlpFailure(stderr: string, code: number | null): string {
  const line =
    stderr
      .split("\n")
      .map((each) => each.trim())
      .filter((each) => each.startsWith("ERROR:"))
      .at(-1) ??
    stderr.trim().split("\n").at(-1)?.trim() ??
    "";
  const reason =
    line
      .replace(/^ERROR:\s*/, "")
      .replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, "")
      .slice(0, 300) || `yt-dlp ended with ${code ?? "a signal"}`;
  return outdated(reason) ? `${reason} ${UPDATE_HINT}` : reason;
}

const UPDATE_HINT =
  "(YouTube may have changed: yt-dlp likely needs an update, `yt-dlp -U`)";

/** Whether a failure looks like YouTube's changes yt-dlp has not caught up with. */
function outdated(reason: string): boolean {
  return /\b403\b|forbidden|sign in to confirm|signature|nsig|po token|unable to extract|player response/i.test(
    reason,
  );
}

/** The track in yt-dlp's JSON output: its last JSON line. */
export function parseYtDlp(stdout: string): YoutubeTrack {
  const line = stdout
    .split("\n")
    .map((each) => each.trim())
    .filter((each) => each.startsWith("{"))
    .at(-1);
  if (!line) throw new YoutubeError("nothing was found on YouTube");
  let video: Record<string, unknown>;
  try {
    video = JSON.parse(line);
  } catch {
    throw new YoutubeError("yt-dlp's answer could not be read");
  }
  const stream = typeof video.url === "string" ? video.url : "";
  if (!stream) throw new YoutubeError("the video has no audio stream");
  const headers: Record<string, string> = {};
  if (video.http_headers && typeof video.http_headers === "object")
    for (const [key, value] of Object.entries(video.http_headers))
      if (typeof value === "string") headers[key] = value;
  const text = (key: string) =>
    typeof video[key] === "string" && video[key] ? (video[key] as string) : "";
  return {
    title: text("title") || "an untitled video",
    url: text("webpage_url") || text("original_url"),
    ...(text("channel") || text("uploader")
      ? { channel: text("channel") || text("uploader") }
      : {}),
    ...(typeof video.duration === "number" && video.duration > 0
      ? { duration: Math.round(video.duration) }
      : {}),
    stream,
    headers,
  };
}

/** What runs yt-dlp: its exit code and output. */
export type RunCommand = (
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export const runCommand: RunCommand = async (args, timeoutMs) => {
  const child = Bun.spawn(args, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const late = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      code,
      stdout,
      stderr: child.signalCode
        ? `ERROR: no answer within ${timeoutMs / 1000} s`
        : stderr,
    };
  } finally {
    clearTimeout(late);
  }
};

/** Finds `asked` (words or a YouTube link) with yt-dlp. */
export async function resolveYoutube(
  asked: string,
  command: string[] = ["yt-dlp"],
  run: RunCommand = runCommand,
): Promise<YoutubeTrack> {
  const target = youtubeTarget(asked);
  let done: Awaited<ReturnType<RunCommand>>;
  try {
    done = await run(ytDlpArgs(command, target), RESOLVE_MS);
  } catch (error) {
    throw new YoutubeError(
      `${command[0]} could not be run (${(error as Error).message}): install yt-dlp, or set voice.json's yt_dlp`,
    );
  }
  if (done.code !== 0)
    throw new YoutubeError(ytDlpFailure(done.stderr, done.code));
  return parseYtDlp(done.stdout);
}

/** The player's process: its lines, its input, and its end. */
export type PlayerProcess = {
  lines: AsyncIterable<string>;
  write: (line: string) => void;
  /** Ends it: its input closes. */
  close: () => void;
  exited: Promise<unknown>;
};

type PlayerReply = {
  id?: number;
  ok?: boolean;
  error?: string;
  event?: string;
  reason?: string;
  state?: YoutubeStatus["state"];
  position?: number | null;
  duration?: number | null;
  volume?: number;
};

/**
 * The YouTube player of the companion's tools: one process at a time,
 * started for the first video, ended by stop (or when it ends by itself);
 * each command waits for its answer.
 */
export class YoutubePlayer {
  private process: PlayerProcess | null = null;
  private waiting = new Map<
    number,
    { resolve: (reply: PlayerReply) => void; reject: (error: Error) => void }
  >();
  private count = 0;
  private track: YoutubeTrack | null = null;
  private ended: string | undefined;
  private pausedSpotify = false;
  /** 0 to 1, kept for the next video. */
  private level = 1;

  constructor(
    private readonly spawn: () => PlayerProcess,
    private readonly resolve: (asked: string) => Promise<YoutubeTrack>,
    private readonly timeoutMs = COMMAND_MS,
  ) {}

  /** Finds `asked` and plays it, pausing Spotify; what plays. */
  async play(asked: string): Promise<YoutubeStatus> {
    const track = await this.resolve(asked);
    this.pausedSpotify = false;
    const reply = await this.send({
      cmd: "play",
      uri: track.stream,
      headers: track.headers,
    });
    this.track = track;
    this.ended = undefined;
    return this.status(reply);
  }

  async pause(): Promise<YoutubeStatus> {
    return this.status(await this.send({ cmd: "pause" }, false));
  }

  /** Plays again what was paused, pausing Spotify. */
  async resume(): Promise<YoutubeStatus> {
    this.pausedSpotify = false;
    return this.status(await this.send({ cmd: "resume" }, false));
  }

  /** Stops and ends the player; nothing to do when none runs. */
  async stop(): Promise<YoutubeStatus> {
    if (!this.process) return this.status({ state: "stopped" });
    const process = this.process;
    let reply: PlayerReply = { state: "stopped" };
    try {
      reply = await this.send({ cmd: "stop" }, false);
    } finally {
      this.track = null;
      if (this.process === process) this.end(process);
    }
    return this.status(reply);
  }

  /** The player's own volume, 0 to 100 (the call sets the music's level). */
  async volume(percent: number): Promise<YoutubeStatus> {
    this.level = Math.min(100, Math.max(0, percent)) / 100;
    if (!this.process) return this.status({ state: "stopped" });
    return this.status(
      await this.send({ cmd: "volume", volume: this.level }, false),
    );
  }

  /** Goes to `position` seconds, or `by` seconds from where it is. */
  async seek(to: { position?: number; by?: number }): Promise<YoutubeStatus> {
    let position = to.position;
    if (position === undefined) {
      const now = await this.send({ cmd: "status" }, false);
      position = (now.position ?? 0) + (to.by ?? 0);
    }
    return this.status(
      await this.send({ cmd: "seek", position: Math.max(0, position) }, false),
    );
  }

  /** What plays now. */
  async nowPlaying(): Promise<YoutubeStatus> {
    if (!this.process) return this.status({ state: "stopped" });
    return this.status(await this.send({ cmd: "status" }, false));
  }

  /** Spotify started: YouTube stops, so they never play together. */
  async spotifyStarted(): Promise<void> {
    if (!this.process || !this.track) return;
    await this.stop().catch(() => {});
    this.ended = "Spotify started playing";
  }

  private status(reply: PlayerReply): YoutubeStatus {
    const state = reply.state ?? "stopped";
    return {
      state,
      ...(typeof reply.position === "number"
        ? { position: reply.position }
        : {}),
      ...(typeof reply.duration === "number"
        ? { duration: reply.duration }
        : this.track?.duration && state !== "stopped"
          ? { duration: this.track.duration }
          : {}),
      volume: Math.round(this.level * 100),
      ...(this.track && state !== "stopped"
        ? {
            track: {
              title: this.track.title,
              url: this.track.url,
              ...(this.track.channel ? { channel: this.track.channel } : {}),
            },
          }
        : {}),
      ...(state === "stopped" && this.ended ? { ended: this.ended } : {}),
      ...(this.pausedSpotify && state === "playing"
        ? { spotifyPaused: true }
        : {}),
    };
  }

  /** Sends a command; `start`: starting the player when none runs. */
  private async send(
    command: Record<string, unknown>,
    start = true,
  ): Promise<PlayerReply> {
    if (!this.process) {
      if (!start) {
        if (command.cmd === "status") return { state: "stopped" };
        throw new YoutubeError("nothing is playing on YouTube");
      }
      this.process = this.started();
      if (this.level !== 1)
        void this.send({ cmd: "volume", volume: this.level }, false).catch(
          () => {},
        );
    }
    const process = this.process;
    this.count += 1;
    const id = this.count;
    const reply = new Promise<PlayerReply>((resolve, reject) => {
      const late = setTimeout(() => {
        this.waiting.delete(id);
        reject(new YoutubeError("the player did not answer"));
      }, this.timeoutMs);
      this.waiting.set(id, {
        resolve: (value) => {
          clearTimeout(late);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(late);
          reject(error);
        },
      });
    });
    try {
      process.write(`${JSON.stringify({ id, ...command })}\n`);
    } catch (error) {
      this.waiting
        .get(id)
        ?.reject(
          new YoutubeError(
            `the player could not be reached: ${(error as Error).message}`,
          ),
        );
    }
    const answer = await reply;
    if (!answer.ok) throw new YoutubeError(answer.error ?? "the player failed");
    return answer;
  }

  private started(): PlayerProcess {
    let process: PlayerProcess;
    try {
      process = this.spawn();
    } catch (error) {
      throw new YoutubeError(
        `the player could not start: ${(error as Error).message}`,
      );
    }
    void this.follow(process);
    return process;
  }

  private async follow(process: PlayerProcess) {
    try {
      for await (const line of process.lines) {
        let reply: PlayerReply;
        try {
          reply = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof reply.id === "number") {
          const waiter = this.waiting.get(reply.id);
          this.waiting.delete(reply.id);
          waiter?.resolve(reply);
          continue;
        }
        if (this.process !== process) continue;
        if (reply.event === "spotify_paused") this.pausedSpotify = true;
        if (reply.event === "spotify_elsewhere")
          log.info("youtube goes on: Spotify plays on another device");
        if (
          reply.event === "ended" ||
          reply.event === "error" ||
          reply.event === "stopped"
        ) {
          this.ended =
            reply.event === "ended"
              ? "the video ended"
              : reply.event === "error"
                ? `it failed: ${reply.error ?? "unknown error"}`
                : (reply.reason ?? "it stopped");
          log.info("youtube stopped", { reason: this.ended });
          this.track = null;
          this.end(process);
        }
      }
    } catch (error) {
      log.warn("youtube player output failed", {
        error: (error as Error).message,
      });
    }
    if (this.process === process) {
      this.process = null;
      this.track = null;
    }
    for (const [id, waiter] of this.waiting) {
      this.waiting.delete(id);
      waiter.reject(new YoutubeError("the player stopped"));
    }
  }

  private end(process: PlayerProcess) {
    if (this.process === process) this.process = null;
    try {
      process.close();
    } catch {
      // Already gone.
    }
  }
}

/** voice.json's YouTube player, or null when it is off. */
export type YoutubeConfig = {
  sink: string;
  wrapper: string[];
  ytDlp: string[];
};

/**
 * Whether the companion has YouTube for a call's music, and how: with
 * call_background set, unless youtube_sink is false.
 */
export function youtubeConfig(config: VoiceConfig): YoutubeConfig | null {
  if (config.youtube_sink === false || !config.call_background?.trim())
    return null;
  return {
    sink: config.youtube_sink?.trim() || DEFAULT_YOUTUBE_SINK,
    wrapper: config.youtube_player_wrapper ?? [],
    ytDlp: config.yt_dlp?.length ? config.yt_dlp : ["yt-dlp"],
  };
}

/** The player's command line: the wrapper, then Python and the script. */
export function playerCommand(config: YoutubeConfig): string[] {
  return [
    ...config.wrapper,
    "python3",
    "-I",
    "-c",
    PLAYER_SCRIPT,
    config.sink,
    SPOTIFY_MPRIS,
  ];
}

/**
 * How long a wrapped player has to end once its input closed before its
 * wrapper is signalled.
 */
const WRAPPED_EXIT_MS = 5_000;

export function spawnYoutubePlayer(config: YoutubeConfig): PlayerProcess {
  const child = Bun.spawn(playerCommand(config), {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  async function* lines() {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of child.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        yield buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    }
  }
  return {
    lines: lines(),
    write: (line) => {
      child.stdin.write(line);
      child.stdin.flush();
    },
    // As the voice helper's: a wrapper may not pass signals on, so the
    // player ends at the end of its input, and is signalled only if late.
    close: () => {
      try {
        child.stdin.end();
      } catch {
        // Already closed.
      }
      const late = setTimeout(() => child.kill(), WRAPPED_EXIT_MS);
      void child.exited.then(() => clearTimeout(late));
    },
    exited: child.exited,
  };
}
