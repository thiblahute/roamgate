import { ZoomOut } from "lucide-react";
import { type Range, sameRange, zoomOut } from "../timelineZoom";
import "./TimelineZoom.css";

/**
 * A timeline's zoom controls: zoom out, the day's work hours (first to last
 * activity), the full day, and back to the automatic range. Says what is
 * shown, and how to zoom, when it is not.
 */
export function TimelineZoomBar({
  range,
  auto,
  bounds,
  work,
  minSpan,
  zoomed,
  label,
  onRange,
  onReset,
}: {
  /** What is shown. */
  range: Range;
  /** What is shown unzoomed. */
  auto: Range;
  bounds: Range;
  work: Range;
  minSpan: number;
  zoomed: boolean;
  label: (value: number) => string;
  onRange: (range: Range) => void;
  onReset: () => void;
}) {
  return (
    <div className="timeline-zoom" role="toolbar" aria-label="Zoom">
      <button
        type="button"
        className="timeline-zoom-button"
        title="Zoom out"
        aria-label="Zoom out"
        disabled={sameRange(range, bounds)}
        onClick={() => onRange(zoomOut(range, bounds, minSpan))}
      >
        <ZoomOut size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="timeline-zoom-button"
        aria-pressed={zoomed && sameRange(range, work)}
        onClick={() => onRange(work)}
      >
        Work hours
      </button>
      <button
        type="button"
        className="timeline-zoom-button"
        aria-pressed={zoomed && sameRange(range, bounds)}
        onClick={() => onRange(bounds)}
      >
        Full day
      </button>
      {zoomed ? (
        <>
          <button
            type="button"
            className="timeline-zoom-button"
            title={`Back to ${label(auto.start)} to ${label(auto.end)}`}
            onClick={onReset}
          >
            Reset
          </button>
          <span className="timeline-zoom-range">
            {label(range.start)} to {label(range.end)}
          </span>
        </>
      ) : (
        <span className="timeline-zoom-hint">
          Drag across the hours to zoom
        </span>
      )}
    </div>
  );
}
