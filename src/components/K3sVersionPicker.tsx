// k3s version picker (docs/SPEC.md §6.5): a combobox (free text allowed) with
// a dropdown grouped into Recommended / Latest per minor / All versions
// (search-filtered), used both by MachineConfigDialog's Kubernetes section
// and StartDialog's quick Kubernetes toggle. Keyboard accessible: Down/Up
// moves the highlighted option, Enter selects it, Esc closes the dropdown.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronDown, RefreshCw, Sparkles } from "lucide-react";
import * as api from "../lib/api";
import type { K3sVersion } from "../lib/types";
import { flattenForKeyboardNav, groupVersions, isUnknownVersion, isValidK3sVersionFormat, updatedAgoLabel } from "../lib/k3s";

interface K3sVersionPickerProps {
  value: string;
  onChange: (version: string) => void;
  /** Version of an already-running cluster (from `k8s_nodes`), if any — shows
   * the "changing requires Reset" warning when `value` differs from it. */
  runningVersion?: string | null;
  disabled?: boolean;
  placeholder?: string;
}

export function K3sVersionPicker({
  value,
  onChange,
  runningVersion,
  disabled,
  placeholder,
}: K3sVersionPickerProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const versionsQuery = useQuery({
    queryKey: ["k3sVersions"],
    queryFn: () => api.k3sVersions(false),
    staleTime: 60 * 60 * 1000, // 1h
  });

  const refresh = () => {
    api.k3sVersions(true).then((data) => {
      queryClient.setQueryData(["k3sVersions"], data);
    });
  };

  const data = versionsQuery.data;
  const grouped = useMemo(() => groupVersions(data?.versions ?? [], data?.colimaDefault ?? null), [data]);
  const flat = useMemo(() => flattenForKeyboardNav(grouped, query), [grouped, query]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  useEffect(() => {
    setHighlight(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const select = (version: string) => {
    onChange(version);
    setQuery("");
    setOpen(false);
    inputRef.current?.blur();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setHighlight((h) => Math.min(h + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && flat[highlight]) {
        select(flat[highlight].version.version);
      } else {
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  };

  const formatError = value.length > 0 && !isValidK3sVersionFormat(value);
  const unknownWarning = !formatError && isUnknownVersion(value, data?.versions ?? []);
  const versionChangeWarning =
    !!runningVersion && !!value && value !== runningVersion && isValidK3sVersionFormat(value);
  const agoLabel = updatedAgoLabel(data?.fetchedAt ?? null);

  return (
    <div ref={rootRef} className="relative flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          disabled={disabled}
          value={open ? query || value : value}
          placeholder={placeholder ?? "e.g. v1.31.2+k3s1"}
          onFocus={() => {
            setQuery("");
            setOpen(true);
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            onChange(e.target.value);
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          className="w-full flex-1 rounded border px-2.5 py-1.5 font-mono-app text-[12.5px] outline-none disabled:opacity-50"
          style={{
            background: "var(--surface-2)",
            borderColor: formatError ? "var(--danger)" : "var(--border)",
            color: "var(--text)",
          }}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          aria-label="Toggle version list"
          className="flex h-[30px] w-7 flex-shrink-0 items-center justify-center rounded border disabled:opacity-50"
          style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}
        >
          <ChevronDown size={13} />
        </button>
      </div>

      <div className="flex items-center gap-1.5 text-[10.5px]" style={{ color: "var(--text-faint)" }}>
        <span>
          {data?.source === "builtin" ? "showing built-in list" : data?.source === "cache" ? "from cache" : "from GitHub"}
          {agoLabel ? ` · ${agoLabel}` : ""}
        </span>
        {data?.error && (
          <span className="flex items-center gap-1" style={{ color: "var(--warn)" }}>
            <AlertTriangle size={10} /> offline
          </span>
        )}
        <button
          type="button"
          onClick={refresh}
          disabled={versionsQuery.isFetching}
          className="ml-auto flex items-center gap-1 disabled:opacity-50"
          style={{ color: "var(--accent)" }}
        >
          <RefreshCw size={10} className={versionsQuery.isFetching ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {formatError && (
        <span className="text-[11px]" style={{ color: "var(--danger)" }}>
          Not a valid k3s version format (expected vX.Y.Z+k3sN).
        </span>
      )}
      {unknownWarning && (
        <span className="text-[11px]" style={{ color: "var(--warn)" }}>
          This version isn't in the known release list, but looks well-formed.
        </span>
      )}
      {versionChangeWarning && (
        <span className="flex items-center gap-1 text-[11px]" style={{ color: "var(--warn)" }}>
          <AlertTriangle size={11} /> Changing the version of an existing cluster may require Kubernetes → Reset.
        </span>
      )}

      {open && (
        <div
          ref={listRef}
          role="listbox"
          className="absolute left-0 top-full z-30 mt-1 max-h-[320px] w-full min-w-[280px] overflow-y-auto rounded-md border py-1 shadow-lg"
          style={{ background: "var(--surface-1)", borderColor: "var(--border)" }}
        >
          {versionsQuery.isLoading && (
            <div className="px-3 py-2 text-[12px]" style={{ color: "var(--text-faint)" }}>
              Loading versions…
            </div>
          )}
          {!versionsQuery.isLoading && flat.length === 0 && (
            <div className="px-3 py-2 text-[12px]" style={{ color: "var(--text-faint)" }}>
              No matching versions.
            </div>
          )}
          <PickerSection label="Recommended" show={flat.some((f) => f.section === "recommended")} />
          {flat
            .filter((f) => f.section === "recommended")
            .map((f, i) => (
              <Option
                key={f.version.version}
                option={f}
                index={i}
                highlighted={highlight === i}
                selected={value === f.version.version}
                onSelect={select}
                onHover={setHighlight}
                badge="colima default"
              />
            ))}

          <PickerSection label="Latest per minor" show={flat.some((f) => f.section === "latestPerMinor")} />
          {flat
            .filter((f) => f.section === "latestPerMinor")
            .map((f) => {
              const index = flat.indexOf(f);
              return (
                <Option
                  key={f.version.version}
                  option={f}
                  index={index}
                  highlighted={highlight === index}
                  selected={value === f.version.version}
                  onSelect={select}
                  onHover={setHighlight}
                />
              );
            })}

          <PickerSection label="All versions" show={flat.some((f) => f.section === "all")} />
          {flat
            .filter((f) => f.section === "all")
            .map((f) => {
              const index = flat.indexOf(f);
              return (
                <Option
                  key={f.version.version}
                  option={f}
                  index={index}
                  highlighted={highlight === index}
                  selected={value === f.version.version}
                  onSelect={select}
                  onHover={setHighlight}
                />
              );
            })}
        </div>
      )}
    </div>
  );
}

function PickerSection({ label, show }: { label: string; show: boolean }) {
  if (!show) return null;
  return (
    <div
      className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide"
      style={{ color: "var(--text-faint)" }}
    >
      {label}
    </div>
  );
}

function Option({
  option,
  index,
  highlighted,
  selected,
  onSelect,
  onHover,
  badge,
}: {
  option: { version: K3sVersion };
  index: number;
  highlighted: boolean;
  selected: boolean;
  onSelect: (version: string) => void;
  onHover: (index: number) => void;
  badge?: string;
}) {
  const v = option.version;
  return (
    <button
      type="button"
      data-index={index}
      role="option"
      aria-selected={selected}
      onMouseEnter={() => onHover(index)}
      onClick={() => onSelect(v.version)}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px]"
      style={{ background: highlighted ? "var(--surface-2)" : "transparent", color: "var(--text)" }}
    >
      {selected ? <Check size={12} style={{ color: "var(--accent)" }} /> : <span className="w-3" />}
      <span className="font-mono-app">{v.version}</span>
      {badge && (
        <span
          className="ml-1 flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9.5px] font-medium"
          style={{ background: "var(--accent-soft)", color: "var(--accent-strong)" }}
        >
          <Sparkles size={9} /> {badge}
        </span>
      )}
      {v.publishedAt && (
        <span className="ml-auto text-[10.5px]" style={{ color: "var(--text-faint)" }}>
          {formatDate(v.publishedAt)}
        </span>
      )}
    </button>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
