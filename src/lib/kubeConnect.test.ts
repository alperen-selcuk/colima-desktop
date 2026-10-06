import { describe, expect, it } from "vitest";
import { connectSnippets, defaultKubeconfigFileName, shellQuote } from "./kubeConnect";

describe("kubeConnect", () => {
  it("quotes only when needed", () => {
    expect(shellQuote("/Users/a/kube.yaml")).toBe("/Users/a/kube.yaml");
    expect(shellQuote("/Users/a b/kube.yaml")).toBe("'/Users/a b/kube.yaml'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("builds snippets, with export only after a file was saved", () => {
    const a = connectSnippets("colima", null);
    expect(a.map((s) => s.id)).toEqual(["get-pods", "use-context"]);
    expect(a[0].text).toBe("kubectl --context colima get pods -A");
    const b = connectSnippets("colima-dev", "/tmp/my kube.yaml");
    expect(b.find((s) => s.id === "export")?.text).toBe("export KUBECONFIG='/tmp/my kube.yaml'");
  });

  it("names the default export file after the context", () => {
    expect(defaultKubeconfigFileName("colima-dev")).toBe("colima-dev-kubeconfig.yaml");
  });
});
