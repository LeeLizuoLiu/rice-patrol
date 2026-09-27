/* DSH client module. React is supplied by the host module loader. */
window.__ModuleLoader__.load({
  id: 'dsh-rice-patrol',
  factory(require) {
    const {createElement: h, useState, useEffect, useRef} = require('react');
    const ACTIVE = new Set(['STOPPING', 'PREPARING', 'COMPACTING', 'RECOVERING']);
    const NS = 'ricePatrol';
    const zh = {
      'settings.aria': 'Rice Patrol 设置',
      'settings.title': 'Rice Patrol · 重复输出保护',
      'settings.intro': '选择检测到持续短句重复时的处理方式。此设置不处理普通的输出 token 上限。',
      'settings.mode': '处理模式',
      'settings.observe': '仅观察：记录，不停止',
      'settings.stop': '停止：确认重复后截断',
      'settings.recover': '恢复：截断、整理交接并继续',
      'settings.limits': '恢复有固定次数和超时上限；遇到不确定的工具或后台任务会停止并提示。',
      'settings.readOnly': '当前设置不可写。',
      'settings.saved': '已保存。重启 DSH Web 后，新的模式才会生效；正在运行的任务不变。',
      'settings.saveFailed': '保存失败。请检查连接和设置写入权限。',
      'status.aria': '任务恢复状态',
      'status.title': '任务恢复 · {state}',
      'status.reason': '原因：{reason}',
      'status.requests': '恢复请求 {count}',
      'status.compactCalls': '交接整理 {count}',
      'status.child': '查看恢复会话与结果',
      'status.stop': '停止恢复',
      'status.stopping': '正在请求停止…',
      'status.dismiss': '关闭提醒',
      'status.dismissing': '正在关闭…',
      'status.stopFailed': '停止请求未成功，请重试。',
      'status.noLongerRunning': '此恢复已不在运行，等待状态更新。',
      'status.stopRequested': '已请求停止，等待恢复任务结束。',
      'status.connectionFailed': '连接未完成，请检查连接后重试。',
      'status.dismissFailed': '暂时无法关闭提醒，请刷新后重试。',
      'status.readFailed': '恢复状态暂时无法读取；已有状态可能已过期。',
      'state.STOPPING': '正在停止原请求', 'state.PREPARING': '正在准备恢复',
      'state.COMPACTING': '正在整理恢复交接', 'state.RECOVERING': '正在恢复任务',
      'state.COMPLETED': '恢复已完成', 'state.FAILED': '恢复未完成',
      'state.STOPPED': '恢复已停止', 'state.INTERRUPTED': '恢复已中断',
      'state.BLOCKED': '恢复需要处理', 'state.OBSERVED': '已记录重复信号',
      'reason.USER_INTERRUPTED': '你已停止恢复，或提交了新的任务',
      'reason.PARENT_CANCELLED': '恢复已随原任务停止',
      'reason.STREAM_CLEANUP_UNSETTLED': '原请求的流尚未完成退出，恢复已停止',
      'reason.RECOVERY_ROUTE_MISMATCH': '模型配置已改变，恢复已停止',
      'reason.EXTERNAL_TOOL_RECONCILIATION_REQUIRED': '需要确认此前工具或后台任务的状态',
      'reason.JOB_REGISTRY_UNAVAILABLE': '无法读取后台任务状态，恢复已停止',
      'reason.ACTIVE_OR_UNREPORTED_JOB': '还有未结束或未确认结果的后台任务，请先处理',
      'reason.TOOL_REPORTED_ERROR': '此前工具曾报错，需要确认结果',
      'reason.MANDATORY_FACTS_TOO_LARGE': '交接中的必要记录超过长度上限，未启动新 Agent',
      'reason.UNSUPPORTED_USER_CONTENT': '原任务包含暂不支持的附件或内容，未启动新 Agent',
      'reason.USER_IMAGE_LIMIT': '原任务中的图片超过安全交接上限，未启动新 Agent',
      'reason.USER_IMAGE_UNAVAILABLE': '无法核验原任务中的图片，未启动新 Agent',
      'reason.USER_IMAGE_HANDOFF_MISMATCH': '图片交接记录不一致，未启动新 Agent',
      'reason.TOOL_REPLAY_OR_UNIDENTIFIED': '已阻止可能重复的操作',
      'reason.SECOND_GUARD_CONFIRMATION': '恢复后再次检测到重复，已停止',
      'reason.HOST_RESTARTED': '应用重启，自动恢复未继续',
      'reason.STOP_TIMEOUT': '原请求未能及时结束，恢复已停止',
      'reason.RESUME_TIMEOUT': '恢复已达到时间上限',
      'reason.COMPACTION_TIMEOUT': '整理恢复交接已达到时间上限',
      'reason.RESUME_REQUEST_BUDGET': '恢复已达到请求次数上限',
      'reason.RESUME_TOOL_BUDGET': '恢复已达到工具调用次数上限',
      'reason.COMPACTION_REQUEST_BUDGET': '整理恢复交接已达到请求次数上限',
      'reason.REPETITION_CONFIRMED': '已确认重复，正在处理',
      'reason.USER_STOP': '你已停止恢复', 'reason.USER_CANCELLED': '你已取消恢复',
      'reason.NEW_USER_INPUT': '已收到新输入，之前的恢复已结束',
      'reason.PLUGIN_DISPOSED': '插件已关闭，恢复已停止',
      'reason.RECOVERY_FAILED': '恢复未能完成，请查看恢复会话',
      'reason.RECOVERY_COMPLETED': '恢复任务已完成',
      'reason.OBSERVE_ONLY': '观察模式已记录重复信号',
      'reason.unknown': '恢复已暂停，请查看恢复会话或联系维护者'
    };
    const en = {
      'settings.aria': 'Rice Patrol settings',
      'settings.title': 'Rice Patrol · Repetition guard',
      'settings.intro': 'Choose what happens when sustained short-line repetition is confirmed. This does not handle an ordinary output token limit.',
      'settings.mode': 'Response mode',
      'settings.observe': 'Observe: record without stopping',
      'settings.stop': 'Stop: interrupt confirmed repetition',
      'settings.recover': 'Recover: stop, compact, and continue',
      'settings.limits': 'Recovery has fixed time and call limits. It pauses when a tool result or background job cannot be verified.',
      'settings.readOnly': 'These settings are read-only.',
      'settings.saved': 'Saved. Restart DSH Web to apply the new mode. Running tasks keep their current mode.',
      'settings.saveFailed': 'Could not save. Check the connection and settings permissions.',
      'status.aria': 'Task recovery status',
      'status.title': 'Task recovery · {state}',
      'status.reason': 'Reason: {reason}',
      'status.requests': 'Recovery requests {count}',
      'status.compactCalls': 'Compactions {count}',
      'status.child': 'View recovery session and result',
      'status.stop': 'Stop recovery',
      'status.stopping': 'Requesting stop…',
      'status.dismiss': 'Dismiss reminder',
      'status.dismissing': 'Dismissing…',
      'status.stopFailed': 'The stop request failed. Try again.',
      'status.noLongerRunning': 'Recovery is no longer running. Waiting for the status to update.',
      'status.stopRequested': 'Stop requested. Waiting for recovery to end.',
      'status.connectionFailed': 'Connection did not complete. Check it and try again.',
      'status.dismissFailed': 'Could not dismiss the reminder. Refresh and try again.',
      'status.readFailed': 'Recovery status is temporarily unavailable. The displayed status may be stale.',
      'state.STOPPING': 'Stopping the original request', 'state.PREPARING': 'Preparing recovery',
      'state.COMPACTING': 'Compacting the handoff', 'state.RECOVERING': 'Recovering the task',
      'state.COMPLETED': 'Recovery completed', 'state.FAILED': 'Recovery did not complete',
      'state.STOPPED': 'Recovery stopped', 'state.INTERRUPTED': 'Recovery interrupted',
      'state.BLOCKED': 'Recovery needs attention', 'state.OBSERVED': 'Repetition recorded',
      'reason.USER_INTERRUPTED': 'You stopped recovery or sent a new task',
      'reason.PARENT_CANCELLED': 'Recovery stopped with the original task',
      'reason.STREAM_CLEANUP_UNSETTLED': 'The original stream did not finish closing; recovery stopped',
      'reason.RECOVERY_ROUTE_MISMATCH': 'The model configuration changed; recovery stopped',
      'reason.EXTERNAL_TOOL_RECONCILIATION_REQUIRED': 'Check the status of earlier tools or background jobs',
      'reason.JOB_REGISTRY_UNAVAILABLE': 'Background job status is unavailable; recovery stopped',
      'reason.ACTIVE_OR_UNREPORTED_JOB': 'A background job is still running or its result is unconfirmed',
      'reason.TOOL_REPORTED_ERROR': 'An earlier tool reported an error; check its result',
      'reason.MANDATORY_FACTS_TOO_LARGE': 'Required handoff records exceeded the size limit; no new Agent was started',
      'reason.UNSUPPORTED_USER_CONTENT': 'The original task contains an unsupported attachment or content block; no new Agent was started',
      'reason.USER_IMAGE_LIMIT': 'The original task contains too many images for safe handoff; no new Agent was started',
      'reason.USER_IMAGE_UNAVAILABLE': 'An original user image could not be verified; no new Agent was started',
      'reason.USER_IMAGE_HANDOFF_MISMATCH': 'The image handoff record did not match; no new Agent was started',
      'reason.TOOL_REPLAY_OR_UNIDENTIFIED': 'A possibly repeated operation was blocked',
      'reason.SECOND_GUARD_CONFIRMATION': 'Repetition was detected again after recovery; stopped',
      'reason.HOST_RESTARTED': 'The app restarted; automatic recovery did not continue',
      'reason.STOP_TIMEOUT': 'The original request did not stop in time',
      'reason.RESUME_TIMEOUT': 'Recovery reached its time limit',
      'reason.COMPACTION_TIMEOUT': 'Compaction reached its time limit',
      'reason.RESUME_REQUEST_BUDGET': 'Recovery reached its model request limit',
      'reason.RESUME_TOOL_BUDGET': 'Recovery reached its tool call limit',
      'reason.COMPACTION_REQUEST_BUDGET': 'Compaction reached its request limit',
      'reason.REPETITION_CONFIRMED': 'Repetition confirmed; processing',
      'reason.USER_STOP': 'You stopped recovery', 'reason.USER_CANCELLED': 'You cancelled recovery',
      'reason.NEW_USER_INPUT': 'New input received; the earlier recovery ended',
      'reason.PLUGIN_DISPOSED': 'The plugin was disabled; recovery stopped',
      'reason.RECOVERY_FAILED': 'Recovery could not finish; inspect the recovery session',
      'reason.RECOVERY_COMPLETED': 'The recovered task completed',
      'reason.OBSERVE_ONLY': 'Observe mode recorded a repetition signal',
      'reason.unknown': 'Recovery paused. Inspect the recovery session or contact the maintainer'
    };
    const reasonText = (reason, t) => Object.hasOwn(zh, `reason.${reason}`)
      ? t(`reason.${reason}`) : /^[A-Z0-9_-]+$/.test(reason) ? t('reason.unknown') : reason;
    const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,180}$/.test(value);
    function readStatus(d) {
      if (!d || d.schema !== 1 || !id(d.episodeId) || typeof d.state !== 'string' ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(d.state)) return null;
      const value = {schema: 1, episodeId: d.episodeId, state: d.state.toUpperCase()};
      if (typeof d.reason === 'string' && d.reason.length <= 240) value.reason = d.reason;
      if (id(d.childSessionId)) value.childSessionId = d.childSessionId;
      for (const key of ['requests', 'compactCalls'])
        if (Number.isSafeInteger(d[key]) && d[key] >= 0) value[key] = d[key];
      return value;
    }
    function readEpisodes(value) {
      if (!value || value.schema !== 1 || !Array.isArray(value.episodes)) return null;
      const result = [];
      const seen = new Set();
      for (const raw of value.episodes.slice(-5)) {
        const data = readStatus(raw);
        if (!data || seen.has(data.episodeId)) continue;
        seen.add(data.episodeId); result.push(data);
      }
      return result;
    }
    const style = {
      card: {border: '1px solid var(--dsw-alias-border-l1, #7775)', borderRadius: 12,
        padding: '12px 14px', margin: '8px 0', color: 'var(--dsw-alias-label-primary, inherit)'},
      title: {fontSize: 14, fontWeight: 600},
      text: {fontSize: 12, marginTop: 6, opacity: .8, overflowWrap: 'anywhere'},
      actions: {display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 10},
      button: {font: 'inherit', fontSize: 12, padding: '5px 9px', borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l1, #7777)', color: 'inherit', background: 'transparent', cursor: 'pointer'}
    };
    function ModeSettingsPage({scope, t}) {
      const [snapshot, setSnapshot] = useState(() => scope.getSnapshot());
      const [pending, setPending] = useState(false);
      const [notice, setNotice] = useState('');
      useEffect(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope]);
      const mode = ['observe', 'stop', 'recover'].includes(snapshot.value?.mode) ? snapshot.value.mode : 'stop';
      async function choose(event) {
        const next = event.target.value;
        if (!['observe', 'stop', 'recover'].includes(next) || pending || next === mode) return;
        setPending(true); setNotice('');
        try {
          await scope.set('mode', next);
          setNotice('settings.saved');
        } catch {
          setNotice('settings.saveFailed');
        } finally { setPending(false); }
      }
      return h('section', {'aria-label': t('settings.aria'), style: style.card},
        h('div', {style: style.title}, t('settings.title')),
        h('p', {style: style.text}, t('settings.intro')),
        h('label', {style: style.text, htmlFor: 'rice-patrol-mode'}, t('settings.mode')),
        h('select', {id: 'rice-patrol-mode', 'aria-label': t('settings.mode'), value: mode,
          disabled: pending || !snapshot.writable || snapshot.status !== 'ready', onChange: choose,
          style: {...style.button, display: 'block', marginTop: 6, minWidth: 220}},
          h('option', {value: 'observe'}, t('settings.observe')),
          h('option', {value: 'stop'}, t('settings.stop')),
          h('option', {value: 'recover'}, t('settings.recover'))),
        h('p', {style: style.text}, t('settings.limits')),
        !snapshot.writable ? h('p', {role: 'status', style: style.text}, t('settings.readOnly')) : null,
        notice ? h('p', {role: 'status', style: style.text}, t(notice)) : null);
    }
    function createPanel(ctx, t) {
      function StatusCard({data, sessionId, refresh}) {
        const [pending, setPending] = useState(false);
        const [notice, setNotice] = useState('');
        const alive = useRef(true);
        const actionRequest = useRef(null);
        useEffect(() => {
          alive.current = true;
          return () => { alive.current = false; actionRequest.current?.abort(); };
        }, []);
        useEffect(() => { setNotice(''); }, [data.state]);
        const active = ACTIVE.has(data.state);
        async function stop() {
          if (pending || !active) return;
          setPending(true); setNotice('');
          const controller = new AbortController();
          actionRequest.current = controller;
          const timeout = setTimeout(() => controller.abort(), 5000);
          try {
            const response = await ctx.connection.rpc.call('/api', 'research-guard/stop',
              {sessionId, episodeId: data.episodeId}, controller.signal);
            if (!alive.current) return;
            if (!response?.ok) setNotice('status.stopFailed');
            else if (response.value?.accepted === false) setNotice('status.noLongerRunning');
            else setNotice('status.stopRequested');
            refresh();
          } catch {
            if (alive.current) setNotice('status.connectionFailed');
          } finally {
            clearTimeout(timeout);
            if (actionRequest.current === controller) actionRequest.current = null;
            if (alive.current) setPending(false);
          }
        }
        async function dismiss() {
          if (pending || active) return;
          setPending(true); setNotice('');
          const controller = new AbortController();
          actionRequest.current = controller;
          const timeout = setTimeout(() => controller.abort(), 5000);
          try {
            const response = await ctx.connection.rpc.call('/api', 'research-guard/dismiss',
              {sessionId, episodeId: data.episodeId}, controller.signal);
            if (!alive.current) return;
            if (response?.ok && response.value?.dismissed === true) refresh();
            else setNotice('status.dismissFailed');
          } catch {
            if (alive.current) setNotice('status.connectionFailed');
          } finally {
            clearTimeout(timeout);
            if (actionRequest.current === controller) actionRequest.current = null;
            if (alive.current) setPending(false);
          }
        }
        const stateKey = `state.${data.state}`;
        const stateText = Object.hasOwn(zh, stateKey) ? t(stateKey) : data.state;
        const children = [h('div', {key: 'title', style: style.title}, t('status.title', {state: stateText}))];
        if (data.reason) children.push(h('div', {key: 'reason', style: style.text, title: data.reason},
          t('status.reason', {reason: reasonText(data.reason, t)})));
        const counts = [];
        if (data.requests !== undefined) counts.push(t('status.requests', {count: data.requests}));
        if (data.compactCalls !== undefined) counts.push(t('status.compactCalls', {count: data.compactCalls}));
        if (counts.length) children.push(h('div', {key: 'counts', style: style.text}, counts.join(' · ')));
        const actions = [];
        if (data.childSessionId) actions.push(h('button', {key: 'child', type: 'button', style: style.button,
          onClick: () => ctx.uiWorkspace.openSession({childSessionId: data.childSessionId,
            parentSessionId: sessionId, mode: 'one-shot'})}, t('status.child')));
        if (active) actions.push(h('button', {key: 'stop', type: 'button', disabled: pending,
          style: style.button, onClick: stop}, t(pending ? 'status.stopping' : 'status.stop')));
        else actions.push(h('button', {key: 'dismiss', type: 'button', disabled: pending,
          style: style.button, onClick: dismiss}, t(pending ? 'status.dismissing' : 'status.dismiss')));
        if (actions.length) children.push(h('div', {key: 'actions', style: style.actions}, actions));
        if (notice) children.push(h('div', {key: 'notice', role: 'status', style: style.text}, t(notice)));
        return h('section', {'aria-label': t('status.aria'), 'data-research-guard-episode': data.episodeId,
          'data-research-guard-state': data.state, style: style.card}, children);
      }
      return function RecoveryPanel({sessionId}) {
        const [view, setView] = useState({sessionId, episodes: [], error: false});
        const [revision, setRevision] = useState(0);
        useEffect(() => {
          let live = true, timer, request;
          if (!id(sessionId)) return;
          async function pull() {
            request = new AbortController();
            const timeout = setTimeout(() => request.abort(), 5000);
            try {
              const response = await ctx.connection.rpc.call('/api', 'research-guard/status', {sessionId}, request.signal);
              if (!live) return;
              const episodes = response?.ok ? readEpisodes(response.value) : null;
              if (episodes === null) setView(old => ({sessionId, episodes: old.sessionId === sessionId ? old.episodes : [], error: true}));
              else setView({sessionId, episodes, error: false});
            } catch {
              if (live) setView(old => ({sessionId, episodes: old.sessionId === sessionId ? old.episodes : [], error: true}));
            } finally {
              clearTimeout(timeout);
              if (live) timer = setTimeout(pull, 2000);
            }
          }
          pull();
          return () => { live = false; clearTimeout(timer); request?.abort(); };
        }, [sessionId, revision]);
        if (view.sessionId !== sessionId) return null;
        if (!view.episodes.length) return null;
        return h('div', {'data-research-guard-panel': 'true'},
          ...view.episodes.map(data => h(StatusCard, {key: `${sessionId}:${data.episodeId}`, data, sessionId,
            refresh: () => setRevision(n => n + 1)})),
          view.error ? h('div', {role: 'status', style: style.text}, t('status.readFailed')) : null);
      };
    }
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, {zh, en}), 'rice-patrol translations');
      const t = ctx.locale.bind(NS);
      // A public additive slot; no replacement of composer or transcript.
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
        {name: 'conversation.input.dock', id: 'research-guard-status', order: 30, locale: NS},
        createPanel(ctx, t)));
      const scope = ctx.settingsScope.bind({namespace: 'rice-patrol'});
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
        {name: 'plugins.bundle.config', key: 'dsh-rice-patrol', locale: NS},
        seat => seat.view === 'page' ? h(ModeSettingsPage, {scope, t}) : null));
    }
    return {inject: ['slots', 'connection', 'uiWorkspace', 'settingsScope', 'locale'], apply};
  }
});
