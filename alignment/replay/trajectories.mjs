/**
 * dsh-codex — 10 mock trajectories (part 3).
 *
 * Every trajectory mocks ONLY the model output (the scripted Responses
 * steps below); every tool call executes against the REAL harness
 * (official codex CLI and the DSH headless-codex profile). Each step is
 * one assistant turn: text + parallel tool calls. The LAST step must be
 * plain text so the turn ends on both harnesses.
 *
 * Shell policy (user direction): exec_command parity is scoped to the
 * git-bash backend; the official codex CLI on win32 runs pwsh/cmd, so
 * commands are chosen to produce identical output in pwsh, cmd and git
 * bash (echo/redirection/cat/exit/sleep), avoiding format-sensitive
 * commands (ls/dir/pwd).
 *
 * @module dsh-codex/alignment/replay/trajectories
 */

/** PNG 1x1 (fixed bytes) used by the view_image trajectory. */
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

export const trajectories = [
  {
    id: "T1-basic-echo",
    task: "Echo the exact text: hello world",
    steps: [
      { text: "I will echo the text.", toolCalls: [{ type: "function", name: "exec_command", arguments: JSON.stringify({ cmd: 'echo "hello world"' }) }] },
      { text: "Done. The output was: hello world" },
    ],
  },
  {
    id: "T2-file-create-read",
    task: "Create data.txt containing exactly 42, then read it back",
    steps: [
      { text: "Creating the file.", toolCalls: [{ type: "function", name: "exec_command", arguments: JSON.stringify({ cmd: 'echo "42" > data.txt' }) }] },
      { text: "Reading it back.", toolCalls: [{ type: "function", name: "exec_command", arguments: JSON.stringify({ cmd: "cat data.txt" }) }] },
      { text: "The file contains 42." },
    ],
  },
  {
    id: "T3-plan-exec-complete",
    task: "Create note.md with content step1, then mark the plan complete",
    steps: [
      { text: "Planning.", toolCalls: [{ type: "function", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Create note.md", status: "in_progress" }] }) }] },
      { text: "Writing the file.", toolCalls: [{ type: "function", name: "exec_command", arguments: JSON.stringify({ cmd: 'echo "step1" > note.md' }) }] },
      { text: "Marking complete.", toolCalls: [{ type: "function", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Create note.md", status: "completed" }] }) }] },
      { text: "All done." },
    ],
  },
  {
    id: "T4-apply-patch-add-update",
    task: "Add hello.py with a greet function, then change its return value to 42",
    steps: [
      { text: "Adding the file.", toolCalls: [{ type: "custom", name: "apply_patch", arguments: "*** Begin Patch\n*** Add File: hello.py\n+def greet():\n+    return 1\n*** End Patch" }] },
      { text: "Updating the return value.", toolCalls: [{ type: "custom", name: "apply_patch", arguments: "*** Begin Patch\n*** Update File: hello.py\n@@ def greet():\n-    return 1\n+    return 42\n*** End Patch" }] },
      { text: "hello.py now returns 42." },
    ],
  },
  {
    id: "T5-exec-failure-retry",
    task: "Run a failing command, then confirm recovery",
    steps: [
      { text: "Running the failing command.", toolCalls: [{ type: "function", name: "exec_command", arguments: JSON.stringify({ cmd: "exit 1" }) }] },
      { text: "It failed; confirming recovery.", toolCalls: [{ type: "function", name: "exec_command", arguments: JSON.stringify({ cmd: "echo recovered" }) }] },
      { text: "Recovered." },
    ],
  },
  {
    id: "T6-view-image",
    task: "Look at img.png and describe its size",
    seedFiles: [{ name: "img.png", base64: TINY_PNG_BASE64 }],
    steps: [
      { text: "Viewing the image.", toolCalls: [{ type: "function", name: "view_image", arguments: JSON.stringify({ path: "img.png" }) }] },
      { text: "The image is a 1x1 PNG." },
    ],
  },
  {
    id: "T7-write-stdin-interrupt",
    task: "Start a long sleep and interrupt it with Ctrl-C",
    steps: [
      { text: "Starting the sleep.", toolCalls: [{ type: "function", name: "exec_command", arguments: JSON.stringify({ cmd: "sleep 30", yield_time_ms: 10001 }) }] },
      { text: "Interrupting.", toolCalls: [{ type: "function", name: "write_stdin", arguments: JSON.stringify({ session_id: "$SESSION_ID", chars: "\u0003", yield_time_ms: 30000 }) }] },
      { text: "Interrupted." },
    ],
  },
  {
    id: "T8-output-truncation",
    task: "Echo hello world with a tiny output budget",
    steps: [
      { text: "Echoing with a small budget.", toolCalls: [{ type: "function", name: "exec_command", arguments: JSON.stringify({ cmd: 'echo "hello world"', max_output_tokens: 2 }) }] },
      { text: "Output was truncated." },
    ],
  },
  {
    id: "T9-apply-patch-error-recovery",
    task: "Apply a broken patch, then a valid one that adds ok.txt",
    steps: [
      { text: "Applying the broken patch.", toolCalls: [{ type: "custom", name: "apply_patch", arguments: "*** Begin Patch\n*** Update File: missing.txt\n@@ x\n- a\n+ b\n*** End Patch" }] },
      { text: "It failed; applying the valid one.", toolCalls: [{ type: "custom", name: "apply_patch", arguments: "*** Begin Patch\n*** Add File: ok.txt\n+ok\n*** End Patch" }] },
      { text: "ok.txt added." },
    ],
  },
  {
    id: "T10-mixed-workflow",
    task: "Plan, create a file, move it, and verify the result",
    steps: [
      { text: "Planning.", toolCalls: [{ type: "function", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Create file", status: "in_progress" }, { step: "Move file", status: "pending" }, { step: "Verify", status: "pending" }] }) }] },
      { text: "Creating src.txt.", toolCalls: [{ type: "custom", name: "apply_patch", arguments: "*** Begin Patch\n*** Add File: src.txt\n+payload\n*** End Patch" }] },
      { text: "Moving to dst.txt.", toolCalls: [{ type: "custom", name: "apply_patch", arguments: "*** Begin Patch\n*** Update File: src.txt\n*** Move to: dst.txt\n@@ payload\n-payload\n+payload2\n*** End Patch" }] },
      { text: "Verifying.", toolCalls: [{ type: "function", name: "exec_command", arguments: JSON.stringify({ cmd: "cat dst.txt" }) }] },
      { text: "Marking complete.", toolCalls: [{ type: "function", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Create file", status: "completed" }, { step: "Move file", status: "completed" }, { step: "Verify", status: "completed" }] }) }] },
      { text: "Workflow complete: dst.txt contains payload." },
    ],
  },
];

/** Resolve seed files (base64 content markers are decoded by the runner). */
export function seedFilesFor(trajectory) {
  return (trajectory.seedFiles ?? []).map((f) => {
    if (f.content === null && f.base64) return { name: f.name, content: Buffer.from(f.base64, "base64").toString("binary") }
    return f
  })
}