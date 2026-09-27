import { ConfirmDialog } from "../ConfirmDialog";
import { requiresTypedDeleteConfirm } from "../../lib/k8sView";
import { KIND_LABEL } from "./K8sIcon";
import type { K8sNamespacedKind } from "../../lib/types";

interface K8sDeleteConfirmProps {
  open: boolean;
  kind: K8sNamespacedKind;
  namespace: string | null;
  name: string;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}

/** Delete confirmation for any namespaced kind (§6.6): requires typing the
 * exact name for deployments (any namespace) and for anything in
 * `kube-system`, regardless of kind — both are higher-blast-radius deletes
 * that deserve friction beyond a plain confirm click. */
export function K8sDeleteConfirm({ open, kind, namespace, name, onClose, onConfirm }: K8sDeleteConfirmProps) {
  const typed = requiresTypedDeleteConfirm(kind, namespace);
  const label = KIND_LABEL[kind].toLowerCase();

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      title={`Delete ${label} ${name}`}
      message={
        typed ? (
          <>
            Deleting this {label}
            {namespace === "kube-system" ? " in kube-system" : ""} may affect other workloads. This can't be undone.
          </>
        ) : (
          <>This {label} will be deleted. This can't be undone.</>
        )
      }
      requireTypedText={typed ? name : undefined}
      confirmLabel="Delete"
    />
  );
}
