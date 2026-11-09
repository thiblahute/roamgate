import type { RenderedFrameMessage } from "../../../shared/renderedPage";
import { isAnimatedSvg } from "../renderedSource";
import { RenderedFrame } from "./RenderedFrame";
import { Code2, Copy, Image as ImageIcon, Maximize2, X } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  createContext,
  useContext,
} from "react";
import { createPortal } from "react-dom";
import { copyTextWithFeedback } from "../copyText";
import {
  type DiagramTheme,
  type DrawnDiagram,
  drawDiagram,
  themedDrawing,
} from "../diagramRender";
import type { DiagramLanguage } from "../diagramSource";
import "./MermaidDiagram.css";
import "./DiagramBlock.css";

/**
 * A diagram written in a comment or a chat message (a ```mermaid or ```svg
 * block): drawn to the width of the message, readable (a wide one scrolls
 * across), opened full size by a click or a tap, its source a toggle away
 * and copied by a button. One that cannot be drawn shows its source under
 * a short note of why.
 */

const LABELS: Record<DiagramLanguage, string> = {
  mermaid: "Mermaid diagram",
  svg: "SVG image",
};

/** A page this narrow is a phone's: a diagram fits the message whole. */
const PHONE = "(max-width: 640px)";
/** Elsewhere it is not drawn smaller than this, but scrolls across. */
const MIN_SCALE = 0.8;
/** Nor, when that is enough, taller than this. */
const MAX_HEIGHT = 640;

/**
 * The scale a diagram is drawn at in a message `available` px wide: never
 * above its own size; on a phone, to the width; elsewhere to the width and
 * MAX_HEIGHT, but not below MIN_SCALE, so that it stays readable in a
 * narrow column (it then scrolls across, a click opens it full size).
 */
export function inlineDiagramScale(
  size: { width: number; height: number },
  available: number,
  phone = false,
): number {
  if (available <= 0 || size.width <= 0 || size.height <= 0) return 1;
  const toWidth = available / size.width;
  if (phone) return Math.min(1, toWidth);
  const fit = Math.min(toWidth, MAX_HEIGHT / size.height);
  return Math.min(1, Math.max(MIN_SCALE, fit));
}

/** Drawn diagrams by what they are drawn from: redrawn, one shows at once. */
const drawings = new Map<string, DrawnDiagram>();
const drawing = new Map<string, Promise<DrawnDiagram>>();

function remember(key: string, drawn: DrawnDiagram) {
  drawings.delete(key);
  drawings.set(key, drawn);
  if (drawings.size > 120) drawings.delete(drawings.keys().next().value!);
}

