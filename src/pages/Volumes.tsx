import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive, Trash2 } from "lucide-react";
import * as api from "../lib/api";
import type { Volume } from "../lib/types";
import { Table, Thead, Th, Td, Tr } from "../components/Table";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/Toasts";

export function VolumesPage({ profile }: { profile: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [confirmRemove, setConfirmRemove] = useState<Volume | null>(null);
  const [confirmPrune, setConfirmPrune] = useState(false);

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

  const handlePrune = async () => {
    try {
      const output = await api.prune(profile, "volumes");
      toast.success("Pruned unused volumes", output);
      invalidate();
    } catch (e) {
      toast.error("Failed to prune volumes", String(e));
    }
  };

  const volumes = volumesQuery.data ?? [];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3">
        <h1 className="text-[14px] font-semibold" style={{ color: "var(--text)" }}>
          Volumes
        </h1>
        <Button variant="secondary" size="sm" onClick={() => setConfirmPrune(true)}>
          Prune unused
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {volumes.length === 0 ? (
          <EmptyState icon={HardDrive} title="No volumes" />
        ) : (
          <Table>
            <Thead>
              <Th>Name</Th>
              <Th>Driver</Th>
              <Th>Size</Th>
              <Th>Mountpoint</Th>
              <Th style={{ width: 60 }} />
            </Thead>
            <tbody>
              {volumes.map((v) => (
                <Tr key={v.name}>
                  <Td className="font-medium font-mono-app text-[12px]">{v.name}</Td>
                  <Td style={{ color: "var(--text-dim)" }}>{v.driver}</Td>
                  <Td style={{ color: "var(--text-dim)" }}>{v.size ?? "—"}</Td>
                  <Td className="font-mono-app text-[11px] truncate max-w-[320px]" style={{ color: "var(--text-faint)" }}>
                    {v.mountpoint}
                  </Td>
                  <Td>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(v)} title="Delete">
                      <Trash2 size={11} style={{ color: "var(--danger)" }} />
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>

      <ConfirmDialog
        open={!!confirmRemove}
        onClose={() => setConfirmRemove(null)}
        onConfirm={handleRemove}
        title={`Delete ${confirmRemove?.name ?? ""}`}
        message="This permanently deletes the volume and all data stored in it."
        confirmLabel="Delete"
      />

      <ConfirmDialog
        open={confirmPrune}
        onClose={() => setConfirmPrune(false)}
        onConfirm={handlePrune}
        title="Prune unused volumes"
        message="This removes all volumes not used by at least one container."
        confirmLabel="Prune"
      />
    </div>
  );
}
