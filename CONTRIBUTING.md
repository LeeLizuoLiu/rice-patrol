# Contributing

Please keep provider integrations on DSH's public APIs. Changes to cancellation or recovery should include a bounded synthetic-stream test and should preserve the original turn's cancellation reason. Avoid submitting credentials, reasoning content, private sessions, or research project files.

Run `npm test` with the matching DSH development packages installed before proposing a change. Document any real-provider verification separately from synthetic tests.

For the DSH 0.2 host scenarios, install matching development packages and resolve `@deepseek-ai/dsh/package.json` from this repository, or set `DSH_TEST_ANCHOR` to that package.json in an existing DSH 0.2.0-rc.2 installation. The tests use temporary state and an in-process fake adapter; they make no provider requests.
