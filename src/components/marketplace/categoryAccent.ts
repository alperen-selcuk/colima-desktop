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
