import { type PointerEvent, type RefObject, useState } from "react";
import type { ReviewRegion } from "../../../shared/review";
import { regionOf } from "../renderedSource";

/** The graphic a pointer is on: a diagram's picture, an SVG, an image. */
export function graphicAt(
  target: EventTarget | null,
  root: HTMLElement,
): Element | null {
  if (!(target instanceof Element) || !root.contains(target)) return null;
  // A diagram's picture, not the icons of its toolbar.
  if (target.closest(".diagram-block-bar")) return null;
  const canvas = target.closest(".diagram-block-canvas");
  const drawn = canvas?.querySelector("svg, img");
  if (drawn instanceof HTMLImageElement) return drawn;
  const svg = drawn ?? target.closest("svg");
  if (svg && root.contains(svg)) {
    let outer: Element = svg;
    while (outer.parentElement?.closest("svg"))
      outer = outer.parentElement.closest("svg")!;
    return outer;
  }
  const image = target.closest("img, canvas");
  return image && root.contains(image) ? image : null;
}

/**
 * Dragging on a graphic of the preview: a click for a point, a drag for a
 * box, in point mode or with Alt. Nothing else of the preview changes.
 */
export function useGraphicPointing(
  rootRef: RefObject<HTMLElement | null>,
  pointMode: boolean,
  onPoint: (
    graphic: Element,
    region: ReviewRegion,
    under: Element | null,
  ) => void,
) {
  const [drag, setDrag] = useState<{
    graphic: Element;
    from: { x: number; y: number };
    to: { x: number; y: number };
  } | null>(null);
  const handlers = {
    onPointerDownCapture: (event: PointerEvent) => {
      if (!(pointMode || event.altKey) || event.button !== 0) return;
      const root = rootRef.current;
      const graphic = root ? graphicAt(event.target, root) : null;
      if (!graphic) return;
      event.preventDefault();
      event.stopPropagation();
      const at = { x: event.clientX, y: event.clientY };
      setDrag({ graphic, from: at, to: at });
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    },
    onPointerMoveCapture: (event: PointerEvent) => {
      if (!drag) return;
      setDrag({ ...drag, to: { x: event.clientX, y: event.clientY } });
    },
    onPointerUpCapture: (event: PointerEvent) => {
      if (!drag) return;
      event.stopPropagation();
      const to = { x: event.clientX, y: event.clientY };
      const region = regionOf(
        drag.from,
        to,
        drag.graphic.getBoundingClientRect(),
      );
      const under = document.elementFromPoint(drag.from.x, drag.from.y);
      const { graphic } = drag;
      setDrag(null);
      if (region) onPoint(graphic, region, under);
    },
    // Pointing at a diagram does not open it full size.
    onClickCapture: (event: React.MouseEvent) => {
      if (pointMode || event.altKey) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
  const box = drag ? (
    <div
      className="file-preview-pointing-box"
      style={{
        left: Math.min(drag.from.x, drag.to.x),
        top: Math.min(drag.from.y, drag.to.y),
        width: Math.abs(drag.to.x - drag.from.x),
        height: Math.abs(drag.to.y - drag.from.y),
      }}
    />
  ) : null;
  return { handlers, box };
}
