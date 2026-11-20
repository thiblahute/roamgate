import { serverLogger } from "../utils/logger";
import type { VoiceConfig } from "./voice-helper";

/**
 * YouTube as a source of a call's music, beside Spotify: yt-dlp finds the
 * video (a search or a link) and its audio stream where Roamgate runs, and
 * the voice helper plays that stream's sound, never a picture, into the
 * call's mix as its music (voice/helper/src/call/youtube.rs, its
 * `call_youtube` op): at the music's level, ducked as the background is.
 * One GStreamer, in the helper's process: the video plays only while a
 * call does, and ends with it.
 *
 * Spotify and YouTube never play together, and the helper keeps it so
 * where it runs, with the sound server's and the session bus's view of the
 * desktop: a video starting or resuming pauses the Spotify app (its MPRIS
 * player) only when the call's background carries its sound, and stops
 * when that sound comes back. With Spotify Connect, the app also says
 * Playing when the account plays on another device (someone else's
 * phone), and pausing it then would pause that device: silence in the
 * background leaves it. The companion's tools stop the video, too, when
 * they start Spotify on the call's music device (voice-tools.ts).
 *
 * A helper from before call_youtube answers it as an unknown op: YouTube
 * then says it needs the new helper, so this side can be deployed first.
 */

const log = serverLogger.child("voice-youtube");

/** The MPRIS bus name prefix of the Spotify app, paused by YouTube. */
export const SPOTIFY_MPRIS = "org.mpris.MediaPlayer2.spotify";
/** How long yt-dlp may take to find a video and its stream. */
const RESOLVE_MS = 45_000;
/** How long the helper may take to answer (a start waits for sound). */
const COMMAND_MS = 40_000;
/** What a helper without call_youtube makes of it. */
export const NEEDS_HELPER =
  "YouTube needs the new voice helper: the one installed cannot play it";
/** YouTube with no call up. */
export const NO_CALL =
  "YouTube plays only as a call's music, and no call is up";

/** A video found: what plays, and the stream the helper reads. */
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

/** What YouTube plays, as the companion's tools tell it. */
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
  /** The call's music was put off since: the video is not heard. */
  musicOff?: boolean;
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

/**
 * yt-dlp's arguments: one video's JSON, its best audio-only stream in
 * WebM with Opus, the only one the voice helper reads.
 */
export function ytDlpArgs(command: string[], target: string): string[] {
  return [
    ...command,
    "--dump-json",
    "--no-playlist",
    "--no-warnings",
    "--format",
    "bestaudio[acodec=opus]/bestaudio[ext=webm]",
    "--",
    target,
  ];
}

/** A video with no Opus audio (only AAC in M4A, which the helper cannot read). */
export const NO_OPUS =
  "this video has no Opus (WebM) audio, only formats the voice helper cannot play (AAC in M4A)";

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
  if (/requested format is not available/i.test(reason)) return NO_OPUS;
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
  if (video.acodec !== "opus" && video.ext !== "webm")
    throw new YoutubeError(NO_OPUS);
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

/**
 * The voice helper as YouTube uses it (VoiceHelper): call_youtube on the
 * call running, and its events.
 */
export type YoutubeHelper = {
  /** Whether a call runs: YouTube plays only in one. */
  inCall(): boolean;
  /**
   * A call_youtube request to the call running, its music put on first
   * with `musicOn`: the helper's answer, or its error.
   */
  callYoutube(
    command: Record<string, unknown>,
    musicOn?: boolean,
  ): Promise<Record<string, unknown>>;
  /** Listens to the helper's call_youtube events; answers how to stop. */
  onYoutube(listener: (event: Record<string, unknown>) => void): () => void;
};

/** The helper's answer to a call_youtube request. */
type HelperReply = {
  state?: YoutubeStatus["state"];
  position?: number | null;
  duration?: number | null;
  volume?: number;
  music_muted?: boolean;
  spotify_paused?: boolean;
};

/** Why the helper failed, as the tools tell it. */
export function helperFailure(message: string): string {
  if (/unknown op call_youtube/.test(message)) return NEEDS_HELPER;
  if (/^no call\b/.test(message)) return NO_CALL;
  return message;
}

/**
 * The YouTube player of the companion's tools, driving the helper's
 * call_youtube; each command waits for its answer.
 */
export class YoutubePlayer {
  private track: YoutubeTrack | null = null;
  private ended: string | undefined;
  private pausedSpotify = false;
  /** 0 to 1, kept for the next video. */
  private level = 1;

  constructor(
    private readonly helper: YoutubeHelper,
    private readonly resolve: (asked: string) => Promise<YoutubeTrack>,
    private readonly timeoutMs = COMMAND_MS,
    /** The MPRIS players a video pauses when they play here. */
    private readonly mpris = SPOTIFY_MPRIS,
  ) {
    helper.onYoutube((event) => this.event(event));
  }