function documentTheme(): DiagramTheme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** The page's theme, following its switches. */
function useDocumentTheme(): DiagramTheme {
  const [theme, setTheme] = useState(documentTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(documentTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-black", "data-accent"],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

function DiagramPicture({
  drawn,
  label,
}: {
  drawn: Exclude<DrawnDiagram, { kind: "error" }>;
  label: string;
}) {
  return drawn.kind === "inline" ? (
    <span
      className="mermaid-svg"
      role="img"
      aria-label={label}
      // renderMermaidDiagram sanitizes its SVG (prepareMermaidSvg).
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized
      dangerouslySetInnerHTML={{ __html: drawn.svg }}
    />
  ) : (
    <img src={drawn.url} alt={label} draggable={false} />
  );
}

/**
 * Set by the Files preview: an animated diagram there is drawn in the
 * rendered-page sandbox, so it can be paused and cropped where commented.
 * Elsewhere (comments, chats) nothing changes.
 */
export const DiagramFrameContext = createContext<{
  connectionId: string;
  pointMode: boolean;
  /** The user asked for this file's scripts to run. */
  scripts: boolean;
  onMessage: (
    message: Exclude<
      RenderedFrameMessage,
      { type: "ready" | "size" | "stray" }
    >,
    box: DOMRect,
    frame: HTMLIFrameElement,
  ) => void;
} | null>(null);

export function DiagramBlock({
  lang,
  code,
}: {
  lang: DiagramLanguage;
  code: string;
}) {
  const label = LABELS[lang];
  const theme = useDocumentTheme();
  const rootRef = useRef<HTMLElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  // currentColor in an SVG image: the theme's text color, as computed.
  const [color, setColor] = useState("");
  useLayoutEffect(() => {
    if (lang === "svg" && rootRef.current)
      setColor(getComputedStyle(rootRef.current).color || "#000");
  }, [lang, theme]);
  const themed = themedDrawing(lang, code);
  const key = themed
    ? [lang, theme, color, code].join("\u0000")
    : `${lang}\u0000${code}`;
  const ready = lang !== "svg" || !!color;
  const [drawn, setDrawn] = useState<DrawnDiagram | null>(
    () => drawings.get(key) ?? null,
  );
  useEffect(() => {
    if (!ready) return;
    const known = drawings.get(key);
    if (known) {
      setDrawn(known);
      return;
    }
    let cancelled = false;
    let pending = drawing.get(key);
    if (!pending) {
      pending = drawDiagram(lang, code, theme, color).then((result) => {
        drawing.delete(key);
        remember(key, result);
        return result;
      });
      drawing.set(key, pending);
    }
    // The drawing shown stays until the new one is there: no flash.
    void pending.then((result) => {
      if (!cancelled) setDrawn(result);
    });
    return () => {
      cancelled = true;
    };
    // The key is what it is drawn from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready]);

  const [showSource, setShowSource] = useState(false);
  const [open, setOpen] = useState(false);
  const [available, setAvailable] = useState(0);
  const [phone, setPhone] = useState(false);
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const measure = () => {
      setAvailable(view.clientWidth);
      setPhone(!!window.matchMedia?.(PHONE).matches);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(view);
    return () => observer.disconnect();
  }, []);

  const failed = drawn?.kind === "error";
  const picture = drawn && drawn.kind !== "error" ? drawn : null;
  const scale = picture
    ? inlineDiagramScale(picture, available - 24, phone)
    : 1;
  const frames = useContext(DiagramFrameContext);
  const svgSource =
    lang === "svg" ? code : picture?.kind === "inline" ? picture.svg : null;
  const framed =
    frames &&
    picture &&
    svgSource &&
    (isAnimatedSvg(svgSource) || (frames.scripts && lang === "svg"))
      ? { frames, svg: svgSource }
      : null;
  return (
    <figure
      ref={rootRef}
      className={`diagram-block is-${lang}${picture?.kind === "image" && picture.paper ? " is-paper" : ""}`}
      data-diagram={lang}
    >
      <div className="diagram-block-bar">
        <span className="diagram-block-label">{label}</span>
        {failed ? null : (
          <button
            type="button"
            aria-pressed={showSource}
            onClick={() => setShowSource((shown) => !shown)}
            title={showSource ? "Show the diagram" : "Show the source"}
          >
            {showSource ? (
              <ImageIcon size={13} aria-hidden="true" />
            ) : (
              <Code2 size={13} aria-hidden="true" />
            )}
            {showSource ? "Diagram" : "Source"}
          </button>
        )}
        <button
          type="button"
          onClick={() => void copyTextWithFeedback(code)}
          title="Copy the source"
        >
          <Copy size={13} aria-hidden="true" />
          Copy
        </button>
        {picture ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open full size"
            title="Open full size"
          >
            <Maximize2 size={13} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {failed ? (
        <div className="diagram-block-error" role="note">
          {lang === "svg"
            ? "Could not draw this SVG"
            : "Could not draw this diagram"}
          : {drawn.error}
        </div>
      ) : null}
      <div ref={viewRef} className="diagram-block-view">
        {showSource || failed ? (
          <pre className="diagram-block-source">
            <code>{code}</code>
          </pre>
        ) : picture && framed ? (
          <div
            className="diagram-block-canvas"
            style={{
              width: picture.width * scale,
              height: picture.height * scale,
            }}
          >
            <RenderedFrame
              connectionId={framed.frames.connectionId}
              svg={framed.svg}
              color={lang === "svg" ? color : undefined}
              name={label}
              pointMode={framed.frames.pointMode}
              scripts={framed.frames.scripts}
              onMessage={framed.frames.onMessage}
              className="diagram-block-frame"
            />
          </div>
        ) : picture ? (
          <button
            type="button"
            className="diagram-block-canvas"
            style={{
              width: picture.width * scale,
              height: picture.height * scale,
            }}
            onClick={() => setOpen(true)}
            aria-label={`${label}, open full size`}
            title="Open full size"
          >
            <DiagramPicture drawn={picture} label={label} />
          </button>
        ) : (
          <div className="diagram-block-pending" role="status">
            Drawing the diagram
          </div>
        )}
      </div>
      {open && picture ? (
        <DiagramLightbox
          drawn={picture}
          label={label}
          paper={picture.kind === "image" && picture.paper}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </figure>
  );
}

/**
 * A diagram over the whole app, fitted to the window: a click or a tap on
 * it shows it at its own size (it scrolls), again fits it; Esc, the
 * backdrop or the close button put it away and give the focus back.
 */
function DiagramLightbox({
  drawn,
  label,
  paper,
  onClose,
}: {
  drawn: Exclude<DrawnDiagram, { kind: "error" }>;
  label: string;
  paper: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [actualSize, setActualSize] = useState(false);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close?.();
      opener?.focus({ preventScroll: true });
    };
    // Once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const measure = () =>
      setStage({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const fit = stage.width
    ? Math.min(
        2,
        Math.max(0.05, (stage.width - 24) / drawn.width),
        Math.max(0.05, (stage.height - 24) / drawn.height),
      )
    : 1;
  const scale = actualSize ? 1 : fit;
  return createPortal(
    <dialog
      ref={dialogRef}
      className="modal-backdrop diagram-lightbox"
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        // The app's shortcuts stay out while the diagram is shown.
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      onClick={(event) => {
        // Not to the message it is drawn from (React passes portal clicks up).
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="diagram-lightbox-bar">
        <span className="diagram-lightbox-name">{label}</span>
        <button
          type="button"
          className="diagram-lightbox-button"
          aria-pressed={actualSize}
          onClick={() => setActualSize((actual) => !actual)}
          title={actualSize ? "Fit to the window" : "Actual size"}
        >
          {actualSize ? "Fit" : "100%"}
        </button>
        <button
          ref={closeRef}
          type="button"
          className="diagram-lightbox-button"
          onClick={onClose}
          aria-label="Close"
          title="Close (Esc)"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div
        ref={stageRef}
        className={`diagram-lightbox-stage${actualSize ? " is-actual" : ""}`}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: zoom is a pointer convenience; the 100% button does it by keyboard */}
        <div
          className={`diagram-lightbox-canvas${paper ? " is-paper" : ""}`}
          style={
            {
              width: drawn.width * scale,
              height: drawn.height * scale,
            } as CSSProperties
          }
          title={actualSize ? "Fit to the window" : "Actual size"}
          onClick={() => setActualSize((actual) => !actual)}
        >
          <DiagramPicture drawn={drawn} label={label} />
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
