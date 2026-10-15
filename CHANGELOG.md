# Changelog

## 0.4.0 — 2026-10-16

- Add Notes handoff to new Codex tool-mode sessions: atomic revisions, idempotent writes, paged reads, safe window resets, fork isolation and restart recovery.
- Reuse DSH's token meter, session log, compaction lifecycle and native summary fallback. Budget estimates follow the latest recorded route.
- Add a read-only context panel and window timeline, updated through native session projections.
- Preserve tool-result images and developer messages on both OpenAI routes; preserve compatible Responses encrypted reasoning and phase with content and route checks.
- Allow model-specific modalities, reasoning efforts and capacity; propagate in-stream retry information.
- Correct tool guidance, fresh-versus-fork subagent context descriptions and scoped shell restrictions. Include Notes modules in preset publication.

Validation: the complete isolated suite passes on DSH 0.1.5-rc.1. Notes and protocol paths also pass against the local 0.2.0-rc.2 runtime. Full-plugin DSH 0.2 compatibility is not declared.
