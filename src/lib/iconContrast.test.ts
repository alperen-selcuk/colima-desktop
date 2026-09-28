import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  MIN_ICON_CONTRAST,
  parseHexColor,
  relativeLuminance,
  resolveIconTile,
} from "./iconContrast";

describe("parseHexColor", () => {
  it("parses a 6-digit hex with a leading #", () => {
    expect(parseHexColor("#DC382D")).toEqual({ r: 0xdc, g: 0x38, b: 0x2d });
  });

  it("parses a 6-digit hex without a leading #", () => {
    expect(parseHexColor("4169E1")).toEqual({ r: 0x41, g: 0x69, b: 0xe1 });
  });

  it("parses a 3-digit shorthand hex by doubling each channel", () => {
    expect(parseHexColor("#0f0")).toEqual({ r: 0, g: 255, b: 0 });
  });

  it("returns null for invalid input", () => {
    expect(parseHexColor("not-a-color")).toBeNull();
    expect(parseHexColor("#12345")).toBeNull();
  });
});

describe("relativeLuminance", () => {
  it("is 0 for black", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
  });

  it("is 1 for white", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
  });

  it("falls back to mid-grey luminance for invalid input", () => {
    expect(relativeLuminance("nonsense")).toBe(0.5);
  });
});

describe("contrastRatio", () => {
  it("is 21:1 for black against white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
  });

  it("is 1:1 for a colour against itself", () => {
    expect(contrastRatio("#4169e1", "#4169e1")).toBeCloseTo(1, 5);
  });

  it("is symmetric regardless of argument order", () => {
    const a = contrastRatio("#123456", "#abcdef");
    const b = contrastRatio("#abcdef", "#123456");
    expect(a).toBeCloseTo(b, 10);
  });
});

describe("resolveIconTile", () => {
  it("keeps the brand tint tile for a saturated colour that already contrasts well (Redis red)", () => {
    const tile = resolveIconTile("DC382D", "light");
    expect(tile.background).toBe("#DC382D1a");
    expect(tile.glyphColor).toBe("#DC382D");
  });

  it("falls back to a neutral tile for a near-black brand colour in dark theme (Ollama)", () => {
    const tile = resolveIconTile("000000", "dark");
    // Black-on-black-tint would be invisible; the tile must not be the
    // ~10% brand tint, and glyph-vs-tile contrast must clear the bar.
    expect(tile.background).not.toContain("000000");
    expect(contrastRatio(tile.glyphColor, tile.background)).toBeGreaterThanOrEqual(MIN_ICON_CONTRAST);
  });

  it("falls back to a neutral tile for a near-black brand colour in light theme (Kafka)", () => {
    const tile = resolveIconTile("231F20", "light");
    expect(contrastRatio(tile.glyphColor, tile.background)).toBeGreaterThanOrEqual(MIN_ICON_CONTRAST);
  });

  it("darkens an overly light brand colour so the glyph stays visible on the light neutral tile (Vault)", () => {
    const tile = resolveIconTile("FFEC6E", "light");
    expect(tile.glyphColor.toLowerCase()).not.toBe("#ffec6e");
    expect(contrastRatio(tile.glyphColor, tile.background)).toBeGreaterThanOrEqual(MIN_ICON_CONTRAST);
  });

  it("keeps a light brand colour at full strength in dark theme, where its tint over the dark card surface already contrasts well (Vault)", () => {
    const tile = resolveIconTile("FFEC6E", "dark");
    // Unlike light theme (glyph sits on a light neutral tile and must be
    // darkened), in dark theme the ~10% tint over the near-black card
    // surface lands dark enough that the untouched brand glyph already
    // clears the bar — verified against the real composited background in
    // the sweep test below.
    expect(tile.glyphColor).toBe("#FFEC6E");
    expect(tile.background).toBe("#FFEC6E1a");
  });

  it("guarantees at least MIN_ICON_CONTRAST for every colour across a representative sweep, in both themes", () => {
    // `tile.background` is either an opaque neutral hex, or a `${hex}1a`
    // (~10%-alpha) brand tint whose *visible* colour depends on the real
    // card surface (`--surface-1`) underneath it — composite it the same
    // way a browser would before checking contrast, mirroring the surfaces
    // `resolveIconTile` itself validated the tint path against.
    const cardSurface: Record<"light" | "dark", string> = { light: "#ffffff", dark: "#101613" };
    const effectiveBackground = (background: string, theme: "light" | "dark"): string => {
      if (background.length <= 7) return background; // already opaque
      const brandHex = background.slice(0, 7);
      const surface = parseHexColor(cardSurface[theme])!;
      const brand = parseHexColor(brandHex)!;
      const mix = (s: number, c: number) => Math.round(s * 0.9 + c * 0.1);
      const toHex = (c: number) => c.toString(16).padStart(2, "0");
      return `#${toHex(mix(surface.r, brand.r))}${toHex(mix(surface.g, brand.g))}${toHex(mix(surface.b, brand.b))}`;
    };

    const samples = [
      "000000", // Ollama
      "231F20", // Kafka
      "FFEC6E", // Vault
      "DC382D", // Redis
      "4169E1", // PostgreSQL
      "ffffff", // pathological: pure white
      "808080", // mid-grey
      "1f9d73", // Marketplace devtools category accent
      "7c3aed", // Marketplace purple chrome accent
    ];
    for (const hex of samples) {
      for (const theme of ["light", "dark"] as const) {
        const tile = resolveIconTile(hex, theme);
        const bg = effectiveBackground(tile.background, theme);
        const ratio = contrastRatio(tile.glyphColor, bg);
        expect(ratio).toBeGreaterThanOrEqual(MIN_ICON_CONTRAST - 1e-9);
      }
    }
  });

  it("accepts a hex without a leading #", () => {
    const withHash = resolveIconTile("#4169E1", "light");
    const withoutHash = resolveIconTile("4169E1", "light");
    expect(withoutHash).toEqual(withHash);
  });
});
