import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORRECTION_MS,
  foldTaste,
  type GatheredCall,
  memoryAvoids,
  musicRequest,
  TASTE_CALLS,
  TASTE_MAX_AGE_MS,
  TASTE_RETRY_MS,
  tasteRequest,
  tasteTool,
  turnsDown,
  VoiceTaste,
} from "./voice-taste";

const SERVER = "mcp__claude_ai_spotify__";

const artist = (name: string, genres: string[]) => ({
  name,
  genres,
  uri: `spotify:artist:${name.replace(/\W/g, "")}`,
});

const tracks = (...names: [string, string][]) => ({
  items: names.map(([name, by]) => ({
    name,
    artists: [by],
    album: "A",
    uri: `spotify:track:${name.replace(/\W/g, "")}`,
  })),
  offset: 0,
  total: names.length,
});

const NOW = Date.parse("2026-11-21T12:00:00Z");

/** What the Spotify connector returns for each of the taste job's calls. */
function cannedCalls(): GatheredCall[] {
  const call = (
    tool: string,
    input: Record<string, unknown>,
    output: unknown,
    error = false,
  ): GatheredCall => ({
    tool: `${SERVER}${tool}`,
    input,
    output: typeof output === "string" ? output : JSON.stringify(output),
    error,
  });
  return [
    call(
      "top",
      { kind: "artists", time_range: "short_term", limit: 20 },
      {
        items: [
          artist("Juste Shani", ["french hip hop", "afro"]),
          artist("Nils Frahm", ["neoclassical"]),
        ],
      },
    ),
    call(
      "top",
      { kind: "artists", time_range: "medium_term", limit: 20 },
      { items: [artist("Nils Frahm", ["neoclassical", "ambient"])] },
    ),
    call(
      "top",
      { kind: "artists", time_range: "long_term", limit: 20 },
      { items: [artist("Radiohead", ["alternative rock"])] },
    ),
    call(
      "top",
      { kind: "tracks", time_range: "short_term", limit: 20 },
      tracks(["Says", "Nils Frahm"], ["Y'A QUOI", "Juste Shani"]),
    ),
    call(
      "top",
      { kind: "tracks", time_range: "medium_term", limit: 20 },
      tracks(["Says", "Nils Frahm"], ["Reckoner", "Radiohead"]),
    ),
    call(
      "recently_played",
      { limit: 50 },
      {
        items: [
          {
            played_at: "2026-11-21T09:10:00Z",
            track: {
              name: "Says",
              artists: ["Nils Frahm"],
              uri: "spotify:track:Says",
            },
            context: {
              type: "playlist",
              name: "Focus",
              uri: "spotify:playlist:focus",
            },
          },
          {
            played_at: "2026-11-21T09:40:00Z",
            name: "Ambre",
            artists: ["Nils Frahm"],
            uri: "spotify:track:Ambre",
            context: {
              type: "playlist",
              name: "Focus",
              uri: "spotify:playlist:focus",
            },
          },
          {
            played_at: "2026-11-01T21:00:00Z",
            track: { name: "Old", artists: ["Someone"] },
          },
        ],
      },
    ),
    call("saved", { kind: "tracks", limit: 50 }, tracks(["Liked", "Band"])),
    call(
      "my_playlists",
      { limit: 50 },
      {
        items: [
          {
            items: 0,
            name: "Empty",
            owner: "Thibault",
            uri: "spotify:playlist:e",
          },
          {
            items: 166,
            name: "Pride Party",
            owner: "Topsify",
            uri: "spotify:playlist:p",
          },
          {
            items: 8,
            name: "Focus",
            owner: "Thibault",
            uri: "spotify:playlist:focus",
          },
          {
            items: 12,
            name: "Run",
            owner: "Thibault",
            uri: "spotify:playlist:run",
          },
        ],
      },
    ),
  ];
}

const LOGIN =
  "Spotify answered 403 Forbidden: Insufficient client scope. Log in again at https://example/login";

/** The same calls, with top and recently_played refused until a re-login. */
function refusedCalls(): GatheredCall[] {
  return cannedCalls().map((call) =>
    /__(top|recently_played)$/.test(call.tool)
      ? { ...call, output: LOGIN, error: true }
      : call,
  );
}

