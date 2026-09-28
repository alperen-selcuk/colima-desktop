import { fallbackTileVar, resolveImageIcon } from "../../lib/imageIcon";

interface ImageIconProps {
  image: string;
  size?: number;
}

/** Generic container glyph (inline SVG, brand style — a simple rounded
 * "box" silhouette matching the app's stroke weight) used when the image
 * isn't one of the recognized brands. Tinted by `fallbackTileVar`. */
function GenericGlyph({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" role="presentation" aria-hidden="true">
      <path
        d="M12 3.5 4.5 7.75v8.5L12 20.5l7.5-4.25v-8.5L12 3.5Z"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M4.7 7.7 12 12l7.3-4.3M12 12v8.4" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

/** Renders a container/image's brand icon (§6.7): a well-known image gets
 * its `simple-icons` mark at brand hex on a subtle tinted tile (for
 * contrast in both themes); an unrecognized image gets a generic glyph
 * tinted by a stable hash of its name, from ~8 harmonious tokens. */
export function ImageIcon({ image, size = 24 }: ImageIconProps) {
  const resolved = resolveImageIcon(image);

  if (resolved) {
    const hex = `#${resolved.icon.hex}`;
    return (
      <span
        className="ctr-icon-tile"
        style={{ width: size, height: size, background: `${hex}1a` }}
        title={resolved.icon.title}
      >
        <svg
          width={size * 0.6}
          height={size * 0.6}
          viewBox="0 0 24 24"
          fill={hex}
          role="presentation"
          aria-hidden="true"
        >
          <path d={resolved.icon.path} />
        </svg>
      </span>
    );
  }

  const varName = fallbackTileVar(image);
  return (
    <span
      className="ctr-icon-tile"
      style={{ width: size, height: size, background: `var(${varName}-soft)` }}
      title={image}
    >
      <GenericGlyph size={size * 0.6} color={`var(${varName})`} />
    </span>
  );
}
