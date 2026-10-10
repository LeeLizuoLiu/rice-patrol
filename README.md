# Rice Patrol 🍚🐋

[中文](README.zh-CN.md)

Rice Patrol protects reasoning streams in DeepSeek Harness (DSH). When sustained short-line repetition is confirmed, it stops the current generation and resumes the unfinished task in the same conversation.

## One automatic recovery flow

Enable the plugin; no response-mode selection is needed. Every confirmed loop follows the same stop-and-resume flow. There is no Stop / Observe / Recover selector, observation logger, or n-gram detector.

Legacy `mode: stop`, `mode: observe`, and `mode: recover` values no longer select behavior. They may be removed, but leaving them in an old profile does not prevent automatic recovery. Use DSH's plugin enable/disable control to turn off Rice Patrol entirely.

The **Stop recovery** button remains available during recovery. New user input also interrupts the current recovery. Unverifiable session or background-job state pauses recovery with an explanation.

## Detection

The plugin reads reasoning text exposed by DSH, splits it into trimmed nonempty lines, and scores the last **50 lines**. A median line length of at most **20 characters**, with at least **70% of lines** having an exact duplicate inside that window, produces a warning. After at least 50 additional nonempty lines, another matching window confirms the loop and stops generation.

A warning alone does not stop output. The rule is provider-independent and uses a fresh detector for each model request. An ordinary output-token limit is outside its scope. This update does not change detection thresholds.

## Continuation

Rice Patrol waits for the stopped generation and stream cleanup, verifies host background jobs, excludes interrupted reasoning from model-visible history, and continues through the original Agent and session. Completed file edits and tool results remain available. The continuation asks the model to inspect workspace state before repeating side effects.

Each newly confirmed loop can recover; the same stop submits only one handoff. Failed or blocked old recoveries do not restart themselves. The resumed Agent follows normal DSH policies, without an extra summarization model request or plugin-imposed limits on later model/tool calls.

`resumeTimeoutMs` defaults to five minutes for handoff and the first resumed response, rather than the entire subsequent task. Minimal recovery status and deduplication records remain; there is no per-chunk observation log.

## Enablement and configuration

The current package is `0.2.11-desktopcompat.1`, with a desktop entry for DSH `0.2.0-rc.2`. The source is available on GitHub; this update does not publish an npm package.

Enable Rice Patrol and its components on the Plugins page. The plugin page explains automatic recovery; recovery status appears near the conversation input. See [config/recover.example.yml](config/recover.example.yml).

Provider/model filters, state directory, and recovery timeouts remain configurable. Response mode is not configurable. Use only one controller that cancels and resumes a given reasoning stream.

Restart DSH after updating installed files to load the new host code. Historical implementation notes are in [docs/SINGLE_AGENT_RECOVERY.md](docs/SINGLE_AGENT_RECOVERY.md). MIT license.
