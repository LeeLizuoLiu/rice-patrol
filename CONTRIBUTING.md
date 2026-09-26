# Contributing

Please keep provider integrations on DSH's public APIs. Changes to cancellation or recovery should include a bounded synthetic-stream test and should preserve the original turn's cancellation reason. Avoid submitting credentials, reasoning content, private sessions, or research project files.

Run `npm test` with the matching DSH development packages installed before proposing a change. Document any real-provider verification separately from synthetic tests.
