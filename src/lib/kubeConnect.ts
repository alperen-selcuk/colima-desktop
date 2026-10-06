// Pure helpers for the Kubernetes "Connect" panel (v0.2.3).

/** POSIX single-quote a string for safe copy/paste into a shell. */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface ConnectSnippet {
  id: string;
  label: string;
  text: string;
}

/** Copyable terminal snippets for a colima kube context. */
export function connectSnippets(context: string, savedPath: string | null): ConnectSnippet[] {
  const out: ConnectSnippet[] = [
    { id: "get-pods", label: "List pods from your terminal", text: `kubectl --context ${shellQuote(context)} get pods -A` },
  ];
  if (savedPath) {
    out.push({
      id: "export",
      label: "Use the saved file only for this shell",
      text: `export KUBECONFIG=${shellQuote(savedPath)}`,
    });
  }
  out.push({
    id: "use-context",
    label: "Switch kubectl back to another context",
    text: "kubectl config use-context <name>",
  });
  return out;
}

/** Default file name offered by the "Save kubeconfig as…" dialog. */
export function defaultKubeconfigFileName(context: string): string {
  return `${context}-kubeconfig.yaml`;
}
