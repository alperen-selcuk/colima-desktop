import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, HardDrive, Trash2 } from "lucide-react";
import "../styles/volumes.css";
import * as api from "../lib/api";
import type { Volume } from "../lib/types";
import { formatSizeBytes, sortVolumes, totalReclaimableBytes, volumeSourceLabel, type VolumeSortKey } from "../lib/volumes";
import { relativeAge } from "../lib/format";
import { Table, Thead, Th, Td, Tr } from "../components/Table";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { QueryErrorBanner } from "../components/QueryErrorBanner";
import { useToast } from "../components/Toasts";
import { PruneVolumesDialog } from "../dialogs/PruneVolumesDialog";
import type { PruneScope } from "../lib/volumes";

export function VolumesPage({ profile }: { profile: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [confirmRemove, setConfirmRemove] = useState<Volume | null>(null);
  const [pruneOpen, setPruneOpen] = useState(false);
  const [sortKey, setSortKey] = useState<VolumeSortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const volumesQuery = useQuery({
    queryKey: ["volumes", profile],
    queryFn: () => api.listVolumes(profile),
    refetchInterval: 5000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["volumes", profile] });

  const handleRemove = async () => {
    if (!confirmRemove) return;
    try {
      await api.removeVolume(profile, confirmRemove.name);
      toast.success(`Removed ${confirmRemove.name}`);
      invalidate();
    } catch (e) {
      toast.error(`Failed to remove ${confirmRemove.name}`, String(e));
    }
  };

  const handlePrune = async (scope: PruneScope) => {
    try {
      const output = await api.prune(profile, scope === "all" ? "volumes-all" : "volumes");
      toast.success(scope === "all" ? "Pruned all unused volumes" : "Pruned unused anonymous volumes", output);
      invalidate();
    } catch (e) {
      toast.error("Failed to prune volumes", String(e));
    }
  };

  const volumes = volumesQuery.data ?? [];

  const sorted = useMemo(() => {
    const base = sortVolumes(volumes, sortKey);
    // sortVolumes already orders size desc / created newest-first / name
    // asc; "desc" direction flips whichever is currently the "natural" one.
    return sortDir === "asc" ? base : [...base].reverse();
  }, [volumes, sortKey, sortDir]);

  const toggleSort = (key: VolumeSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const unusedCount = volumes.filter((v) => !v.inUse).length;
  const totalBytes = volumes.reduce((sum, v) => sum + (v.sizeBytes ?? 0), 0);
  const reclaimableBytes = totalReclaimableBytes(volumes);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header: whale mark + stat tiles, matching the Containers page's chrome */}
      <div className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
        <div
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md"
          style={{ background: "var(--docker-blue-soft)" }}
        >
          <HardDrive size={15} style={{ color: "var(--docker-blue)" }} />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-[12.5px] font-medium" style={{ color: "var(--docker-blue)" }}>
            Volumes
          </span>
          <span className="font-mono-app text-[10.5px]" style={{ color: "var(--text-faint)" }}>
            {profile}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <StatTile value={volumes.length} label="Volumes" />
          <StatTile value={formatSizeBytes(totalBytes)} label="Total size" />
          <StatTile value={unusedCount} label="Unused" />
          <StatTile value={formatSizeBytes(reclaimableBytes)} label="Reclaimable" />
        </div>
      </div>

      <div className="flex items-center justify-between px-4 py-3">
        <h1 className="text-[14px] font-semibold" style={{ color: "var(--text)" }}>
          Volumes
        </h1>
        <Button variant="secondary" size="sm" onClick={() => setPruneOpen(true)}>
          Prune…
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {volumesQuery.isError ? (
          <QueryErrorBanner error={volumesQuery.error} onRetry={() => volumesQuery.refetch()} />
        ) : volumes.length === 0 ? (
          <EmptyState
            icon={HardDrive}
            title="No volumes"
            message={volumesQuery.isLoading ? undefined : "Volumes created by containers or Compose projects will show up here."}
          />
        ) : (
          <Table>
            <Thead>
              <Th>
                <SortHeader label="Name" sortKey="name" active={sortKey} dir={sortDir} onSort={toggleSort} />
              </Th>
              <Th>Source</Th>
              <Th>
                <SortHeader label="Size" sortKey="size" active={sortKey} dir={sortDir} onSort={toggleSort} />
              </Th>
              <Th>In use</Th>
              <Th>
                <SortHeader label="Created" sortKey="created" active={sortKey} dir={sortDir} onSort={toggleSort} />
              </Th>
              <Th style={{ width: 60 }} />
            </Thead>
            <tbody>
              {sorted.map((v) => {
                const source = volumeSourceLabel(v);
                const kind = v.composeProject ? "compose" : v.anonymous ? "anonymous" : "named";
                return (
                  <Tr key={v.name}>
                    <Td className="font-medium font-mono-app text-[12px]" title={v.name}>
                      <span className="block max-w-[280px] truncate">{v.name}</span>
                    </Td>
                    <Td>
                      <span className="vol-source-badge" data-kind={kind}>
                        {source}
                      </span>
                    </Td>
                    <Td style={{ color: "var(--text-dim)" }}>{v.size ?? "—"}</Td>
                    <Td>
                      <span className="vol-inuse-badge" data-unused={!v.inUse}>
                        {v.inUse ? `${v.containers} container${v.containers === 1 ? "" : "s"}` : "Unused"}
                      </span>
                    </Td>
                    <Td style={{ color: "var(--text-dim)" }} title={v.createdAt ?? undefined}>
                      {v.createdAt ? relativeAge(v.createdAt) : "—"}
                    </Td>
                    <Td>
                      <Button
                        variant="danger-outline"
                        size="sm"
                        onClick={() => setConfirmRemove(v)}
                        disabled={v.inUse}
                        title={v.inUse ? "In use by a container — stop/remove it first" : "Delete"}
                      >
                        <Trash2 size={13} style={{ color: v.inUse ? "var(--text-faint)" : "var(--danger)" }} />
                      </Button>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </div>

      <ConfirmDialog
        open={!!confirmRemove}
        onClose={() => setConfirmRemove(null)}
        onConfirm={handleRemove}
        title={`Delete ${confirmRemove?.name ?? ""}`}
        message={
          confirmRemove?.inUse
            ? `${confirmRemove.name} is in use by ${confirmRemove.containers} container${confirmRemove.containers === 1 ? "" : "s"} and can't be deleted until they're stopped or removed.`
            : "This permanently deletes the volume and all data stored in it."
        }
        confirmLabel="Delete"
      />

      <PruneVolumesDialog open={pruneOpen} volumes={volumes} onClose={() => setPruneOpen(false)} onConfirm={handlePrune} />
    </div>
  );
}

function StatTile({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="vol-stat-tile">
      <span className="vol-stat-tile-value">{value}</span>
      <span className="vol-stat-tile-label">{label}</span>
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  active,
  dir,
  onSort,
}: {
  label: string;
  sortKey: VolumeSortKey;
  active: VolumeSortKey;
  dir: "asc" | "desc";
  onSort: (key: VolumeSortKey) => void;
}) {
  const isActive = active === sortKey;
  return (
    <button className="vol-sort-btn" onClick={() => onSort(sortKey)}>
      {label}
      {isActive && (dir === "asc" ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
    </button>
  );
}
