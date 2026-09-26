export function validateConfig(raw = {}) {
  const c = { mode: 'observe', provider: '*', model: '*', callType: 'agent', cancellation: null,
    windowLines: 50, maxMedian: 20, minRepeat: 0.7,
    requestDeadlineMs: null, maxReasoningBytes: null,
    maxPendingLineChars: 65536, maxReasoningDeltas: null,
    cleanupWaitMs: 100, ...raw };
  if (!['off', 'observe', 'enforce'].includes(c.mode)) throw new TypeError('invalid mode');
  if (typeof c.provider !== 'string' || !c.provider.trim() || typeof c.model !== 'string' || !c.model.trim()) throw new TypeError('provider and model filters must be nonempty strings');
  if (c.callType !== 'agent') throw new TypeError('only agent callType is supported');
  if (c.cancellation !== null && c.cancellation !== 'host-turn') throw new TypeError('invalid cancellation capability');
  for (const k of ['windowLines','maxMedian','maxPendingLineChars','cleanupWaitMs'])
    if (!Number.isFinite(c[k]) || c[k] <= 0 || !Number.isInteger(c[k])) throw new TypeError(`invalid ${k}`);
  for (const k of ['requestDeadlineMs','maxReasoningBytes','maxReasoningDeltas'])
    if (c[k] !== null && (!Number.isFinite(c[k]) || c[k] <= 0 || !Number.isInteger(c[k]))) throw new TypeError(`invalid ${k}`);
  if (c.windowLines % 2 !== 0 || c.windowLines < 2 || !Number.isFinite(c.minRepeat) || c.minRepeat <= 0 || c.minRepeat > 1) throw new TypeError('invalid detector threshold');
  return Object.freeze(c);
}
