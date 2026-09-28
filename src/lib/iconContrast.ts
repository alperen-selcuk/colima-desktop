// Pure helpers for keeping brand-icon glyphs legible on their tile in both
// themes. Many `simple-icons` brand colours are black or near-black (Ollama,
// Vault, Kafka, the Mailpit fallback glyph) — rendered at ~10% opacity on a
// dark card surface (`--surface-1`) that tint is nearly invisible. These
// helpers compute WCAG relative luminance / contrast ratio and pick a tile
// background that keeps the glyph at or above a 3:1 contrast ratio against
// its tile in both light and dark themes, without any hardcoded
// single-theme colours — callers pass in the actual resolved theme and the
// brand/category hex, everything else is derived.
//
// No React/DOM dependency, so this is trivially unit-testable; both
// `CatalogIcon` (Marketplace) and `ImageIcon` (Containers) render what this
// returns.

export type ResolvedThemeName = "light" | "dark";

/** Parses a `#rgb` or `#rrggbb` hex colour (leading `#` optional) into 0-255
 * channel values. Returns `null` for anything else so callers can fall back
 * safely instead of rendering garbage. */
export function parseHexColor(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    return { r, g, b };
  }
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return { r, g, b };
  }
  return null;
}

function channelToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance (0 = black, 1 = white) of a hex colour. Invalid
 * input is treated as mid-grey (0.5) so callers degrade gracefully rather
 * than throwing. */
export function relativeLuminance(hex: string): number {
  const rgb = parseHexColor(hex);
  if (!rgb) return 0.5;
  const r = channelToLinear(rgb.r);
  const g = channelToLinear(rgb.g);
  const b = channelToLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours, in the range [1, 21]. Order
 * of arguments doesn't matter. */
export function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexA);
  const lB = relativeLuminance(hexB);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Minimum contrast ratio required between a glyph and its tile background
 * (WCAG 1.4.11 "non-text contrast", the applicable guideline for icon-style
 * graphics rather than body text). */
export const MIN_ICON_CONTRAST = 3;

/** Neutral tile background per theme, used whenever a brand colour's own
 * tint can't reach `MIN_ICON_CONTRAST` against the glyph. Both are light
 * neutrals (close to `--surface-3`'s light-theme value, `#e8ede9`) so a
 * dark brand glyph (the common failure case — Ollama, Vault's ink, Kafka)
 * still stands out; a light theme falls back to this same light tile
 * because the glyph itself gets darkened instead (see `resolveIconTile`
 * step 3), never the tile. These intentionally do NOT come from
 * `--surface-*` directly (that's what the tile sits *on* in light theme, so
 * reusing it there would yield near-zero contrast against the card
 * background, not against the glyph — the tile needs to read as its own
 * chip against both card surfaces, which the visibility check above
 * confirms it does). */
const NEUTRAL_TILE_HEX: Record<ResolvedThemeName, string> = {
  light: "#e4e7ea",
  dark: "#e7e9ec",
};

/** The card/page surface a tile is rendered on top of (`--surface-1` in
 * `src/index.css`), needed to evaluate what a translucent brand tint
 * actually resolves to once composited — a `${hex}1a` (~10% alpha) tint is
 * visually dominated by whatever is underneath it, so its effective colour
 * depends on the theme's real surface, not on the neutral fallback tile. */
const CARD_SURFACE_HEX: Record<ResolvedThemeName, string> = {
  light: "#ffffff",
  dark: "#101613",
};

export interface IconTileStyle {
  /** Tile background (CSS colour string, e.g. a brand tint or a neutral). */
  background: string;
  /** Glyph fill colour (may be darkened/lightened from the input brand hex
   * to guarantee contrast against `background`). */
  glyphColor: string;
}

/** Nudges a colour's lightness toward black or white (in sRGB channel
 * space, close enough for this purpose) by `amount` (0-1), used only as a
 * last resort when even the neutral tile can't give a naturally light/dark
 * brand colour enough contrast on its own. */
function shade(hex: string, amount: number, towardWhite: boolean): string {
  const rgb = parseHexColor(hex);
  if (!rgb) return hex;
  const mix = (c: number) => Math.round(towardWhite ? c + (255 - c) * amount : c * (1 - amount));
  const toHex = (c: number) => c.toString(16).padStart(2, "0");
  return `#${toHex(mix(rgb.r))}${toHex(mix(rgb.g))}${toHex(mix(rgb.b))}`;
}

/**
 * Picks a tile background + glyph colour for a brand/category hex colour
 * that guarantees `MIN_ICON_CONTRAST` (3:1) between glyph and tile, in
 * whichever theme is currently resolved.
 *
 * Strategy, in order:
 * 1. Brand-tinted tile (the existing `${hex}1a` ~10% tint look) with the
 *    full-strength brand hex as the glyph, when that combination already
 *    clears the contrast bar (true for most saturated brand colours).
 * 2. A theme-appropriate neutral tile (light in dark mode, since most
 *    problem colours are too-dark brand marks; a slightly darker neutral in
 *    light mode for the rarer too-light brand mark) with the brand hex as
 *    the glyph, when the neutral tile clears the bar.
 * 3. As a last resort (a brand colour that's still too close to the neutral
 *    tile's lightness), shade the glyph itself further toward black/white
 *    until it clears the bar, keeping the neutral tile.
 */
export function resolveIconTile(brandHex: string, theme: ResolvedThemeName): IconTileStyle {
  const hex = brandHex.startsWith("#") ? brandHex : `#${brandHex}`;

  // 1) Brand tint tile, brand-hex glyph — the common case (colourful brand
  // marks like Redis red or Postgres blue already contrast fine). Evaluate
  // contrast against what the ~10% alpha tint actually composites to over
  // this theme's real card surface, not against the flat brand hex.
  const tintBackground = `${hex}1a`;
  const cardSurface = CARD_SURFACE_HEX[theme];
  const tintEffectiveBg = mixHex(cardSurface, hex, 0.1);
  if (contrastRatio(hex, tintEffectiveBg) >= MIN_ICON_CONTRAST) {
    return { background: tintBackground, glyphColor: hex };
  }

  // 2) Neutral tile, brand-hex glyph.
  const neutral = NEUTRAL_TILE_HEX[theme];
  if (contrastRatio(hex, neutral) >= MIN_ICON_CONTRAST) {
    return { background: neutral, glyphColor: hex };
  }

  // 3) Neutral tile, shaded glyph. The neutral tiles are light, so darken
  // the glyph toward black regardless of theme until it clears the bar.
  let glyph = hex;
  for (let amount = 0.15; amount <= 0.9; amount += 0.15) {
    glyph = shade(hex, amount, false);
    if (contrastRatio(glyph, neutral) >= MIN_ICON_CONTRAST) break;
  }
  return { background: neutral, glyphColor: glyph };
}

/** Linearly mixes two hex colours by `ratio` (0 = all `a`, 1 = all `b`) in
 * sRGB channel space — good enough to approximate "brand colour at N%
 * alpha over a canvas colour" for the contrast pre-check above. */
function mixHex(hexA: string, hexB: string, ratio: number): string {
  const a = parseHexColor(hexA);
  const b = parseHexColor(hexB);
  if (!a || !b) return hexB;
  const mix = (x: number, y: number) => Math.round(x * (1 - ratio) + y * ratio);
  const toHex = (c: number) => c.toString(16).padStart(2, "0");
  return `#${toHex(mix(a.r, b.r))}${toHex(mix(a.g, b.g))}${toHex(mix(a.b, b.b))}`;
}