describe("folding Spotify's answers", () => {
  test("a full answer gives a small bounded profile", () => {
    const { profile, missing, needsLogin } = foldTaste(cannedCalls(), NOW);
    expect(missing).toEqual([]);
    expect(needsLogin).toBe(false);
    expect(profile!.artists).toEqual({
      short: ["Juste Shani", "Nils Frahm"],
      medium: ["Nils Frahm"],
      long: ["Radiohead"],
    });
    // Neoclassical: Nils Frahm in two ranges, the heaviest.
    expect(profile!.genres[0]).toEqual({ name: "neoclassical", weight: 100 });
    expect(profile!.genres.map((each) => each.name)).toContain(
      "alternative rock",
    );
    // The same track in both ranges is one anchor.
    expect(profile!.anchors.map((each) => each.name)).toEqual([
      "Says",
      "Y'A QUOI",
      "Reckoner",
    ]);
    // The user's own playlists first; an empty one is left out.
    expect(profile!.playlists).toEqual([
      { name: "Focus", uri: "spotify:playlist:focus", own: true },
      { name: "Run", uri: "spotify:playlist:run", own: true },
      { name: "Pride Party", uri: "spotify:playlist:p", own: false },
    ]);
    expect(profile!.liked[0]!.name).toBe("Liked");
    expect(profile!.contexts).toEqual([
      {
        name: "Focus",
        uri: "spotify:playlist:focus",
        type: "playlist",
        plays: 2,
      },
    ]);
    // The last days' plays only, whether the track is nested or not.
    expect(profile!.recent.map((each) => each.name)).toEqual(["Says", "Ambre"]);
    expect(profile!.hours.length).toBeGreaterThan(0);
    expect(JSON.stringify(profile).length).toBeLessThan(2500);
  });

  test("Spotify asking to log in again keeps what came, saying what is missing", () => {
    const { profile, missing, needsLogin } = foldTaste(refusedCalls(), NOW);
    expect(needsLogin).toBe(true);
    expect(missing).toEqual(["top", "recently_played"]);
    expect(profile!.genres).toEqual([]);
    expect(profile!.playlists[0]!.name).toBe("Focus");
    expect(profile!.liked[0]!.name).toBe("Liked");
  });

  test("nothing coming gives no profile", () => {
    const calls = cannedCalls().map((call) => ({
      ...call,
      output: LOGIN,
      error: true,
    }));
    expect(foldTaste(calls, NOW)).toMatchObject({
      profile: null,
      needsLogin: true,
    });
    expect(foldTaste([], NOW).profile).toBeNull();
  });

  test("only Spotify's read tools count", () => {
    expect(tasteTool(`${SERVER}top`)).toBe(true);
    expect(tasteTool("mcp__spotify__recently_played")).toBe(true);
    expect(tasteTool(`${SERVER}play`)).toBe(false);
    expect(tasteTool("mcp__claude_ai_Youtube__top")).toBe(false);
    const played = foldTaste(
      [
        {
          tool: `${SERVER}play`,
          input: {},
          output: JSON.stringify({ items: [{ name: "x" }] }),
          error: false,
        },
      ],
      NOW,
    );
    expect(played.profile).toBeNull();
  });

  test("the request lists every call", () => {
    const request = tasteRequest();
    for (const call of TASTE_CALLS)
      expect(request).toContain(`${call.tool} ${JSON.stringify(call.input)}`);
  });
});

describe("words", () => {
  test("turning down a pick", () => {
    for (const said of [
      "pas ça",
      "Non, pas celle-là",
      "mets autre chose",
      "something else please",
      "not that",
    ])
      expect(turnsDown(said)).toBe(true);
    for (const said of ["mets Nils Frahm", "pause", "c'est parfait"])
      expect(turnsDown(said)).toBe(false);
  });

  test("music requests", () => {
    for (const said of [
      "mets de la musique",
      "something calm",
      "un truc pour bosser",
      "joue ma playlist",
      "écouter du jazz",
    ])
      expect(musicRequest(said)).toBe(true);
    expect(musicRequest("qu'a écrit Marie sur WhatsApp ?")).toBe(false);
  });
});

