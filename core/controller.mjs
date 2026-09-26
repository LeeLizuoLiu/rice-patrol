import { ShortLineDetector } from './detector.mjs';

export class GuardStopError extends Error {
  constructor(reason) { super(reason); this.name = 'GuardStopError'; this.code = reason; }
}

const noop = () => {};
export function createGuardedStream(options, next, config, {
  cancelTransport, onEvent = noop, now = () => performance.now(),
  schedule = (fn, ms) => setTimeout(fn, ms), unschedule = clearTimeout
} = {}) {
  if (config.mode === 'off') return next();
  if ((config.mode === 'enforce' || config.requestDeadlineMs !== null || config.maxReasoningBytes !== null || config.maxReasoningDeltas !== null) && typeof cancelTransport !== 'function')
    throw new Error('Guard cancellation requires a host cancellation handle');
  return (async function* () {
    const started = now();
    const detector = new ShortLineDetector(config);
    const iterator = next()[Symbol.asyncIterator]();
    let terminal = null, timer = null, wake, settled = false;
    let reasoningBytes = 0, forwarded = 0, consumed = 0;
    let detectorDisabled = false, warningEmitted = false;
    const stopped = new Promise(resolve => { wake = resolve; });
    const emit = event => { try { Promise.resolve(onEvent({ ...event, elapsedMs: now() - started, consumed, forwarded, reasoningBytes })).catch(noop); } catch {} };
    const decide = reason => {
      if (terminal !== null || settled) return false;
      terminal = reason;
      emit({ status: 'TERMINATED', reason });
      try { cancelTransport?.(reason); } catch {}
      wake(reason);
      return true;
    };
    const abort = () => decide(options.signal?.reason?.kind === 'hook' && options.signal.reason.reason?.startsWith('reasoning-guard:')
      ? options.signal.reason.reason.slice('reasoning-guard:'.length) : 'USER_ABORT');
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    if (config.requestDeadlineMs !== null) timer = schedule(() => decide('REQUEST_DEADLINE_EXCEEDED'), config.requestDeadlineMs);
    try {
      while (true) {
        if (terminal) throw new GuardStopError(terminal);
        let result;
        try {
          const outcome = await Promise.race([
            Promise.resolve().then(() => iterator.next()).then(value => ({ kind: 'next', value }), error => ({ kind: 'error', error })),
            stopped.then(reason => ({ kind: 'stop', reason }))
          ]);
          if (outcome.kind === 'stop') throw new GuardStopError(outcome.reason);
          if (outcome.kind === 'error') throw outcome.error;
          result = outcome.value;
        } catch (error) {
          if (terminal) throw new GuardStopError(terminal);
          terminal = 'TRANSPORT_ERROR';
          emit({ status: 'TERMINATED', reason: terminal });
          throw error;
        }
        if (terminal) throw new GuardStopError(terminal);
        if (result.done) { settled = true; return; }
        const chunk = result.value;
        consumed++;
        if (chunk?.type === 'reasoning-delta') {
          const value = String(chunk.text ?? '');
          reasoningBytes += Buffer.byteLength(value, 'utf8');
          const event = detectorDisabled ? null : detector.feed(value);
          if (detector.firstHit && !warningEmitted) { emit({ status: 'WARNING', hit: detector.firstHit }); warningEmitted = true; }
          if (terminal) throw new GuardStopError(terminal);
          if (event?.status === 'CONFIRMED') {
            emit(event);
            if (config.mode === 'enforce') decide('REASONING_LOOP_CONFIRMED');
          }
          if (event?.status === 'RESOURCE_LIMIT' && !cancelTransport) { detectorDisabled = true; emit({ status: 'RESOURCE_LIMIT_UNENFORCED' }); }
          else if (event?.status === 'RESOURCE_LIMIT' || config.maxReasoningBytes !== null && reasoningBytes > config.maxReasoningBytes || config.maxReasoningDeltas !== null && detector.deltaCount > config.maxReasoningDeltas)
            decide('STREAM_RESOURCE_LIMIT');
        }
        if (terminal) throw new GuardStopError(terminal);
        if (chunk?.type === 'finish') {
          settled = true;
          if (timer !== null) { unschedule(timer); timer = null; }
          options.signal?.removeEventListener('abort', abort);
        }
        forwarded++;
        yield chunk;
        if (settled) return;
      }
    } finally {
      if (!settled && !terminal) decide('CONSUMER_CLOSED');
      if (timer !== null) unschedule(timer);
      options.signal?.removeEventListener('abort', abort);
      // Call return, but never let a blocked upstream hold the turn indefinitely.
      const close = Promise.resolve().then(() => iterator.return?.()).then(()=>'SETTLED',()=>'FAILED');
      let cleanupTimer;
      try {
        const result=await Promise.race([close, new Promise(resolve => { cleanupTimer = setTimeout(()=>resolve('UNSETTLED'), config.cleanupWaitMs); })]);
        emit({status:'STREAM_CLEANUP',reason:result});
      } finally { clearTimeout(cleanupTimer); }
    }
  })();
}
