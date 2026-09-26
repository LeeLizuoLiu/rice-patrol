// Project-local capability adapter over DSH's public agent/request + Agent.cancel.
// Cancels the current turn, not the session or the agent lifecycle. No adapter patch.
export function createHostCancellation(ctx) {
  const records = new WeakMap();
  const active = new Set();
  let disposed = false;
  const off = ctx.on('agent/request', async (payload, next) => {
    const previous = records.get(payload.signal);
    if (previous) previous.valid = false;
    const record = { ...payload, valid: true, claimed: false };
    records.set(payload.signal, record);
    try { return await next(); }
    catch (error) { record.valid = false; throw error; }
  });
  return {
    claim(options) {
      const record = records.get(options.signal);
      if (disposed || !record?.valid || record.claimed || record.agent.session.id !== options.sessionId)
        throw new Error('GUARD_CAPABILITY_MISSING: request is not bound to an active AgentLoop request');
      record.claimed = true;
      let live = true;
      const lease = {
        cancel(reason) {
          if (!live || !record.valid || records.get(options.signal) !== record || options.signal.aborted) return false;
          // keepInbox parks queued work. No new input or turn is generated here.
          // The public host owns this cause. Some fetch implementations add a
          // stack property to a mutable abort reason; keep the session cause
          // immutable without wrapping any provider or network transport.
          record.agent.cancel(Object.freeze({ kind: 'hook', reason: `reasoning-guard:${reason}` }), { keepInbox: true });
          return true;
        },
        release() { live = false; record.valid = false; active.delete(lease); }
      };
      active.add(lease);
      return lease;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      off();
      for (const lease of [...active]) { lease.cancel('PLUGIN_DISPOSED'); lease.release(); }
    },
    get activeCount() { return active.size; }
  };
}
