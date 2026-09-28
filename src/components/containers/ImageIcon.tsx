import { fallbackTileHex, resolveImageIcon } from "../../lib/imageIcon";
import { resolveIconTile } from "../../lib/iconContrast";
import { useTheme } from "../../lib/useTheme";

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
 * its `simple-icons` mark at brand hex on a tinted tile; an unrecognized
 * image gets a generic glyph tinted by a stable hash of its name, from ~8
 * harmonious tokens. Both paths run their hex through `resolveIconTile` so
 * the glyph stays at or above WCAG 3:1 contrast against its own tile in
 * whichever theme is active — several simple-icons brand colours are
 * black/near-black and would otherwise vanish on a dark card surface. */
export function ImageIcon({ image, size = 24 }: ImageIconProps) {
  const { resolved: theme } = useTheme();
  const resolved = resolveImageIcon(image);

  if (resolved) {
    const hex = `#${resolved.icon.hex}`;
    const tile = resolveIconTile(hex, theme);
    return (
      <span
        className="ctr-icon-tile"
        style={{ width: size, height: size, background: tile.background }}
        title={resolved.icon.title}
      >
        <svg
          width={size * 0.6}
          height={size * 0.6}
          viewBox="0 0 24 24"
          fill={tile.glyphColor}
          role="presentation"
          aria-hidden="true"
        >
          <path d={resolved.icon.path} />
        </svg>
      </span>
    );
  }

  const fallbackHex = fallbackTileHex(image, theme);
  const tile = resolveIconTile(fallbackHex, theme);
  return (
    <span
      className="ctr-icon-tile"
      style={{ width: size, height: size, background: tile.background }}
      title={image}
    >
      <GenericGlyph size={size * 0.6} color={tile.glyphColor} />
    </span>
  );
}
