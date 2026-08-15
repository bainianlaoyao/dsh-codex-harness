# dsh-codex-mode trajectory replay report

Generated: 2026-08-15T17:52:36.043Z

Method: each trajectory mocks ONLY the model output (scripted Responses steps); every tool call executes on the real harness. The same trajectory replays on the official codex CLI (win32, pwsh default shell) and on the DSH headless-codex profile (git bash backend). Contexts are canonicalized (user/assistant text, tool calls, tool outputs) and diffed with an LCS alignment after normalization (CRLF, wall times, chunk ids, session ids, timestamps). DSH-injected harness messages (runtime-context snapshot, skills reminder) are excluded from the strict diff and counted separately.

| trajectory | codex exit | dsh exit | codex lines | dsh lines | matched | diffs | injected-dsh |
|---|---|---|---|---|---|---|---|
| T1-basic-echo | 0 | 0 | 5 | 9 | 5 | 0 | 4 |

## Summary: 1/1 trajectories with zero context differences
