import { useEffect, useRef, useState } from "react";
import { onOpEnd, onOpLog } from "./api";
import { applyOpEnd, applyOpLog, completionMessage, pruneStale, type OpsState } from "./opPhase";

interface Options {
  /** Profiles the backend currently reports as busy (polled); used to drop ops whose end event was missed. */
  busyProfiles: string[];
  onSuccess: (title: string, openKubernetes: boolean, profile: string) => void;
}

/**
 * Tracks the lifecycle operation running per profile from `colima-op-log` /
 * `colima-op-end` events (pure reducers live in `opPhase.ts`). Call once, in
 * the app shell.
 */
export function useOps({ busyProfiles, onSuccess }: Options): OpsState {
  const [ops, setOps] = useState<OpsState>({});
  const opsRef = useRef<OpsState>({});
  const cb = useRef(onSuccess);
  cb.current = onSuccess;
  const busyRef = useRef(busyProfiles);
  busyRef.current = busyProfiles;

  const commit = (next: OpsState) => {
    opsRef.current = next;
    setOps(next);
  };

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;
    const keep = (p: Promise<() => void>) =>
      p.then((fn) => (disposed ? fn() : unlisteners.push(fn)));
    keep(onOpLog((log) => commit(applyOpLog(opsRef.current, log, Date.now()))));
    keep(
      onOpEnd((end) => {
        const { state, finished } = applyOpEnd(opsRef.current, end);
        commit(state);
        if (finished && end.ok) {
          const msg = completionMessage(finished);
          if (msg.title) cb.current(msg.title, msg.openKubernetes, finished.profile);
        }
      }),
    );
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => {
      const next = pruneStale(opsRef.current, busyRef.current, Date.now());
      if (next !== opsRef.current) commit(next);
    }, 2000);
    return () => window.clearInterval(t);
  }, []);

  return ops;
}