  /**
   * Finds `asked` and plays it in the call, its music put on, pausing
   * Spotify when it plays here; what plays.
   */
  async play(asked: string): Promise<YoutubeStatus> {
    // A helper that cannot, or no call, is told before yt-dlp runs.
    await this.send({ action: "status" });
    const track = await this.resolve(asked);
    const reply = await this.send(
      {
        action: "play",
        url: track.stream,
        headers: track.headers,
        volume: this.level,
        pause_mpris: this.mpris,
      },
      true,
    );
    this.track = track;
    this.ended = undefined;
    this.pausedSpotify = reply.spotify_paused === true;
    return this.status(reply);
  }

  async pause(): Promise<YoutubeStatus> {
    return this.status(await this.send({ action: "pause" }));
  }

  /** Plays again what was paused, pausing Spotify when it plays here. */
  async resume(): Promise<YoutubeStatus> {
    const reply = await this.send(
      { action: "resume", pause_mpris: this.mpris },
      true,
    );
    this.pausedSpotify = reply.spotify_paused === true;
    return this.status(reply);
  }

  /** Stops the video; nothing to do without a call. */
  async stop(): Promise<YoutubeStatus> {
    if (!this.helper.inCall()) return this.gone();
    const reply = await this.send({ action: "stop" });
    this.track = null;
    return this.status(reply);
  }

  /** The video's own volume, 0 to 100 (the call sets the music's level). */
  async volume(percent: number): Promise<YoutubeStatus> {
    this.level = Math.min(100, Math.max(0, percent)) / 100;
    if (!this.helper.inCall()) return this.gone();
    return this.status(
      await this.send({ action: "volume", volume: this.level }),
    );
  }

  /** Goes to `position` seconds, or `by` seconds from where it is. */
  async seek(to: { position?: number; by?: number }): Promise<YoutubeStatus> {
    let position = to.position;
    if (position === undefined) {
      const now = await this.send({ action: "status" });
      position = (now.position ?? 0) + (to.by ?? 0);
    }
    return this.status(
      await this.send({ action: "seek", position: Math.max(0, position) }),
    );
  }

  /** What plays now. */
  async nowPlaying(): Promise<YoutubeStatus> {
    if (!this.helper.inCall()) return this.gone();
    return this.status(await this.send({ action: "status" }));
  }

  /** Spotify started: YouTube stops, so they never play together. */
  async spotifyStarted(): Promise<void> {
    if (!this.track || !this.helper.inCall()) return;
    await this.stop().catch(() => {});
    this.ended = "Spotify started playing";
  }

  /** The helper's call_youtube events: a video stopping by itself. */
  private event(event: Record<string, unknown>) {
    if (event.state === "playing") {
      log.info("youtube plays", { duration: event.duration });
      return;
    }
    if (event.state !== "stopped") return;
    this.ended =
      event.why === "ended"
        ? "the video ended"
        : event.why === "spotify"
          ? "Spotify started playing"
          : typeof event.reason === "string"
            ? event.reason
            : "it stopped";
    log.info("youtube stopped", { reason: this.ended });
    this.track = null;
  }

  /** No call: whatever played ended with it. */
  private gone(): YoutubeStatus {
    if (this.track) {
      this.track = null;
      this.ended = "the call ended";
    }
    return this.status({ state: "stopped" });
  }

  private status(reply: HelperReply): YoutubeStatus {
    const state = reply.state ?? "stopped";
    // The helper lost it (its call was made again after a restart).
    if (state === "stopped" && this.track) {
      this.track = null;
      this.ended ??= "the call's audio restarted";
    }
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
      ...(reply.music_muted === true && state !== "stopped"
        ? { musicOff: true }
        : {}),
    };
  }

  /** A call_youtube request; `musicOn`: the call's music put on first. */
  private async send(
    command: Record<string, unknown>,
    musicOn = false,
  ): Promise<HelperReply> {
    let late: ReturnType<typeof setTimeout> | undefined;
    try {
      return (await Promise.race([
        this.helper.callYoutube(command, musicOn),
        new Promise<never>((_, reject) => {
          late = setTimeout(
            () => reject(new Error("the voice helper did not answer")),
            this.timeoutMs,
          );
        }),
      ])) as HelperReply;
    } catch (error) {
      throw new YoutubeError(helperFailure((error as Error).message));
    } finally {
      clearTimeout(late);
    }
  }
}

/** voice.json's YouTube, or null when it is off. */
export type YoutubeConfig = {
  ytDlp: string[];
};

/**
 * Whether the companion has YouTube for a call's music, and how: with
 * call_background set, unless `youtube` is false. The keys of the player
 * YouTube had before the helper played it (youtube_sink,
 * youtube_player_wrapper) are ignored.
 */
export function youtubeConfig(config: VoiceConfig): YoutubeConfig | null {
  if (config.youtube === false || !config.call_background?.trim()) return null;
  return { ytDlp: config.yt_dlp?.length ? config.yt_dlp : ["yt-dlp"] };
}
