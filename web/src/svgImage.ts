/**
 * SVG written in a comment or a chat message, drawn as an image.
 *
 * The markup is never put in the page. It becomes a data: URL shown by an
 * <img>, and browsers draw an SVG image in their secure mode: its scripts
 * and event handlers never run, it loads nothing from outside (images,
 * fonts, style sheets, a tracker), its links cannot be followed and its
 * style sheet applies to it alone. That holds whatever the markup is, where
 * sanitizing it into the page would hang on the sanitizer catching every
 * trick and would still have to drop its <style> (global selectors) and any
 * url() in its CSS, which it does not read. A data: URL (not a blob: one)
 * also cannot be opened as a page of Roamgate's origin.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const MAX_SIDE = 20_000;

export type SvgImage =
  | {
      ok: true;
      url: string;
      width: number;
      height: number;
      /** Drawn in currentColor: it takes the theme's text color. */
      themed: boolean;
    }
  | { ok: false; error: string };

function length(value: string | null): number | null {
  const match = /^\s*(\d*\.?\d+(?:e[+-]?\d+)?)\s*(?:px)?\s*$/i.exec(
    value ?? "",
  );
  const number = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(number) && number > 0 ? number : null;
}

function viewBoxOf(value: string | null) {
  const parts = (value ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part)))
    return null;
  const [x, y, width, height] = parts as [number, number, number, number];
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/**
 * Inline SVG written for an HTML page may leave out its namespaces, which
 * an SVG document (an image) needs; HTML's &nbsp; is not an XML entity.
 */
function asXml(markup: string): string {
  const open = /<svg\b[^>]*>/i.exec(markup);
  if (!open) return markup;
  let tag = open[0];
  if (!/\sxmlns\s*=/.test(tag))
    tag = tag.replace(/^<svg/i, `<svg xmlns="${SVG_NS}"`);
  if (/\sxlink:/.test(markup) && !/\sxmlns:xlink\s*=/.test(tag))
    tag = tag.replace(/^<svg/i, `<svg xmlns:xlink="${XLINK_NS}"`);
  return (
    markup.slice(0, open.index) +
    tag +
    markup.slice(open.index + open[0].length)
  ).replace(/&nbsp;/g, "&#160;");
}

/**
 * The image of some SVG markup, sized as it asks (its width and height, else
 * its viewBox), or why it cannot be drawn. `color` is what currentColor
 * draws in: the theme's text color.
 */
export function svgImage(
  markup: string,
  options: { color?: string } = {},
): SvgImage {
  const document = new DOMParser().parseFromString(
    asXml(markup.trim()),
    "image/svg+xml",
  );
  const root = document.documentElement;
  const failure = document.getElementsByTagName("parsererror")[0];
  if (failure || root?.localName !== "svg" || root.namespaceURI !== SVG_NS) {
    const detail = failure?.textContent?.replace(/\s+/g, " ").trim();
    return {
      ok: false,
      error: detail ? `Invalid SVG: ${detail.slice(0, 200)}` : "Invalid SVG",
    };
  }
  const box = viewBoxOf(root.getAttribute("viewBox"));
  let width = length(root.getAttribute("width"));
  let height = length(root.getAttribute("height"));
  if (box) {
    if (!width && !height) {
      width = box.width;
      height = box.height;
    } else if (!width) width = (height! * box.width) / box.height;
    else if (!height) height = (width * box.height) / box.width;
  }
  width = Math.min(MAX_SIDE, width ?? 300);
  height = Math.min(MAX_SIDE, height ?? 150);
  // Scaled to fit, it needs a viewBox: without one it would be cut.
  if (!box) root.setAttribute("viewBox", `0 0 ${width} ${height}`);
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  const themed = /currentcolor/i.test(markup);
  if (themed && options.color && !root.hasAttribute("color"))
    root.setAttribute("color", options.color);
  const xml = new XMLSerializer().serializeToString(document);
  return {
    ok: true,
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`,
    width,
    height,
    themed,
  };
}
