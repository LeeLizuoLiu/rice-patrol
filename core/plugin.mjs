import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { validateConfig } from './config.mjs';
import { createGuardedStream } from './controller.mjs';
import { createHostCancellation } from './host-cancellation.mjs';
import { matchesRoute } from './route.mjs';

export const name = 'dsh-reasoning-guard-experiment';
export function apply(ctx, raw = {}, internals = {}) {
  const config = validateConfig(raw);
  let sequence = 0;
  if (!internals.cancelTransport && config.cancellation !== 'host-turn' && (config.mode === 'enforce' || config.requestDeadlineMs !== null || config.maxReasoningBytes !== null || config.maxReasoningDeltas !== null))
    throw new Error('enforce/budgets require host-turn cancellation');
  const cancellation = config.cancellation === 'host-turn' && config.mode !== 'off' ? createHostCancellation(ctx) : null;
  const isAgent = internals.isAgentLoopRequest ?? isAgentLoopRequest;
  const off = ctx.on('llm/stream', (options, next) => {
    if (config.mode === 'off' || !matchesRoute(config, options) || !isAgent(options)) return next();
    return (async function* () {
      const lease = cancellation?.claim(options);
      const request = `guard-${++sequence}`;
      try {
        yield* createGuardedStream(options, next, config, {
          ...internals.controller,
          cancelTransport: lease ? reason => lease.cancel(reason) : internals.cancelTransport ? reason => internals.cancelTransport(options, reason) : undefined,
          onEvent: event => {
            const metadata = {request,guardVersion:'0.0.2',mode:config.mode,...event};
            if (internals.onEvent) return internals.onEvent(metadata, options);
            ctx.logger?.info('reasoning-guard %j',metadata);
          }
        });
      } finally { lease?.release(); }
    })();
  });
  const dispose = () => { off(); cancellation?.dispose(); };
  ctx.effect?.(() => dispose, 'reasoning guard listener');
  return dispose;
}
