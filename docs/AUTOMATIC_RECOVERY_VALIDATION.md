# Automatic recovery validation — 2026-10-10

Package: `0.2.11-desktopcompat.1`. Host: DSH `0.2.0-rc.2`.

The product has one behavior: confirm repeated reasoning, stop the generation, and resume the unfinished task in the original Agent/session. The mode selector and observation logger are removed. Legacy response modes are ignored. Manual cancellation and host-state checks remain. Detection thresholds are unchanged.

This update also synchronizes previously installed DSH 0.2 compatibility fixes: an interrupted stream can be recorded as `assistant/attempt`, and recovery messages use the producer-owned `plugin:dsh-rice-patrol` source required by the v4 session codec.

## Checks

- `npm test`: 47 passed, zero failed.
- The five in-process host cases cover omitted mode and legacy stop/observe/recover, plus ordinary output without recovery. They verify stream closure, one continuation in the same Agent/session, exclusion of interrupted reasoning, successful v4 event encoding, and absence of observation logs.
- Other checks cover the settings page without mode controls, cancellation leases, bounded cleanup, checkpoint provenance, inbox preservation and user interruption, recovery deduplication, persistent status, tool-operation journals, and RPC validation.
- `npm run check`, desktop-entry syntax checking, and `git diff --check` pass.

The retired observation tests were removed with their modules. The old HTTP host scenarios expected a compaction/child-Agent workflow and were replaced by the current in-process stop-and-resume cases. The checkpoint test now treats a valid subagent catalog as delegation metadata with unknown completion status; malformed catalogs still fail closed.

Run with matching DSH development packages available in `node_modules`. If using an existing host installation, set `DSH_TEST_ANCHOR` to its `@deepseek-ai/dsh/package.json` before running `npm test`. Test state is temporary; there are no credentials, network requests, or real-provider model calls.

These checks establish local synthetic behavior. They do not establish online recovery reliability for a real provider. Updating installed files requires a DSH restart to load the new host code. This GitHub source update does not publish an npm package.
