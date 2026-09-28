# Recover 0.2 local validation

The current change has **not** made a new real provider call or run a new full DSH Web scenario. The earlier isolated Web evidence in `VALIDATION.md` belongs to the previous release.

- `npm test`: 50/50 pass with loopback synthetic adapters. The added cases cover eviction at operation 129, preservation of older replay fingerprints, settled tool errors, and the host tool scope for a recovered child.
- A read-only parser audit used one previously saved, long session. It included 1,583 events, 427 recorded tool results (native plus nested PTC), six completed compactions, and 19 tool results marked as errors. Checkpoint construction succeeded with a 128-operation window, 389 unique historical fingerprints, a 57,299-character clean input, and 25,718 characters of mandatory facts. No prompt or tool contents were printed or saved in this repository.
- A local recovery-state dry-run used that checkpoint with a synthetic summary and a synthetic child result. It reached `completed`, with one compact stage and one resume stage. This verifies local state transitions and length checks; it is not evidence that a real model will summarize accurately or finish the task.
- The parser still refuses unpaired tool records, unsupported history rewrites, pending input, and active or unreported jobs. The host retains its tool permissions. Only exact earlier operation fingerprints are excluded; semantic duplicates with different arguments remain possible.

Before calling this release production-verified, exercise the updated package through an isolated DSH Web profile with a bounded fake upstream, then observe one explicitly authorized ordinary real-service task. Do not treat the read-only audit as proof of real-service recovery.

## v0.2.6: later user turns in one session

The 2026-09-28 17:28 screenshot showed a confirmed guard stop followed by `recovery already reserved or consumed`. The durable record showed a failed compaction attempt at 16:08 for the same session. The old ledger was keyed only by session ID, so every later turn was rejected before compaction. The new reservation key combines the session ID and the sequence number of the latest explicit user message. A host-created turn without new user input does not refresh the allowance. The old session-level record is retained but cannot block a new user message.

Local fake-provider tests cover a successful recovery followed by another user turn and recovery in the same session, a user-stopped recovery followed by a later recovery, durable same-input rejection after a simulated restart, and a failed turn followed by a later turn. The clean-checkpoint parser recognizes only Rice Patrol's own one-shot child catalog metadata; unrelated subagent catalogs still block handoff. A recovered child that repeats during the same user turn still stops without a second automatic child. No new real model request or full production Web validation was performed for this change.
