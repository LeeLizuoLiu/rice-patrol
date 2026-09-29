# Rice Patrol 🍚🐋

[简体中文](README.zh-CN.md)

Rice Patrol is a DeepSeek Harness (DSH) plugin for repetitive reasoning, which we call “singing.” It reads **visible reasoning text** through DSH's general stream interface, without a provider-specific transport.

## How detection works

The plugin splits reasoning text into non-empty, newline-terminated lines, trims whitespace at each end, and watches the latest **50 lines**. It raises a **warning** when their median length is at most **20 characters** and at least **70% of the lines** have an exact duplicate in that window. If another qualifying window appears after at least 50 more lines, it **confirms** repetition.

It does not look for phrases such as `Let me`, require lines to get progressively shorter, or stop at the first warning. Each model request is checked separately. Repetition in ordinary answer text, and reasoning DSH cannot see, are outside its scope.

## What happens after confirmation

Choose a mode in **Plugins → rice-patrol**:

| Mode | Behavior |
| --- | --- |
| **Stop (default)** | Stop the current task and wait for you. |
| **Observe** | Record the signal without stopping the task. |
| **Recover** | Stop the current request, remove its interrupted reasoning from model-visible history, then resume the same Agent. |

Recover makes at most one automatic attempt **per user turn**. A later user turn in the same session can recover again if repetition recurs. If the resumed Agent repeats in the same user turn, it stops instead of restarting indefinitely. If Rice Patrol cannot verify a background job or tool result, it pauses for you instead of guessing. Finished or blocked reminders have a dismiss button; their records remain. Buttons and explanations follow the DSH interface language (Chinese or English). When no language is explicitly selected in DSH, it uses the browser's system language preference. Changing mode requires a DSH Web restart and does not change an in-flight task.

The handoff checks tools and background jobs first. It then replaces only the interrupted reasoning message in the model-visible history with a short notice; the original event remains in DSH's log. The same Agent continues from its earlier conversation. Rice Patrol makes no auxiliary summary call. DSH's normal automatic compaction may still run later if context pressure requires it. Completed file edits remain in the workspace.

## Install

Input already queued when recovery begins stays in the host inbox in its original order. New user input during recovery interrupts it; editing queued input prevents a stale handoff. The UI distinguishes a submitted handoff awaiting a response from a main Agent that has actually returned new output. Neither means the user's task is complete.

`resumeTimeoutMs` bounds handoff submission and the subsequent wait for the first resumed response separately (5 minutes each by default). It does not cap the duration or request count of the ongoing task. An unverified interrupted message or unfinished tool pauses recovery. See the [historical recovery notes](docs/SINGLE_AGENT_RECOVERY.md).

Built for DSH `0.1.6-alpha.2`:

```sh
dsh plugin --profile web add github:LeeLizuoLiu/rice-patrol#v0.2.8
```

Restart DSH Web, enable **both rice-patrol and its component** on the Plugins page, then choose a mode in its settings. Installing the package alone does not activate the guard.

## Limits and possible next steps

- The **50-line window and two qualifying windows** are fixed today. A future update may let users choose the lines per window and the number of windows needed for confirmation.
- Legitimate tool handoffs have appeared about two seconds after confirmation. Stop and Recover try to cancel immediately and may interrupt such work. Use Observe to assess your workflow first.
- Recover adds no summarization call. The resumed main Agent follows DSH's normal task limits; Rice Patrol adds no request-count or tool-count cap. Local cancellation does not prove provider billing has stopped.
- Behavior still needs validation across models and providers. A plain **Output token limit reached** message is not a detection signal.
- Recover pauses if it cannot verify the interrupted message, tool state, or background jobs. A previous paused recovery is not retried automatically.

v0.2.5 adds a bounded fallback for token-capped compaction and clearer pause messages. The WeakDALearning incident was inspected read-only; its exact compaction finish reason was not retained, so this change addresses a plausible cause rather than claiming to prove it. 60 local tests passed, including a synthetic AgentLoop fallback. No real model call was made for this fix. A previously paused recovery will not restart automatically. See the [recovery validation](docs/RECOVERY_0_2_VALIDATION.md) and [earlier Web validation](docs/VALIDATION.md) for test scope and technical details. MIT licensed.

v0.2.6 ties recovery allowance to explicit user input. Later user messages in the same session can recover automatically if repetition recurs; an older session-wide reservation no longer blocks them. Each user message still gets only one attempt, and repetition inside a recovery child stops that attempt. All 65 local tests passed, including fake-provider multi-turn recovery; there was no new real-service call.

v0.2.7 replaces the child task runner with a checkpoint written to the original session. The same Agent resumes after the checkpoint is written; the old 16-request child limit no longer applies. The local fake-provider tests confirm this path and more than 16 productive follow-up requests. Real-provider behavior still needs observation in ordinary use.

v0.2.8 keeps the normal DSH conversation, shadows only the interrupted reasoning message, and resumes the same Agent without an auxiliary summary call. It also reconciles settled `/permission` and `/plan` records without rerunning them and parks child reports during recovery. The local package was installed, but this direct-resume path was not tested before publication at the user's request.
