# Rice Patrol 🍚🐋

[简体中文说明](README.zh-CN.md)

Rice Patrol watches DSH reasoning streams for sustained short-line repetition. When enabled, it cancels the current turn through DSH's public API, builds a clean checkpoint from recorded user and tool events, and can let one fresh Agent resume the unfinished task. The whale gets one bowl, not an endless buffet.

This is a DeepSeek Harness plugin, not a model provider. It uses `llm/stream`, `agent/request`, `Agent.cancel()`, and native subagents. It needs no provider-specific transport wrapper. It follows the provider, model, and reasoning effort selected for the triggering request.

## Install from GitHub

Requires DeepSeek Harness `0.1.6-alpha.2` (the tested version) and a working `dsh` CLI:

```sh
dsh plugin --profile web add github:LeeLizuoLiu/rice-patrol
```

The GitHub package contains ready-to-run `.mjs` files and needs no build step. After installation, check the `web` profile's package/bundle registration and restart DSH Web. Installing the package does not itself turn on the guard: its Cordis entry is disabled by default. Enable both the package and its component on the DSH **Plugins** page. The default mode is **stop**. Once running, open **Plugins → rice-patrol** and select **observe**, **stop**, or **recover** in its settings card. The choice is saved in DSH settings and takes effect after restarting DSH Web; an in-flight task keeps its original mode. See `config/observe.example.yml` and `config/recover.example.yml` for optional profile overlays and recovery limits.

Use an **absolute** `stateDirectory` path that DSH can write. For example, save this overlay outside the repository as `rice-patrol.yml`, replacing the directory with your own:

```yaml
- id: rice-patrol
  disabled: false
  config:
    mode: observe
    provider: '*'
    model: '*'
    stateDirectory: /absolute/path/to/rice-patrol-state
```

Start DSH with `dsh web --patch /absolute/path/to/rice-patrol.yml` if you use an external overlay. `observe` records signals without cancelling a model request. You may omit `stateDirectory`; it defaults to `rice-patrol-state` below `DSH_HOME` (or `~/.dsh`). The Web settings choice overrides the overlay's `mode` on the next restart. `stop` cancels without recovery; `recover` enables the bounded recovery prototype. Remove the overlay and restart to disable a configuration supplied only by that overlay.

## What the guard does

- Detects repeated short lines in standard `reasoning-delta` chunks. A warning requires a 50-line window; confirmation requires another hit after at least 50 more lines.
- In `stop` or `recover`, cancels the DSH turn. Recovery starts only after the turn settles and the source stream confirms cleanup. An adapter that does not finish cleanup causes recovery to stop.
- Reconstructs a clean checkpoint from recorded user messages and completed tool results; it excludes the looping reasoning tail. A long checkpoint may receive one bounded same-model compaction call.
- Starts at most one fresh child Agent with the actual provider, model, and effort. Models without effort keep that field unset. A durable operation journal blocks exact duplicate side effects. Recovery is limited by time, request count, and an explicit tool allowlist.
- Shows status, a stop control, and the child result link in DSH Web.

The default is `stop`. Immediate stopping at confirmation has not been shown safe for all real tasks: earlier traces included legitimate tool handoffs shortly after confirmation. Select `observe` if you want to collect evidence without interrupting tasks. The plugin currently reads only exposed reasoning chunks; it cannot detect a model's hidden reasoning or repetition confined to visible answer text. Cancelling a local stream does not prove the remote provider stopped billing.

The recovery prototype supports settled filesystem tools (`read`, `glob`, `grep`, `write`, `edit`). It stops and asks for attention when the existing task involves shell/PTC/background jobs, ambiguous tool outcomes, or unverified history rewrites. It does not silently restart those operations. Original DSH permissions continue to apply.

## Development and evidence

`npm test` runs the local suite when the matching DSH packages are available. The release candidate passed **47 tests**. Two synthetic providers also passed the actual isolated DSH Web flow under one unchanged guard configuration: detection, cancellation, one child recovery, and UI result. These checks made no real model calls. See [validation notes](docs/VALIDATION.md).

This repository intentionally excludes private sessions, credentials, research project files, and old replay traces. The package uses the MIT license.
