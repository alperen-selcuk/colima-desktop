import { resolveCatalogIcon } from "../../lib/catalogIcons";
import { resolveIconTile } from "../../lib/iconContrast";
import { useTheme } from "../../lib/useTheme";
import type { MarketplaceCategory } from "../../lib/types";
import { CATEGORY_ACCENT_HEX } from "./categoryAccent";

/** Generic package/app glyph (inline SVG, matching the app's own stroke
 * style — see ImageIcon's GenericGlyph on the Containers page) used when a
 * catalog item's `icon` slug isn't a recognized simple-icons brand. Tinted
 * by the item's category accent so it's still visually grouped correctly. */
function GenericGlyph({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" role="presentation" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="1.3" stroke={color} strokeWidth="1.6" />
      <rect x="13" y="4" width="7" height="7" rx="1.3" stroke={color} strokeWidth="1.6" />
      <rect x="4" y="13" width="7" height="7" rx="1.3" stroke={color} strokeWidth="1.6" />
      <rect x="13" y="13" width="7" height="7" rx="1.3" stroke={color} strokeWidth="1.6" />
    </svg>
  );
}

interface CatalogIconProps {
  icon: string;
  category: MarketplaceCategory;
  size?: number;
}

/** Renders a catalog item's brand icon (§6.8): a recognized `icon` slug gets
 * its simple-icons mark at brand hex on a tinted tile; an unrecognized slug
 * (e.g. "mailpit", which has no simple-icons entry) gets a generic glyph
 * tinted by the item's category accent instead — same "known brand vs.
 * tinted fallback" pattern as `ImageIcon` on the Containers page, but keyed
 * by category rather than a name hash so the fallback still reads as "this
 * category" at a glance. Both paths run their brand/category hex through
 * `resolveIconTile` so the glyph stays at or above WCAG 3:1 contrast against
 * its own tile in whichever theme is active — several simple-icons brand
 * colours (Ollama, Vault, Kafka) are black/near-black and would otherwise
 * vanish on a dark card surface. */
export function CatalogIcon({ icon, category, size = 28 }: CatalogIconProps) {
  const { resolved: theme } = useTheme();
  const resolvedIcon = resolveCatalogIcon(icon);

  if (resolvedIcon) {
    const hex = `#${resolvedIcon.icon.hex}`;
    const tile = resolveIconTile(hex, theme);
    return (
      <span className="mkt-icon-tile" style={{ width: size, height: size, background: tile.background }} title={resolvedIcon.icon.title}>
        <svg width={size * 0.58} height={size * 0.58} viewBox="0 0 24 24" fill={tile.glyphColor} role="presentation" aria-hidden="true">
          <path d={resolvedIcon.icon.path} />
        </svg>
      </span>
    );
  }

  const categoryHex = CATEGORY_ACCENT_HEX[theme][category];
  const tile = resolveIconTile(categoryHex, theme);
  return (
    <span className="mkt-icon-tile" style={{ width: size, height: size, background: tile.background }} title={icon}>
      <GenericGlyph size={size * 0.5} color={tile.glyphColor} />
    </span>
  );
}
