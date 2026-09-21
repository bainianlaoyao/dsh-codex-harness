# Goal rounds are admitted while the agent is only waiting on a job

**Component:** `@deepseek-ai/dsh-goal-round-driver`, with `@deepseek-ai/dsh-tool-jobs` and a Codex-shaped exec surface
**Observed on:** DSH `0.1.5-rc.1`, `dsh-goal-round-driver` `0.1.5-rc.2`, Windows
**Severity:** goal round budget and session history are spent on waiting; a "round" stops meaning "progress"
**Status:** draft issue — measured and reproducible, not yet filed

## Summary

`readyToDrive()` admits a goal round on `state.agent.status === "idle"` and asks nothing else:

```ts
// packages/goal/goal-round-driver/src/index.ts
return ctx.fiber.state === 2 && !state.stopping
  && ctx.agents.get(state.agent.id) === state.agent
  && state.agent.status === "idle"
  && !state.competingQueued
```

On a Codex-shaped tool surface that single condition is load-bearing. `exec_command` yields a
still-running command after `yield_time_ms` (10 s floor / 30 s cap on Windows), so any longer command
becomes a background job; the `dsh-tool-jobs` prompt section then tells the model not to busy-poll
because "you are notified in-session when a job finishes", so the model ends its turn to wait — and the
driver reads that turn end as idleness and immediately admits a round whose only productive action is
another `job_output({ wait: true })`. The completion notice the prompt promised arrives *after* the
round admitted to wait for it.

Measured on one live session: **18 injections, 11 of them (61%) pure `job_output` waits**, and
**29 of 29 turn ends happened with an exec session still running**.

## Mechanism, step by step

1. The agent starts a long command. `exec_command` returns `Process running with session ID exec`
   once the yield window elapses, and the command is registered as DSH job `exec-96`.
2. `dsh-tool-jobs`' prompt section (`packages/jobs/tool-jobs/src/index.ts`): *"Track every background
   job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on
   one…"*. The model treats the command as settled work and ends the turn.
3. `agent/status` fires `idle`; the driver's listener calls `requestDrive()`; `readyToDrive()` passes
   (`status === "idle"`, nothing competing in the inbox).
4. The driver queues `renderGoalRoundPrompt()` through `agent.followup()` — a retained user-role
   `<goal_round>` block, and `roundsStarted` increments.
5. The round's first tool call is `job_output({ job_id: "exec-96", wait: true, timeout_ms: 300000 })`.
   It times out after 5 minutes with the job still running, nothing else is pending, the turn ends →
   step 3.

Nothing in the loop is a `blocked` report either: `blockedAfterConsecutiveRounds` (3) never fires,
because waiting is not being blocked.

## Evidence

Session `session-743812d8-ecb0-4476-baba-b612657ede02` (preset `codex`, model `gpt-6-astra`,
cwd `E:\texus`), read from the durable session log:

```
turn ends: 29 (29 with an exec session still running)
goal-round injections: 18
  round   5/256  t+5002s   first tool: exec_command   <- starts the batch run, job exec-96
  round   6/256  t+5448s   first tool: job_output     <- WAIT ROUND
  round   7/256  t+5822s   first tool: job_output     <- WAIT ROUND
  round   8/256  t+6187s   first tool: job_output     <- WAIT ROUND
  round   9/256  t+6570s   first tool: job_output     <- WAIT ROUND
  round  10/256  t+6931s   first tool: job_output     <- WAIT ROUND
  ...
  round   1/256  t+18664s  first tool: job_output     <- WAIT ROUND (second waiting episode)
  ... 6 consecutive wait rounds ...
```

Rounds 6–10 are five consecutive rounds whose entire action is waiting on the same batch job —
roughly 25 minutes of round budget, five retained `<goal_round>` blocks, and five synthetic user
messages, with no progress between them. A second episode repeats the pattern six more times.

Cross-preset comparison on the same machine — every session that ever admitted a round (20 sessions,
1098 logged), effective preset resolved through `agent-preset/selected` where the session was
switched mid-life:

| effective preset | sessions | rounds | wait rounds |
| --- | --- | --- | --- |
| `codex` | 3 | 37 | **11 (30%)** |
| `standard` | 5 | 24 | **0 (0%)** |
| `cordis` | 1 | 8 | 0 (0%) |
| `warmupbetter-replay` | 9 | 232 | 34 (15%) |
| `router-flash` | 2 | 3 | 0 (0%) |

Every `standard` round began with real work (`bash`, `python`, `write`). The waiting pattern appears
exactly where a turn ends while a background job is still running: a Codex-shaped `exec_command`
reaches that by default (auto-yield), while `bash` reaches it only through an explicit
`run_in_background: true` — which is why the replay preset shows it too, at a lower rate.

## Why it matters

- **Budget.** `defaultMaxGoalRounds` defaults to 256, so an unsettled job can be waited on for hours,
  each wait consuming a round that the objective never gets back.
- **History.** Every admitted round is retained and resent on later requests until compaction shadows
  it, so a waiting episode leaves N copies of the objective plus instructions in context.
- **UI.** Each round is a synthetic user message, so a session that is doing nothing but waiting looks
  like it is being driven from outside.
- **Semantics.** A round is documented as "another turn toward the objective"; a wait round advances
  nothing and still spends the allowance.

## Proposed fix

1. **Gate admission on outstanding work (preferred).** `readyToDrive()` should additionally require
   that the agent owns no running background job — the job registry is keyed by owning agent — and,
   arguably, no running continuable subagent. A long job then costs zero rounds: the round is admitted
   once the job settles, when the agent is genuinely idle.
2. **Do not charge the budget for wait rounds.** Admit the round but keep it out of `roundsStarted`
   and drop it from history when it settled nothing. Weaker: it is still injected and still rendered.
3. **Make it configurable** (for example `admitWhileWorkPending: false` by default) so a deployment
   can choose.

## Reproduce (read-only)

`scripts/goal-round-audit.mjs` in this repository walks `$DSH_HOME/sessions`, decodes the
concatenated-zstd session logs (one frame per flush — `zlib.zstdDecompressSync` alone decodes only the
first), resolves each session's effective preset, and reports rounds, wait rounds, and turn ends that
left an exec session running:

```sh
node scripts/goal-round-audit.mjs                       # every session, per-preset summary
node scripts/goal-round-audit.mjs --session 743812d8    # one session, per-round detail
```

Two reading notes for anyone re-running it:

- A session records its **creation** preset in the header and every mid-life switch in
  `agent-preset/selected`; grouping by the header alone mislabels sessions (for example, a session
  created as `codex` and switched to `cordis` counts as `codex`).
- The live-session column is meaningful only on the Codex exec surface, since the marker it counts
  (`Process running with session ID …`) is that tool's output.
