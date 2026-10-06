import { describe, expect, it } from "vitest";
import {
  applyOpEnd,
  applyOpLog,
  completionMessage,
  initialPhase,
  isLifecycleOp,
  latestOp,
  parsePhase,
  pruneStale,
  sawKubernetes,
  type OpsState,
} from "./opPhase";

const l = (msg: string, ctx?: string) =>
  `time="2026-10-06T10:00:00+03:00" level=info msg="${msg}"${ctx ? ` context=${ctx}` : ""}`;

describe("parsePhase", () => {
  it("maps colima start lines to phases", () => {
    expect(parsePhase(l("starting colima"))).toBe("Starting VM");
    expect(parsePhase(l("runtime: docker+k3s"))).toBe("Preparing");
    expect(parsePhase(l("creating and starting ...", "vm"))).toBe("Starting VM");
    expect(parsePhase(l("provisioning ...", "docker"))).toBe("Starting Docker");
    expect(parsePhase(l("starting ...", "docker"))).toBe("Starting Docker");
    expect(parsePhase(l("provisioning ...", "kubernetes"))).toBe("Starting Kubernetes");
    expect(parsePhase(l("starting ...", "kubernetes"))).toBe("Starting Kubernetes");
    expect(parsePhase(l("updating config ...", "kubernetes"))).toBe("Updating kubeconfig");
    expect(parsePhase(l("done"))).toBe("Done");
  });

  it("handles stop/delete and unknown lines", () => {
    expect(parsePhase(l("stopping colima"))).toBe("Stopping");
    expect(parsePhase(l("deleting colima"))).toBe("Deleting");
    expect(parsePhase(l("provisioning in VM"))).toBe("Provisioning");
    expect(parsePhase("some random output")).toBeNull();
    expect(parsePhase("")).toBeNull();
  });
});

describe("sawKubernetes", () => {
  it("detects k3s runtime and kubernetes context", () => {
    expect(sawKubernetes(l("runtime: docker+k3s"))).toBe(true);
    expect(sawKubernetes(l("runtime: docker"))).toBe(false);
    expect(sawKubernetes(l("starting ...", "kubernetes"))).toBe(true);
  });
});

describe("ops state", () => {
  const log = (op: string, line: string, profile = "default") => ({ profile, op, line });

  it("ignores non-lifecycle ops", () => {
    expect(applyOpLog({}, log("pull", "x"), 1)).toEqual({});
    expect(isLifecycleOp("start")).toBe(true);
    expect(isLifecycleOp("marketplace-install")).toBe(false);
  });

  it("tracks phase, keeps previous phase on unknown lines and remembers kubernetes", () => {
    let s: OpsState = {};
    s = applyOpLog(s, log("start", l("starting colima")), 10);
    expect(s.default.phase).toBe("Starting VM");
    s = applyOpLog(s, log("start", l("runtime: docker+k3s")), 11);
    s = applyOpLog(s, log("start", "noise"), 12);
    expect(s.default.phase).toBe("Preparing");
    expect(s.default.kubernetes).toBe(true);
    expect(s.default.startedAt).toBe(10);
    expect(s.default.lastActivity).toBe(12);
  });

  it("starts fresh when the op changes (stop then start chain)", () => {
    let s: OpsState = {};
    s = applyOpLog(s, log("stop", l("stopping colima")), 1);
    s = applyOpLog(s, log("start", "x"), 5);
    expect(s.default.op).toBe("start");
    expect(s.default.phase).toBe(initialPhase("start"));
  });

  it("finishes an op on op-end and builds the completion message", () => {
    let s: OpsState = {};
    s = applyOpLog(s, log("start", l("runtime: docker+k3s")), 1);
    const r = applyOpEnd(s, { profile: "default", op: "start", ok: true, error: null });
    expect(r.state).toEqual({});
    expect(completionMessage(r.finished!)).toEqual({
      title: "default is running · Kubernetes ready",
      openKubernetes: true,
    });
  });

  it("op-end for a different op or unknown profile is a no-op", () => {
    const s = applyOpLog({}, log("start", "x"), 1);
    expect(applyOpEnd(s, { profile: "default", op: "stop", ok: true, error: null }).finished).toBeNull();
    expect(applyOpEnd(s, { profile: "other", op: "start", ok: true, error: null }).finished).toBeNull();
  });

  it("completion: plain start has no k8s action, stop has no toast", () => {
    const s = applyOpLog({}, log("start", l("runtime: docker")), 1);
    expect(completionMessage(s.default)).toEqual({ title: "default is running", openKubernetes: false });
    const t = applyOpLog({}, log("stop", "x"), 1);
    expect(completionMessage(t.default).title).toBeNull();
  });

  it("pruneStale drops quiet ops that are no longer busy", () => {
    const s = applyOpLog({}, log("start", "x"), 1000);
    expect(pruneStale(s, [], 2000)).toBe(s);
    expect(pruneStale(s, ["default"], 99999)).toBe(s);
    expect(pruneStale(s, [], 99999)).toEqual({});
  });

  it("latestOp picks the most recently started", () => {
    let s: OpsState = {};
    s = applyOpLog(s, log("start", "x", "a"), 1);
    s = applyOpLog(s, log("start", "x", "b"), 2);
    expect(latestOp(s)?.profile).toBe("b");
    expect(latestOp({})).toBeNull();
  });
});
