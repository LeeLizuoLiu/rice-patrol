// Local prototype. An adapter must keep every external operation behind the
// supplied signal and gates; this module does not register with DSH/Web.
const TERMINAL = new Set(['completed', 'user_interrupted', 'failed', 'budget_exhausted']);

export class RecoveryStopped extends Error {
  constructor(code) { super(code); this.name = 'RecoveryStopped'; this.code = code; }
}

function positiveInt(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function sameKeys(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) ||
      left.some(key => typeof key !== 'string' || !key) ||
      right.some(key => typeof key !== 'string' || !key)) return false;
  const a = new Set(left), b = new Set(right);
  return a.size === left.length && b.size === right.length &&
    a.size === b.size && [...a].every(key => b.has(key));
}

function mandatorySuffix(facts, completedKeys) {
  if (!facts || typeof facts !== 'object' || !Array.isArray(facts.userMessages) ||
      facts.userMessages.length === 0 || !Array.isArray(facts.completedOperations) ||
      facts.constraints?.source !== 'explicit-user-messages-preserved-verbatim')
    throw new RecoveryStopped('MANDATORY_FACTS_MISSING');
  if (facts.userMessages.some(item => typeof item?.eventId !== 'string' ||
      typeof item?.text !== 'string' || !item.text))
    throw new RecoveryStopped('MANDATORY_FACTS_INVALID');
  const operationKeys = facts.completedOperations.map(item => {
    if (item?.status !== 'result-recorded' || typeof item.operationKey !== 'string' ||
        !item.operationKey || typeof item.callEventId !== 'string' ||
        typeof item.resultEventId !== 'string')
      throw new RecoveryStopped('MANDATORY_FACTS_INVALID');
    return item.operationKey;
  });
  // Multiple recorded calls may share one stable operation key. Preserve every
  // row for provenance, but compare the deduplicated prohibition set.
  if (!sameKeys([...new Set(operationKeys)], completedKeys))
    throw new RecoveryStopped('MANDATORY_TOOL_LEDGER_MISMATCH');
  let serialized;
  try { serialized = JSON.stringify(facts); }
  catch { throw new RecoveryStopped('MANDATORY_FACTS_INVALID'); }
  if (!serialized || JSON.parse(serialized).userMessages.length !== facts.userMessages.length)
    throw new RecoveryStopped('MANDATORY_FACTS_INVALID');
  return `\n\n<mandatory-facts>\n${serialized}\n</mandatory-facts>`;
}

function withBudget(task, parentController, ms, label) {
  const parentSignal = parentController.signal;
  const controller = new AbortController();
  let rejectCancelled;
  const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
  const onAbort = () => {
    const reason = parentSignal.reason ?? new RecoveryStopped('USER_INTERRUPTED');
    controller.abort(reason);
    rejectCancelled(reason);
  };
  if (parentSignal.aborted) onAbort();
  else parentSignal.addEventListener('abort', onAbort, { once: true });
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new RecoveryStopped(`${label.toUpperCase()}_TIMEOUT`);
      controller.abort(error);
      parentController.abort(error);
      reject(error);
    }, ms);
  });
  return Promise.race([Promise.resolve().then(() => task(controller.signal)), deadline, cancelled]).finally(() => {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', onAbort);
  });
}

export class BoundedRecovery {
  #tasks = new Map();
  #userRevision = new Map();
  #active = new Map();
  constructor({ stopTimeoutMs = 10_000, compactTimeoutMs = 15_000, resumeTimeoutMs = 60_000,
    maxResumeRequests = 4, maxCleanInputChars = 48_000,
    compactAboveChars = 8_000, maxCheckpointChars = 12_000 } = {}) {
    this.stopTimeoutMs = positiveInt(stopTimeoutMs, 'stopTimeoutMs');
    this.compactTimeoutMs = positiveInt(compactTimeoutMs, 'compactTimeoutMs');
    this.resumeTimeoutMs = positiveInt(resumeTimeoutMs, 'resumeTimeoutMs');
    this.maxResumeRequests = positiveInt(maxResumeRequests, 'maxResumeRequests');
    this.maxCleanInputChars = positiveInt(maxCleanInputChars, 'maxCleanInputChars');
    this.compactAboveChars = positiveInt(compactAboveChars, 'compactAboveChars');
    this.maxCheckpointChars = positiveInt(maxCheckpointChars, 'maxCheckpointChars');
  }