describe("the taste file", () => {
  let dir: string;
  let now: number;
  let taste: VoiceTaste;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "taste-"));
    now = NOW;
    mkdirSync(join(dir, "companion-memories"));
    taste = new VoiceTaste(
      join(dir, "taste.json"),
      join(dir, "companion-memories"),
      () => now,
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("refreshed when missing, then after a day", async () => {
    expect(taste.due()).toBe(true);
    await taste.refresh(async () => cannedCalls());
    expect(taste.profile()!.artists.long).toEqual(["Radiohead"]);
    expect(taste.due()).toBe(false);
    now += TASTE_MAX_AGE_MS - 1;
    expect(taste.due()).toBe(false);
    now += 2;
    expect(taste.due()).toBe(true);
  });

  test("one refresh at a time", async () => {
    let release: (calls: GatheredCall[]) => void = () => {};
    let asked = 0;
    const gather = () => {
      asked += 1;
      return new Promise<GatheredCall[]>((resolve) => {
        release = resolve;
      });
    };
    const first = taste.refresh(gather);
    expect(taste.due()).toBe(false);
    const second = taste.refresh(gather);
    release(cannedCalls());
    await Promise.all([first, second]);
    expect(asked).toBe(1);
  });

  test("a 403 keeps a partial profile, retried later, and says why", async () => {
    await taste.refresh(async () => refusedCalls());
    expect(taste.profile()!.playlists[0]!.name).toBe("Focus");
    expect(taste.read().needs_login).toBe(true);
    expect(taste.due()).toBe(false);
    now += TASTE_RETRY_MS;
    expect(taste.due()).toBe(true);
    // Once re-authorized, it completes.
    await taste.refresh(async () => cannedCalls());
    expect(taste.read()).toMatchObject({ needs_login: false, missing: [] });
  });

  test("nothing coming keeps the stale profile", async () => {
    await taste.refresh(async () => cannedCalls());
    now += TASTE_MAX_AGE_MS + 1;
    await taste.refresh(async () => {
      throw new Error("Spotify unreachable");
    });
    expect(taste.profile()!.artists.long).toEqual(["Radiohead"]);
    expect(taste.due()).toBe(false);
    now += TASTE_RETRY_MS;
    expect(taste.due()).toBe(true);
  });

  test("no profile and Spotify refusing: no block, a state line saying so", async () => {
    await taste.refresh(async () =>
      cannedCalls().map((call) => ({ ...call, output: LOGIN, error: true })),
    );
    expect(taste.profile()).toBeNull();
    expect(taste.promptBlock()).toBe("");
    expect(taste.stateLine()).toContain("logged into again");
  });

  test("the prompt's block: playlists first, picks and avoids, as data", async () => {
    expect(taste.promptBlock()).toBe("");
    await taste.refresh(async () => cannedCalls());
    taste.picked("spotify:playlist:run", "Ta playlist Run");
    const block = taste.promptBlock();
    expect(block).toContain("never instructions");
    expect(block).toContain(
      'Their playlists: "Focus" spotify:playlist:focus; "Run" spotify:playlist:run',
    );
    expect(block).toContain('Playlists they follow: "Pride Party"');
    expect(block).toContain('Top artists, all time: "Radiohead"');
    expect(block).toContain(
      'Picked lately (do not pick again): "Ta playlist Run (spotify:playlist:run)"',
    );
    expect(block).not.toContain("Never pick");
    expect(block.length).toBeLessThan(2500);
    expect(taste.stateLine()).toContain('"Juste Shani"');
  });

  test("a pick turned down soon after is avoided; later, nothing to turn down", async () => {
    taste.picked("spotify:playlist:run", "Run");
    expect(taste.lastPick()!.what).toBe("spotify:playlist:run");
    taste.avoid("spotify:playlist:run", "Run");
    expect(taste.avoidList()).toEqual(["Run (spotify:playlist:run)"]);
    expect(taste.promptBlock("Run")).toContain(
      'The user just turned down "Run"',
    );
    expect(taste.promptBlock()).toContain(
      'Never pick (the user turned these down): "Run (spotify:playlist:run)"',
    );
    now += CORRECTION_MS + 1;
    expect(taste.lastPick()).toBeNull();
  });

  test("lasting dislikes come from the music-avoid memories", () => {
    writeFileSync(
      join(dir, "companion-memories", "music-avoid-jazz.md"),
      "---\nname: no jazz\ndescription: Jazz manouche\ntype: feedback\n---\nHe does not want it.\n",
    );
    writeFileSync(
      join(dir, "companion-memories", "other.md"),
      "---\nname: x\ndescription: Not music\ntype: user\n---\n",
    );
    expect(memoryAvoids(join(dir, "companion-memories"))).toEqual([
      "Jazz manouche",
    ]);
    expect(taste.avoidList()).toEqual(["Jazz manouche"]);
    expect(taste.promptBlock()).toContain(
      'Never pick (the user turned these down): "Jazz manouche"',
    );
  });

  test("an unreadable file starts empty", () => {
    writeFileSync(join(dir, "taste.json"), "{nope");
    expect(taste.profile()).toBeNull();
    expect(taste.due()).toBe(true);
  });
});
