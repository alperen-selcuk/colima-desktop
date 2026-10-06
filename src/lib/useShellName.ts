import { useQuery } from "@tanstack/react-query";
import * as api from "./api";

/** Basename of the user's login shell ($SHELL), e.g. "zsh". */
export function useShellName(): string {
  const q = useQuery({ queryKey: ["envInfo"], queryFn: api.envInfo });
  return q.data?.shell || "shell";
}
