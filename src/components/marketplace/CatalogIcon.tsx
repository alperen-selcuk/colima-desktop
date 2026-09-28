import { resolveCatalogIcon } from "../../lib/catalogIcons";
import type { MarketplaceCategory } from "../../lib/types";
import { CATEGORY_ACCENT_VAR } from "./categoryAccent";

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
 * its simple-icons mark at brand hex on a subtle tinted tile; an
 * unrecognized slug (e.g. "mailpit", which has no simple-icons entry) gets
 * a generic glyph tinted by the item's category accent instead — same
 * "known brand vs. tinted fallback" pattern as `ImageIcon` on the
 * Containers page, but keyed by category rather than a name hash so the
 * fallback still reads as "this category" at a glance. */
export function CatalogIcon({ icon, category, size = 28 }: CatalogIconProps) {
  const resolved = resolveCatalogIcon(icon);

  if (resolved) {
    const hex = `#${resolved.icon.hex}`;
    return (
      <span className="mkt-icon-tile" style={{ width: size, height: size, background: `${hex}1a` }} title={resolved.icon.title}>
        <svg width={size * 0.58} height={size * 0.58} viewBox="0 0 24 24" fill={hex} role="presentation" aria-hidden="true">
          <path d={resolved.icon.path} />
        </svg>
      </span>
    );
  }

  const varName = CATEGORY_ACCENT_VAR[category];
  return (
    <span className="mkt-icon-tile" style={{ width: size, height: size, background: `var(${varName}-soft)` }} title={icon}>
      <GenericGlyph size={size * 0.5} color={`var(${varName})`} />
    </span>
  );
}
