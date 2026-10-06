import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "./api";
import type { Dep } from "./types";

/** Required deps that are missing or installed-but-unlinked and have an automatic fix. */
export function requiredProblems(deps: Dep[] | undefined): Dep[] {
  return (deps ?? []).filter((d) => d.required && (!d.installed || d.linked === false));
}

export function isHealthy(d: Dep): boolean {
  return d.installed && d.linked !== false;
}

/** Dependency doctor query plus sequential fix runner (§6.9). */
export function useDeps() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["deps"], queryFn: api.depsCheck, staleTime: 15_000 });
  const [fixing, setFixing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fix = useCallback(
    async (names: string[]) => {
      setError(null);
      try {
        for (const name of names) {
          setFixing(name);
          const next = await api.depsFix(name);
          qc.setQueryData(["deps"], next);
        }
        qc.invalidateQueries({ queryKey: ["envInfo"] });
        qc.invalidateQueries({ queryKey: ["composeInfo"] });
      } catch (e) {
        setError(String(e));
      } finally {
        setFixing(null);
      }
    },
    [qc],
  );

  return { deps: query.data, isLoading: query.isLoading, fixing, error, fix, refetch: query.refetch };
}
