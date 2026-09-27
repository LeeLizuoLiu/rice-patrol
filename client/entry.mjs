/* DSH client module. React is supplied by the host module loader. */
window.__ModuleLoader__.load({
  id: 'dsh-rice-patrol',
  factory(require) {
    const {createElement: h, useState, useEffect, useRef} = require('react');
    const ACTIVE = new Set(['STOPPING', 'PREPARING', 'COMPACTING', 'RECOVERING']);
    const labels = {
      STOPPING: '正在停止原请求', PREPARING: '正在准备恢复', COMPACTING: '正在整理恢复交接',
      RECOVERING: '正在恢复任务', COMPLETED: '恢复已完成', FAILED: '恢复未完成',
      STOPPED: '恢复已停止', INTERRUPTED: '恢复已中断', BLOCKED: '恢复需要处理',
      OBSERVED: '已记录重复信号'
    };
    const reasons = {
      USER_INTERRUPTED: '你已停止恢复，或提交了新的任务', PARENT_CANCELLED: '恢复已随原任务停止',
      STREAM_CLEANUP_UNSETTLED: '原请求的流尚未完成退出，恢复已停止',
      RECOVERY_ROUTE_MISMATCH: '模型配置已改变，恢复已停止',
      EXTERNAL_TOOL_RECONCILIATION_REQUIRED: '需要确认此前工具或后台任务的状态',
      JOB_REGISTRY_UNAVAILABLE: '无法读取后台任务状态，恢复已停止',
      ACTIVE_OR_UNREPORTED_JOB: '还有未结束或未确认结果的后台任务，请先处理',
      TOOL_REPORTED_ERROR: '此前工具曾报错，需要确认结果',
      TOOL_REPLAY_OR_UNIDENTIFIED: '已阻止可能重复的操作',
      SECOND_GUARD_CONFIRMATION: '恢复后再次检测到重复，已停止',
      HOST_RESTARTED: '应用重启，自动恢复未继续',
      STOP_TIMEOUT: '原请求未能及时结束，恢复已停止',
      RESUME_TIMEOUT: '恢复已达到时间上限',
      COMPACTION_TIMEOUT: '整理恢复交接已达到时间上限',
      RESUME_REQUEST_BUDGET: '恢复已达到请求次数上限',
      RESUME_TOOL_BUDGET: '恢复已达到工具调用次数上限',
      COMPACTION_REQUEST_BUDGET: '整理恢复交接已达到请求次数上限',
      REPETITION_CONFIRMED: '已确认重复，正在处理',
      USER_STOP: '你已停止恢复',
      USER_CANCELLED: '你已取消恢复',
      NEW_USER_INPUT: '已收到新输入，之前的恢复已结束',
      PLUGIN_DISPOSED: '插件已关闭，恢复已停止',
      RECOVERY_FAILED: '恢复未能完成，请查看恢复会话',
      RECOVERY_COMPLETED: '恢复任务已完成',
      OBSERVE_ONLY: '观察模式已记录重复信号'
    };
    const reasonText = reason => reasons[reason] ?? (/^[A-Z0-9_-]+$/.test(reason)
      ? '恢复已暂停，请查看恢复会话或联系维护者' : reason);
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
    function ModeSettingsPage({scope}) {
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
          setNotice('已保存。重启 DSH Web 后，新的模式才会生效；正在运行的任务不变。');
        } catch {
          setNotice('保存失败。请检查连接和设置写入权限。');
        } finally { setPending(false); }
      }
      return h('section', {'aria-label': 'Rice Patrol 设置', style: style.card},
        h('div', {style: style.title}, 'Rice Patrol · 重复输出保护'),
        h('p', {style: style.text}, '选择检测到持续短句重复时的处理方式。此设置不处理普通的输出 token 上限。'),
        h('label', {style: style.text, htmlFor: 'rice-patrol-mode'}, '处理模式'),
        h('select', {id: 'rice-patrol-mode', 'aria-label': '处理模式', value: mode,
          disabled: pending || !snapshot.writable || snapshot.status !== 'ready', onChange: choose,
          style: {...style.button, display: 'block', marginTop: 6, minWidth: 220}},
          h('option', {value: 'observe'}, '仅观察：记录，不停止'),
          h('option', {value: 'stop'}, '停止：确认重复后截断'),
          h('option', {value: 'recover'}, '恢复：截断、整理交接并继续')),
        h('p', {style: style.text}, '恢复有固定次数和超时上限；遇到不确定的工具或后台任务会停止并提示。'),
        !snapshot.writable ? h('p', {role: 'status', style: style.text}, '当前设置不可写。') : null,
        notice ? h('p', {role: 'status', style: style.text}, notice) : null);
    }
    function createPanel(ctx) {
      function StatusCard({data, sessionId, refresh}) {
        const [pending, setPending] = useState(false);
        const [notice, setNotice] = useState('');
        const alive = useRef(true);
        const stopRequest = useRef(null);
        useEffect(() => {
          alive.current = true;
          return () => { alive.current = false; stopRequest.current?.abort(); };
        }, []);
        useEffect(() => { setNotice(''); }, [data.state]);
        const active = ACTIVE.has(data.state);
        async function stop() {
          if (pending || !active) return;
          setPending(true); setNotice('');
          const controller = new AbortController();
          stopRequest.current = controller;
          const timeout = setTimeout(() => controller.abort(), 5000);
          try {
            const response = await ctx.connection.rpc.call('/api', 'research-guard/stop',
              {sessionId, episodeId: data.episodeId}, controller.signal);
            if (!alive.current) return;
            if (!response?.ok) setNotice('停止请求未成功，请重试。');
            else if (response.value?.accepted === false) setNotice('此恢复已不在运行，等待状态更新。');
            else setNotice('已请求停止，等待恢复任务结束。');
            refresh();
          } catch {
            if (alive.current) setNotice('连接未完成，请检查连接后重试。');
          } finally {
            clearTimeout(timeout);
            if (stopRequest.current === controller) stopRequest.current = null;
            if (alive.current) setPending(false);
          }
        }
        const children = [h('div', {key: 'title', style: style.title}, `任务恢复 · ${labels[data.state] ?? data.state}`)];
        if (data.reason) children.push(h('div', {key: 'reason', style: style.text, title: data.reason}, `原因：${reasonText(data.reason)}`));
        const counts = [];
        if (data.requests !== undefined) counts.push(`恢复请求 ${data.requests}`);
        if (data.compactCalls !== undefined) counts.push(`交接整理 ${data.compactCalls}`);
        if (counts.length) children.push(h('div', {key: 'counts', style: style.text}, counts.join(' · ')));
        const actions = [];
        if (data.childSessionId) actions.push(h('button', {key: 'child', type: 'button', style: style.button,
          onClick: () => ctx.uiWorkspace.openSession({childSessionId: data.childSessionId,
            parentSessionId: sessionId, mode: 'one-shot'})}, '查看恢复会话与结果'));
        if (active) actions.push(h('button', {key: 'stop', type: 'button', disabled: pending,
          style: style.button, onClick: stop}, pending ? '正在请求停止…' : '停止恢复'));
        if (actions.length) children.push(h('div', {key: 'actions', style: style.actions}, actions));
        if (notice) children.push(h('div', {key: 'notice', role: 'status', style: style.text}, notice));
        return h('section', {'aria-label': '任务恢复状态', 'data-research-guard-episode': data.episodeId,
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
          view.error ? h('div', {role: 'status', style: style.text}, '恢复状态暂时无法读取；已有状态可能已过期。') : null);
      };
    }
    function apply(ctx) {
      // A public additive slot; no replacement of composer or transcript.
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
        {name: 'conversation.input.dock', id: 'research-guard-status', order: 30}, createPanel(ctx)));
      const scope = ctx.settingsScope.bind({namespace: 'rice-patrol'});
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
        {name: 'plugins.bundle.config', key: 'dsh-rice-patrol'},
        seat => seat.view === 'page' ? h(ModeSettingsPage, {scope}) : null));
    }
    return {inject: ['slots', 'connection', 'uiWorkspace', 'settingsScope'], apply};
  }
});
