# Validation of v0.1.0

Tested on DeepSeek Harness `0.1.6-alpha.2`, Node `26.7.0`.

- 47/47 current local tests passed. They cover public DSH stream/turn cancellation, wildcard or exact provider/model filters, request correlation across retries, cleanup settlement, bounded recovery, operation journal, status RPC, the recovery UI, and the three-mode settings card.
- Actual isolated DSH Web loaded the package and switched between two synthetic provider/model routes without changing guard configuration. Each route made four loopback HTTP requests: a parent tool call, cancelled repeated reasoning, a child tool call, and a child final answer. Both Web recovery cards completed and linked to the child result. Total for the corrected validation: eight local fake requests and zero real model calls.
- A deliberately broken synthetic adapter ignored cancellation and never finished stream cleanup. The parent stopped locally; the plugin reported `STREAM_CLEANUP_UNSETTLED` and started no compact or child request.
- An early Web fixture incorrectly interpreted DSH tool messages as OpenAI `role: tool`, producing 728 local fake requests before manual cancellation. The fixture was corrected and given a 12-request aggregate cap before the successful two-route validation. This failure was excluded from the pass count.

These tests establish local behavior of DSH's public interfaces with synthetic adapters. Individual real-service providers, production false-positive rates, and remote billing cessation were not verified. Production installation and automatic recovery were not enabled by the tests.
