# Recover 0.2 local validation

The current change has **not** made a new real provider call or run a new full DSH Web scenario. The earlier isolated Web evidence in `VALIDATION.md` belongs to the previous release.

- `npm test`: 50/50 pass with loopback synthetic adapters. The added cases cover eviction at operation 129, preservation of older replay fingerprints, settled tool errors, and the host tool scope for a recovered child.
- A read-only parser audit used one previously saved, long session. It included 1,583 events, 427 recorded tool results (native plus nested PTC), six completed compactions, and 19 tool results marked as errors. Checkpoint construction succeeded with a 128-operation window, 389 unique historical fingerprints, a 57,299-character clean input, and 25,718 characters of mandatory facts. No prompt or tool contents were printed or saved in this repository.
- A local recovery-state dry-run used that checkpoint with a synthetic summary and a synthetic child result. It reached `completed`, with one compact stage and one resume stage. This verifies local state transitions and length checks; it is not evidence that a real model will summarize accurately or finish the task.
- The parser still refuses unpaired tool records, unsupported history rewrites, pending input, and active or unreported jobs. The host retains its tool permissions. Only exact earlier operation fingerprints are excluded; semantic duplicates with different arguments remain possible.

Before calling this release production-verified, exercise the updated package through an isolated DSH Web profile with a bounded fake upstream, then observe one explicitly authorized ordinary real-service task. Do not treat the read-only audit as proof of real-service recovery.
