import type { MarketplaceCategory } from "../../lib/types";

/** CSS variable names for each category's accent / soft background
 * (src/styles/marketplace.css), mirroring `KIND_ACCENT_VAR` on the
 * Kubernetes page. Used for card left-borders, icon tiles and badges. */
export const CATEGORY_ACCENT_VAR: Record<MarketplaceCategory, string> = {
  search: "--market-search",
  database: "--market-database",
  messaging: "--market-messaging",
  monitoring: "--market-monitoring",
  storage: "--market-storage",
  auth: "--market-auth",
  devtools: "--market-devtools",
  ai: "--market-ai",
};

export const CATEGORY_ACCENT_SOFT_VAR: Record<MarketplaceCategory, string> = {
  search: "--market-search-soft",
  database: "--market-database-soft",
  messaging: "--market-messaging-soft",
  monitoring: "--market-monitoring-soft",
  storage: "--market-storage-soft",
  auth: "--market-auth-soft",
  devtools: "--market-devtools-soft",
  ai: "--market-ai-soft",
};

/** Raw hex for each category accent, one entry per resolved theme, mirroring
 * the literal values in `src/styles/marketplace.css`'s `:root` (light) and
 * `[data-theme="dark"]` blocks. CSS custom properties can't be read
 * synchronously without a DOM round-trip, and `CatalogIcon` needs the
 * actual hex to run the WCAG contrast check in `resolveIconTile` — so the
 * two are kept in sync here rather than reading `getComputedStyle`. */
export const CATEGORY_ACCENT_HEX: Record<"light" | "dark", Record<MarketplaceCategory, string>> = {
  light: {
    search: "#0f8fa8",
    database: "#3f6fd6",
    messaging: "#b3671f",
    monitoring: "#c33d74",
    storage: "#4b7a63",
    auth: "#5b63b7",
    devtools: "#1f9d73",
    ai: "#8b2fc9",
  },
  dark: {
    search: "#22b8cf",
    database: "#6f9bef",
    messaging: "#d99a4e",
    monitoring: "#e1548c",
    storage: "#6fb894",
    auth: "#8a97cf",
    devtools: "#2fb786",
    ai: "#b57bf0",
  },
};
