import type { ReviewRegion } from "../../shared/review";
import { svgAsDrawn } from "../../shared/svgAsDrawn";

/*
 * What the user saw when they started a comment on a graphic: animations
 * paused at that moment, and a picture of the region, made in the browser
 * and saved with the review for the agent to read.
 */

export type HeldGraphic = {
  /** "2.4 s": where its animation was; none when it does not move. */
  moment?: string;
  /** Lets it move again. */
  resume: () => void;
};

function seconds(value: number): string {
  return `${Math.round(value * 10) / 10} s`;
}

/**
 * Pauses the animations of a graphic (SMIL and CSS animations of an SVG,
 * a video) and says where they were. Nothing moving: no moment.
 */
export function holdGraphic(element: Element): HeldGraphic {
  const resumes: Array<() => void> = [];
  let moment: string | undefined;
  const svg =
    element instanceof SVGSVGElement
      ? element
      : (element.querySelector?.("svg") ?? null);
  if (
    svg instanceof SVGSVGElement &&
    svg.querySelector("animate, animateTransform, animateMotion, set")
  ) {
    if (!svg.animationsPaused()) {
      svg.pauseAnimations();
      resumes.push(() => svg.unpauseAnimations());
    }
    moment = seconds(svg.getCurrentTime());
  }
  const animations =
    typeof (element as HTMLElement).getAnimations === "function"
      ? (element as HTMLElement).getAnimations({ subtree: true })
      : [];
  for (const animation of animations) {
    if (animation.playState !== "running") continue;
    animation.pause();
    resumes.push(() => animation.play());
    if (moment === undefined && typeof animation.currentTime === "number")
      moment = seconds(animation.currentTime / 1000);
  }
  const video =
    element instanceof HTMLVideoElement
      ? element
      : (element.querySelector?.("video") ?? null);
  if (video instanceof HTMLVideoElement && !video.paused) {
    video.pause();
    resumes.push(() => void video.play().catch(() => {}));
    moment ??= seconds(video.currentTime);
  }
  return {
    ...(moment !== undefined ? { moment } : {}),
    resume: () => {
      for (const resume of resumes.splice(0)) resume();
    },
  };
}

/** The first background behind an element that is not see-through. */
function backgroundBehind(element: Element): string {
  for (let at: Element | null = element; at; at = at.parentElement) {
    const color = getComputedStyle(at).backgroundColor;
    if (color && !/^(transparent|rgba\(.*,\s*0\))$/.test(color)) return color;
  }
  return "#fff";
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("cannot draw the graphic"));
    image.src = src;
  });
}

/** The most pixels a crop has on its longer side. */
const CROP_MAX = 1600;

/**
 * A PNG of a region of a graphic (an SVG, an image, a canvas) as it is
 * drawn now; a point gives the whole graphic. Null when the browser
 * refuses (a picture from elsewhere) or there is nothing to draw.
 */
export async function cropGraphic(
  element: Element,
  region: ReviewRegion,
): Promise<Blob | null> {
  try {
    const svg =
      element instanceof SVGSVGElement
        ? element
        : element.querySelector?.("svg");
    const box = (svg ?? element).getBoundingClientRect();
    if (!box.width || !box.height) return null;
    let source: CanvasImageSource;
    let width: number;
    let height: number;
    if (svg instanceof SVGSVGElement) {
      const markup = svgAsDrawn(svg);
      const url = URL.createObjectURL(
        new Blob([markup], { type: "image/svg+xml" }),
      );
      try {
        source = await loadImage(url);
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      width = box.width;
      height = box.height;
    } else if (element instanceof HTMLImageElement) {
      source = element;
      width = element.naturalWidth || box.width;
      height = element.naturalHeight || box.height;
    } else if (element instanceof HTMLCanvasElement) {
      source = element;
      width = element.width;
      height = element.height;
    } else return null;
    const whole = !region.w || !region.h;
    const sx = whole ? 0 : region.x * width;
    const sy = whole ? 0 : region.y * height;
    const sw = whole ? width : Math.max(1, region.w * width);
    const sh = whole ? height : Math.max(1, region.h * height);
    const scale = Math.min(
      CROP_MAX / Math.max(sw, sh),
      svg ? (window.devicePixelRatio || 1) * 2 : 1,
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    if (svg) {
      // Drawn on the page's background: what is behind it, as shown.
      context.fillStyle = backgroundBehind(svg);
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(
      source,
      sx,
      sy,
      sw,
      sh,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    return await new Promise((resolve) =>
      canvas.toBlob((blob) => resolve(blob), "image/png"),
    );
  } catch {
    return null;
  }
}

/** The element of a graphic under a point: its id, else its short text. */
export function elementLabel(
  target: Element | null,
  graphic: Element,
): string | undefined {
  for (
    let element: Element | null = target;
    element && element !== graphic.parentElement;
    element = element.parentElement
  ) {
    const id = element.getAttribute("id");
    // Generated ids (mermaid's) read badly; their text says more.
    if (id && !/^(mermaid|flowchart|svg)-|^[a-z]+-\d+$/i.test(id)) return id;
    const text = element.textContent?.replace(/\s+/g, " ").trim();
    if (text && text.length <= 80 && element !== graphic) return text;
    if (element === graphic) break;
  }
  return undefined;
}

/** A Blob as base64, for `review.image.add`. */
export async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}
