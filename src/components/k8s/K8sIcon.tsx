import type { K8sKind } from "../../lib/types";

/** Maps each kind to its official Kubernetes community icon (public/k8s-icons,
 * see NOTICE for attribution) and its accent CSS variable name (src/styles/k8s.css).
 * Icons are used as-is (<img>), never recolored — the color story lives in
 * the surrounding chrome (tab indicator, accent dot), not in the artwork. */
const ICON_SRC: Record<K8sKind, string> = {
  pod: "/k8s-icons/pod.svg",
  deployment: "/k8s-icons/deploy.svg",
  service: "/k8s-icons/svc.svg",
  ingress: "/k8s-icons/ing.svg",
  configmap: "/k8s-icons/cm.svg",
  secret: "/k8s-icons/secret.svg",
  node: "/k8s-icons/node.svg",
};

export const KIND_ACCENT_VAR: Record<K8sKind, string> = {
  pod: "--k8s-pod",
  deployment: "--k8s-deploy",
  service: "--k8s-svc",
  ingress: "--k8s-ing",
  configmap: "--k8s-cm",
  secret: "--k8s-secret",
  node: "--k8s-node",
};

export const KIND_ACCENT_SOFT_VAR: Record<K8sKind, string> = {
  pod: "--k8s-pod-soft",
  deployment: "--k8s-deploy-soft",
  service: "--k8s-svc-soft",
  ingress: "--k8s-ing-soft",
  configmap: "--k8s-cm-soft",
  secret: "--k8s-secret-soft",
  node: "--k8s-node-soft",
};

export const KIND_LABEL: Record<K8sKind, string> = {
  pod: "Pod",
  deployment: "Deployment",
  service: "Service",
  ingress: "Ingress",
  configmap: "ConfigMap",
  secret: "Secret",
  node: "Node",
};

interface K8sIconProps {
  kind: K8sKind;
  size?: number;
  className?: string;
}

export function K8sIcon({ kind, size = 16, className = "" }: K8sIconProps) {
  return (
    <img
      src={ICON_SRC[kind]}
      alt=""
      role="presentation"
      width={size}
      height={size}
      className={`k8s-icon ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
