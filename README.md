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
| **Recover** | Stop the task, compact verified work records, and let one fresh Agent try to continue. |

Recover makes at most one automatic attempt. If it cannot verify a background job or tool result, it pauses for you instead of guessing. Finished or blocked reminders have a dismiss button; their records remain. Buttons and explanations follow the DSH interface language (Chinese or English). When no language is explicitly selected in DSH, it uses the browser's system language preference. Changing mode requires a DSH Web restart and does not change an in-flight task.

## Install

Tested with DSH `0.1.6-alpha.2`:

```sh
dsh plugin --profile web add github:LeeLizuoLiu/rice-patrol#v0.2.2
```

Restart DSH Web, enable **both rice-patrol and its component** on the Plugins page, then choose a mode in its settings. Installing the package alone does not activate the guard.

## Limits and possible next steps

- The **50-line window and two qualifying windows** are fixed today. A future update may let users choose the lines per window and the number of windows needed for confirmation.
- Legitimate tool handoffs have appeared about two seconds after confirmation. Stop and Recover try to cancel immediately and may interrupt such work. Use Observe to assess your workflow first.
- Recover makes extra model calls. Its limits are 45 seconds for compaction and, for the new Agent, 5 minutes, 16 model requests, and 128 tool calls. Local cancellation does not prove provider billing has stopped.
- Behavior still needs validation across models and providers. A plain **Output token limit reached** message is not a detection signal.

v0.2.2 passed 52 local tests, including bilingual interface switching. This update made no real model calls. See the [recovery validation](docs/RECOVERY_0_2_VALIDATION.md) and [earlier Web validation](docs/VALIDATION.md) for test scope and technical details. MIT licensed.
