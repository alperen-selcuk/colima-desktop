import type { CatalogItem } from "../../lib/types";
import { CATEGORY_LABEL } from "../../lib/marketplace";
import { CatalogIcon } from "./CatalogIcon";
import { CATEGORY_ACCENT_VAR, CATEGORY_ACCENT_SOFT_VAR } from "./categoryAccent";

interface CatalogCardProps {
  item: CatalogItem;
  installed: boolean;
  selected: boolean;
  onClick: () => void;
}

/** One Browse-tab card (§6.8): icon, name, description, category + arch/
 * memory badges, "Installed" badge. The category accent is the card's only
 * per-item color signal (icon tile tint + left border) — everything else
 * stays neutral surface/border tokens, matching the plan's "calm grid, not
 * a confetti of card colors" principle. */
export function CatalogCard({ item, installed, selected, onClick }: CatalogCardProps) {
  const accentVar = CATEGORY_ACCENT_VAR[item.category];
  const accentSoftVar = CATEGORY_ACCENT_SOFT_VAR[item.category];

  return (
    <button
      onClick={onClick}
      className="mkt-card"
      data-selected={selected}
      style={{
        ["--card-accent" as string]: `var(${accentVar})`,
        outline: selected ? `2px solid var(${accentVar})` : undefined,
        outlineOffset: selected ? -1 : undefined,
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <CatalogIcon icon={item.icon} category={item.category} size={44} />
        {installed && <span className="mkt-badge flex-shrink-0">Installed</span>}
      </div>

      <div>
        <div className="truncate text-[13px] font-semibold" style={{ color: "var(--text)" }}>
          {item.name}
        </div>
        <p className="mt-0.5 line-clamp-2 text-[11.5px]" style={{ color: "var(--text-dim)" }}>
          {item.description}
        </p>
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        <span
          className="mkt-category-badge"
          style={{ ["--badge-accent" as string]: `var(${accentVar})`, ["--badge-accent-soft" as string]: `var(${accentSoftVar})` }}
        >
          {CATEGORY_LABEL[item.category]}
        </span>
        <span className="mkt-badge-neutral">{item.architectures.join("/")}</span>
      </div>
    </button>
  );
}