  // Call for a real user cancellation or new user input, never for a guard event.
  userInterruption(taskId) {
    const revision = (this.#userRevision.get(taskId) ?? 0) + 1;
    this.#userRevision.set(taskId, revision);
    this.#active.get(taskId)?.abort(new RecoveryStopped('USER_INTERRUPTED'));
    return revision;
  }

  // The live detector can call this immediately on a second confirmed loop.
  confirmGuardAgain(taskId) {
    const controller = this.#active.get(taskId);
    if (!controller) return false;
    controller.abort(new RecoveryStopped('SECOND_GUARD_CONFIRMATION'));
    return true;
  }

  status(taskId) { return this.#tasks.get(taskId) ?? null; }

  async recover(trigger, adapter) {
    const { taskId, modelKey, guardEpisodeId, reason, userRevision, parentSignal,
      completedOperationKeys = [] } = trigger ?? {};
    if (!taskId || !modelKey || !guardEpisodeId || reason !== 'guard-confirmed')
      return { state: 'ineligible', reason: 'requires confirmed guard stop and stable task/model identity' };
    if (this.#tasks.has(taskId)) return { ...this.#tasks.get(taskId), reason: 'recovery already consumed' };
    if ((this.#userRevision.get(taskId) ?? 0) !== (userRevision ?? 0))
      return { state: 'user_interrupted', reason: 'newer user input exists' };
    for (const name of ['waitForStop', 'prepareCleanCheckpoint', 'resume']) {
      if (typeof adapter?.[name] !== 'function') throw new TypeError(`adapter.${name} is required`);
    }
    const state = { state: 'settling', compactCalls: 0, resumeCalls: 0,
      resumeRequests: 0, modelKey, taskId, reason: null };
    // Reserve once before the first await. A replacement Agent must share this
    // taskId; otherwise the host has to persist/restore the ledger itself.
    this.#tasks.set(taskId, state);
    const controller = new AbortController();
    this.#active.set(taskId, controller);
    const onParentAbort = () => controller.abort(new RecoveryStopped('PARENT_CANCELLED'));
    if (parentSignal?.aborted) onParentAbort();
    else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    const check = () => {
      if (TERMINAL.has(state.state)) throw new RecoveryStopped('RECOVERY_CLOSED');
      if (controller.signal.aborted || (this.#userRevision.get(taskId) ?? 0) !== (userRevision ?? 0))
        throw controller.signal.reason ?? new RecoveryStopped('USER_INTERRUPTED');
    };
    const completed = new Set(completedOperationKeys);
    try {
      check();
      if (!sameKeys(completedOperationKeys, completedOperationKeys))
        throw new RecoveryStopped('TOOL_LEDGER_INCOMPLETE');
      const settled = await withBudget(signal => adapter.waitForStop({ taskId, signal }),
        controller, this.stopTimeoutMs, 'stop');
      check();
      if (!settled?.guardCancelled || !settled?.turnClosed || !settled?.toolsSettled ||
          settled.guardEpisodeId !== guardEpisodeId)
        throw new RecoveryStopped('STOP_NOT_SETTLED');
      // No replay is allowed if tool bookkeeping cannot be trusted.
      if (!sameKeys(settled.completedOperationKeys, completedOperationKeys))
        throw new RecoveryStopped('TOOL_LEDGER_INCOMPLETE');

      // Build this from trusted task facts, never by replaying the cancelled
      // transcript. DSH compactNow() retains a recent tail and is unsafe here.
      state.state = 'preparing';
      let checkpoint = await withBudget(signal => adapter.prepareCleanCheckpoint({
        taskId, modelKey, guardEpisodeId, signal, excludeGuardTail: true,
        maxChars: this.maxCleanInputChars, completedOperationKeys: [...completed]
      }), controller, this.compactTimeoutMs, 'prepare');
      check();
      if (!checkpoint || checkpoint.modelKey !== modelKey ||
          checkpoint.excludedGuardTail !== true ||
          checkpoint.provenance !== 'deterministic-clean' ||
          checkpoint.sourceEpisodeId !== guardEpisodeId ||
          typeof checkpoint.text !== 'string' || !checkpoint.text.trim() ||
          checkpoint.text.length > this.maxCleanInputChars)
        throw new RecoveryStopped('INVALID_CHECKPOINT');
      const suffix = mandatorySuffix(checkpoint.mandatoryFacts, completedOperationKeys);
      if (suffix.length >= this.maxCheckpointChars)
        throw new RecoveryStopped('MANDATORY_FACTS_TOO_LARGE');
      if (checkpoint.text.length > this.compactAboveChars) {
        if (typeof adapter.compactCleanInput !== 'function')
          throw new RecoveryStopped('COMPACTION_REQUIRED');
        // Optional one-shot same-model summary, fed ONLY the clean checkpoint.
        // The adapter must route it through its own bounded auxiliary call.
        state.state = 'compacting';
        state.compactCalls++;
        const summary = await withBudget(signal => adapter.compactCleanInput({
          taskId, modelKey, cleanInput: checkpoint.text, signal,
          maxChars: this.maxCheckpointChars - suffix.length
        }), controller, this.compactTimeoutMs, 'compact');
        check();
        if (!summary || summary.modelKey !== modelKey ||
            summary.usedOnlyCleanInput !== true ||
            typeof summary.text !== 'string' || !summary.text.trim() ||
            summary.text.length >= checkpoint.text.length ||
            summary.text.length + suffix.length > this.maxCheckpointChars)
          throw new RecoveryStopped('INVALID_COMPACT_SUMMARY');
        checkpoint = { ...checkpoint, text: summary.text };
      }
      const finalCheckpoint = checkpoint.text + suffix;
      if (finalCheckpoint.length > this.maxCheckpointChars)
        throw new RecoveryStopped('CHECKPOINT_TOO_LARGE');
      state.state = 'resuming';
      state.resumeCalls++;
      const gate = {
        permitRequest: () => {
          check();
          if (state.resumeRequests >= this.maxResumeRequests)
            throw new RecoveryStopped('RESUME_REQUEST_BUDGET');
          state.resumeRequests++;
        },
        permitTool: ({ kind, operationKey }) => {
          check();
          if (kind === 'read') return;
          if (kind !== 'side-effect' || !operationKey || completed.has(operationKey))
            throw new RecoveryStopped('TOOL_REPLAY_OR_UNIDENTIFIED');
          // Reserve before execution. The host must durably reconcile outcomes.
          completed.add(operationKey);
        },
        check,
      };
      const result = await withBudget(signal => adapter.resume({
        taskId, modelKey, guardEpisodeId, checkpoint: finalCheckpoint,
        mandatoryFacts: checkpoint.mandatoryFacts, signal, gate,
        completedOperationKeys: [...completedOperationKeys],
        maxRequests: this.maxResumeRequests
      }), controller, this.resumeTimeoutMs, 'resume');
      check();
      if (result?.guardConfirmedAgain) throw new RecoveryStopped('SECOND_GUARD_CONFIRMATION');
      if (!result?.turnClosed || !result?.freshAgent || result?.modelKey !== modelKey)
        throw new RecoveryStopped('RESUME_NOT_CLOSED_OR_WRONG_AGENT');
      state.state = 'completed';
      return { ...state };
    } catch (error) {
      state.state = ['USER_INTERRUPTED', 'PARENT_CANCELLED'].includes(error?.code) ||
        controller.signal.aborted && ['USER_INTERRUPTED', 'PARENT_CANCELLED'].includes(controller.signal.reason?.code)
        ? 'user_interrupted' :
        /_TIMEOUT$|_BUDGET$/.test(error?.code ?? '') ? 'budget_exhausted' : 'failed';
      state.reason = error?.code ?? 'ADAPTER_ERROR';
      return { ...state };
    } finally {
      parentSignal?.removeEventListener('abort', onParentAbort);
      this.#active.delete(taskId);
      if (!TERMINAL.has(state.state)) { state.state = 'failed'; state.reason ??= 'UNKNOWN'; }
    }
  }
}
