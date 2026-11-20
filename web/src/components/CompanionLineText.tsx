import { messageImagePieces } from "../chatImages";
import { companionImages, companionImageUrl } from "../companionImages";

/**
 * A line of the companion's conversation: its words, without the paths of
 * the images the user gave, and every image it names shown small (one the
 * user gave, one the companion refers to or made); a click opens it.
 */
export function CompanionLineText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const images = companionImages(text);
  if (!images.length) return <p className={className}>{text}</p>;
  const words = messageImagePieces(text)
    .flatMap((piece) => ("text" in piece ? [piece.text] : []))
    .join(" ");
  return (
    <>
      {words ? <p className={className}>{words}</p> : null}
      <span className="companion-panel-images">
        {images.map((path) => (
          <a
            key={path}
            href={companionImageUrl(path)}
            target="_blank"
            rel="noreferrer"
            title={path}
          >
            <img
              src={companionImageUrl(path)}
              alt={path.split("/").pop() ?? path}
              loading="lazy"
            />
          </a>
        ))}
      </span>
    </>
  );
}
