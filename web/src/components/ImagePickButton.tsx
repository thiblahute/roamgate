import { ImagePlus } from "lucide-react";
import { useRef } from "react";

/**
 * Adds images from a file chooser (a phone offers its camera and gallery
 * there): for comment boxes, where a phone has no paste or drop of images.
 */
export function ImagePickButton({
  onPick,
  className,
}: {
  onPick: (files: File[]) => void;
  className?: string;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label="Add images"
        title="Add images (or paste or drop them in the text)"
        // The editor keeps the focus, and its cursor where they go.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => input.current?.click()}
      >
        <ImagePlus size={15} aria-hidden="true" />
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length) onPick(files);
        }}
      />
    </>
  );
}
