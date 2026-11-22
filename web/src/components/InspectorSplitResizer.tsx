import {
  DEFAULT_INSPECTOR_NAVIGATION_RATIO,
  inspectorNavigationRatioAtPosition,
} from "../workspaceResource";
import { ResizeSeparator } from "./ResizeSeparator";
import "./InspectorSplitResizer.css";

/** The navigation's ratio with the pointer at clientX in the resource. */
function navigationRatioAt(
  clientX: number,
  separator: HTMLElement,
  horizontalPadding: number,
  detailMinSize: number | undefined,
) {
  const resource = separator.parentElement;
  if (!resource) return DEFAULT_INSPECTOR_NAVIGATION_RATIO;
  const bounds = resource.getBoundingClientRect();
  return inspectorNavigationRatioAtPosition(
    clientX - bounds.left - horizontalPadding / 2,
    bounds.width - horizontalPadding,
    detailMinSize,
  );
}

export function InspectorSplitResizer({
  ratio,
  horizontalPadding = 16,
  label = "Resize file navigation",
  detailMinSize,
  resetRatio = DEFAULT_INSPECTOR_NAVIGATION_RATIO,
  navigationId,
  detailId,
  onChange,
  onCommit,
}: {
  ratio: number;
  horizontalPadding?: number;
  label?: string;
  detailMinSize?: number;
  resetRatio?: number;
  navigationId: string;
  detailId: string;
  onChange: (ratio: number) => void;
  onCommit: (ratio: number) => void;
}) {
  return (
    <ResizeSeparator
      className="workspace-inspector-split-resizer"
      label={label}
      controls={`${navigationId} ${detailId}`}
      value={ratio}
      valueMin={15}
      valueMax={75}
      valueNow={Math.round(ratio * 100)}
      at={(clientX, separator) =>
        navigationRatioAt(clientX, separator, horizontalPadding, detailMinSize)
      }
      step={(key, current, separator) => {
        const resource = separator.parentElement;
        if (!resource) return current;
        const availableWidth =
          resource.getBoundingClientRect().width - horizontalPadding;
        const currentOffset = current * availableWidth;
        return inspectorNavigationRatioAtPosition(
          key === "Home"
            ? 0
            : key === "End"
              ? availableWidth
              : currentOffset + (key === "ArrowLeft" ? -16 : 16),
          availableWidth,
          detailMinSize,
        );
      }}
      onChange={onChange}
      onCommit={onCommit}
      onReset={() => {
        onChange(resetRatio);
        onCommit(resetRatio);
      }}
    />
  );
}
