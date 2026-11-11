import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  parseFrameMessage,
  type RenderedFrameMessage,
  type RenderedMode,
  type RenderedParentMessage,
  type RenderedRootMap,
  type RenderedStorageWrite,
  strayTarget,
} from "../../../shared/renderedPage";
import { createPortal } from "react-dom";
import { reviewCall } from "../review";

/*
 * An HTML page or a site's page in the Files preview, served from
 * /rendered/<token>/ in an opaque-origin sandbox. What its script says is
 * trusted only as far as parseFrameMessage checks it.
 */
export function RenderedFrame({
  connectionId,
  file,
  url,
  svg,
  color,
  name,
  pointMode,
  onMessage,
  onPage,
  scripts = false,
  autoHeight = false,
  frameRef: givenRef,
  className = "file-preview-html",
  bannerIn = null,
}: {
  connectionId: string;
  /** Absolute path on the host, or the site's URL. */
  file?: string;
  url?: string;
  /** An SVG drawn as a page of its own, static, in the same sandbox. */
  svg?: string;
  color?: string;
  name: string;
  /** The user asked for this page's scripts to run. */
  scripts?: boolean;
  /** The frame is as tall as its content (an HTML block of a document). */
  autoHeight?: boolean;
  pointMode: boolean;
  onMessage: (
    message: Exclude<
      RenderedFrameMessage,
      { type: "ready" | "size" | "stray" | "storage" }
    >,
    box: DOMRect,
    frame: HTMLIFrameElement,
  ) => void;
  /**
   * A page is shown in the frame: `url` under its token, `first` for the
   * first page of the frame's source (not a navigation of its own).
   */
  onPage?: (url: string, first: boolean) => void;
  frameRef?: RefObject<HTMLIFrameElement | null>;
  className?: string;
  /**
   * Where the banner goes instead of its own row above the page: the
   * preview's Review only bar, one line with its controls.
   */
  bannerIn?: HTMLElement | null;
}) {
  const ownRef = useRef<HTMLIFrameElement | null>(null);
  const frameRef = givenRef ?? ownRef;
  const [page, setPage] = useState<{
    src: string;
    mode: RenderedMode;
    site?: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [shown, setShown] = useState("");
  const [height, setHeight] = useState<number | null>(null);
  /** A page of this source was shown already: the next is a navigation. */
  const shownOnce = useRef(false);
  useEffect(() => {
    let cancelled = false;
    shownOnce.current = false;
    setPage(null);
    setError("");
    void reviewCall<{ src: string; mode: RenderedMode; site?: string }>(
      connectionId,
      "review.rendered.page",
      {
        ...(scripts ? { scripts: true } : {}),
        ...(svg !== undefined
          ? { svg, ...(color ? { color } : {}) }
          : file
            ? { file }
            : { target: { kind: "rendered", url } }),
      },
    ).then(
      (next) => {
        if (!cancelled) setPage(next);
      },
      (failure) => {
        if (!cancelled)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [connectionId, file, url, svg, color, scripts]);
  const toFrame = useCallback(
    (message: RenderedParentMessage) =>
      frameRef.current?.contentWindow?.postMessage(message, "*"),
    [frameRef],
  );
  useEffect(() => {
    toFrame({ roamgate: "rendered", type: "pointMode", on: pointMode });
  }, [pointMode, toFrame]);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const onPageRef = useRef(onPage);
  onPageRef.current = onPage;
  const pointRef = useRef(pointMode);
  pointRef.current = pointMode;
  // Where the page shown last sends its root-absolute URLs: a navigation
  // its script made off the token comes back here once (renderedStray).
  const rootRef = useRef<RenderedRootMap | null>(null);
  // The token of the page framed, which the page cannot name itself.
  const tokenRef = useRef<string | null>(null);
  tokenRef.current =
    page?.mode === "site"
      ? (/^\/rendered\/([0-9a-f]{32})\//.exec(page.src)?.[1] ?? null)
      : null;
  const connectionIdRef = useRef(connectionId);
  connectionIdRef.current = connectionId;
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const message = parseFrameMessage(event.data);
      if (!message) return;
      if (message.type === "size") {
        setHeight(message.height);
        return;
      }
      if (message.type === "storage") {
        // A listed site's page wrote to its localStorage: the server keeps
        // it, under the frame's token (its site is the token's).
        const token = tokenRef.current;
        if (token) {
          const write: RenderedStorageWrite =
            message.op === "clear"
              ? { op: "clear" }
              : message.op === "remove"
                ? { op: "remove", key: message.key }
                : { op: "set", key: message.key, value: message.value };
          void reviewCall(connectionIdRef.current, "review.rendered.storage", {
            token,
            write,
          }).catch(() => undefined);
        }
        return;
      }
      if (message.type === "stray") {
        const root = rootRef.current;
        rootRef.current = null;
        const target = root ? strayTarget(message.url, root) : null;
        if (target && root) {
          const next = new URL(target, window.location.href);
          if (
            next.origin === window.location.origin &&
            next.pathname.startsWith(root.to)
          )
            frame.contentWindow?.location.replace(next.href);
        }
        return;
      }
      if (message.type === "ready") {
        rootRef.current = message.root ?? null;
        setShown(message.url);
        const first = !shownOnce.current;
        shownOnce.current = true;
        onPageRef.current?.(message.url, first);
        toFrame({
          roamgate: "rendered",
          type: "pointMode",
          on: pointRef.current,
        });
      } else
        onMessageRef.current(message, frame.getBoundingClientRect(), frame);
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [frameRef, toFrame]);
  if (error) return <div className="file-preview-state is-error">{error}</div>;
  if (!page) return null;
  const frame = (
    <iframe
      ref={frameRef}
      key={page.src}
      className={className}
      style={autoHeight && height !== null ? { height } : undefined}
      data-inline-svg={svg !== undefined ? "1" : undefined}
      sandbox={
        page.mode === "site" ? "allow-scripts allow-forms" : "allow-scripts"
      }
      referrerPolicy="no-referrer"
      src={page.src}
      aria-label={`Page: ${name}`}
    />
  );
  if (svg !== undefined) return frame;
  const banner = `${
    page.mode === "site"
      ? `Scripts on${page.site ? `: ${page.site} is in Sites we work on` : " for this page"}. Sandboxed, without access to Roamgate.`
      : "Static preview: scripts are blocked."
  }${shown ? ` (${shown})` : ""}`;
  return (
    <>
      {bannerIn ? (
        createPortal(
          <span className="file-preview-zen-banner" title={banner}>
            {banner}
          </span>,
          bannerIn,
        )
      ) : (
        <div className="file-preview-banner">{banner}</div>
      )}
      {frame}
    </>
  );
}
