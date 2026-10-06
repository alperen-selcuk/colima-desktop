import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Layers, Play, Search, Trash2 } from "lucide-react";
import * as api from "../lib/api";
import type { Image } from "../lib/types";
import { relativeAge } from "../lib/format";
import { Table, Thead, Th, Td, Tr } from "../components/Table";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/Toasts";
import { PullDialog } from "../dialogs/PullDialog";
import { RunContainerDialog } from "../dialogs/RunContainerDialog";

export function ImagesPage({ profile }: { profile: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [pruneMenuOpen, setPruneMenuOpen] = useState(false);
  const [pullOpen, setPullOpen] = useState(false);
  const [runImage, setRunImage] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<Image | null>(null);

  const imagesQuery = useQuery({
    queryKey: ["images", profile],
    queryFn: () => api.listImages(profile),
    refetchInterval: 5000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["images", profile] });

  const images = imagesQuery.data ?? [];
  const filtered = images.filter((i) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return i.repository.toLowerCase().includes(q) || i.tag.toLowerCase().includes(q) || i.id.toLowerCase().includes(q);
  });

  const handleRemove = async () => {
    if (!confirmRemove) return;
    try {
      await api.removeImage(profile, confirmRemove.id, confirmRemove.inUse);
      toast.success(`Removed ${confirmRemove.repository}:${confirmRemove.tag}`);
      invalidate();
    } catch (e) {
      toast.error("Failed to remove image", String(e));
    }
  };

  const handlePrune = async () => {
    setPruneMenuOpen(false);
    try {
      const output = await api.prune(profile, "images");
      toast.success("Pruned unused images", output);
      invalidate();
    } catch (e) {
      toast.error("Failed to prune images", String(e));
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3">
        <div className="relative flex-1 max-w-[320px]">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: "var(--text-faint)" }} />
          <input
            id="images-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search images…"
            className="w-full rounded-md border py-1.5 pl-8 pr-2.5 text-[12.5px] outline-none"
            style={{ background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text)" }}
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Button variant="secondary" size="sm" onClick={() => setPruneMenuOpen((v) => !v)}>
              Prune unused <ChevronDown size={12} />
            </Button>
            {pruneMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setPruneMenuOpen(false)} />
                <div
                  className="absolute right-0 top-full z-20 mt-1 min-w-[160px] rounded-md border py-1 shadow-lg"
                  style={{ background: "var(--surface-1)", borderColor: "var(--border)" }}
                >
                  <button
                    onClick={handlePrune}
                    className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--surface-2)]"
                    style={{ color: "var(--text)" }}
                  >
                    Prune unused images
                  </button>
                </div>
              </>
            )}
          </div>
          <Button variant="primary" size="sm" onClick={() => setPullOpen(true)}>
            Pull image
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {filtered.length === 0 ? (
          <EmptyState icon={Layers} title="No images" message="Pull an image to see it here." />
        ) : (
          <Table>
            <Thead>
              <Th>Repository</Th>
              <Th>Tag</Th>
              <Th>Image ID</Th>
              <Th>Created</Th>
              <Th>Size</Th>
              <Th style={{ width: 120 }}>Actions</Th>
            </Thead>
            <tbody>
              {filtered.map((img) => (
                <Tr key={img.id}>
                  <Td className="font-medium">{img.repository}</Td>
                  <Td className="font-mono-app text-[11.5px]" style={{ color: "var(--text-dim)" }}>
                    {img.tag}
                  </Td>
                  <Td className="font-mono-app text-[11px]" style={{ color: "var(--text-faint)" }}>
                    {img.id.replace("sha256:", "").slice(0, 12)}
                  </Td>
                  <Td style={{ color: "var(--text-dim)" }}>{img.createdSince || relativeAge(img.createdAt)}</Td>
                  <Td style={{ color: "var(--text-dim)" }}>{img.size}</Td>
                  <Td>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setRunImage(`${img.repository}:${img.tag}`)} title="Run">
                        <Play size={13} />
                      </Button>
                      <Button variant="danger-outline" size="sm" onClick={() => setConfirmRemove(img)} title="Delete">
                        <Trash2 size={13} />
                      </Button>
                      {img.inUse && (
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                          style={{ background: "var(--info-soft)", color: "var(--info)" }}
                        >
                          in use
                        </span>
                      )}
                    </div>
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
        title={`Delete ${confirmRemove ? `${confirmRemove.repository}:${confirmRemove.tag}` : ""}`}
        message={
          confirmRemove?.inUse
            ? "This image is used by a container. Deleting it forces removal and may break running containers."
            : "This permanently deletes the image."
        }
        confirmLabel="Delete"
      />

      <PullDialog open={pullOpen} profile={profile} onClose={() => setPullOpen(false)} onPulled={invalidate} />

      <RunContainerDialog
        open={!!runImage}
        profile={profile}
        onClose={() => setRunImage(null)}
        onRan={() => {}}
        prefill={runImage ? { image: runImage } : null}
      />
    </div>
  );
}
