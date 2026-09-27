# CLAUDE.md

@AGENTS.md

## Claude Code notes

- `AGENTS.md` (imported above) is the project guide; `docs/SPEC.md` is the source of truth for the IPC contract
  and behaviour. Keep both current when you change contracts, workflows or release steps.
- Maintainer workflow: planning, analysis and review happen on the strongest model; implementation is delegated
  to subagents with clear file ownership so parallel agents never edit the same files. Always verify their
  output yourself (tests, a real build, and `git show --stat` before pushing — delegated commits have
  previously dropped `src/` files).
- Before claiming a fix works, reproduce the problem and verify against the real app or a live Colima where
  possible (see the ignored live tests in AGENTS.md §4), not only unit tests.
- Ask before destructive or outward-facing actions (deleting releases, force-pushes, writing the user's
  kubeconfig, starting/stopping/deleting machines) unless the maintainer has explicitly asked for them.
