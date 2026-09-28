import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./entry.mjs', import.meta.url), 'utf8');
function fixture(initial) {
  const calls = [], opened = [], timers = new Map();
  let current, bundle, Panel, SettingsPage, nextTimer = 0, activeLocale = 'zh', dictionaries;
  let settingsSnapshot = {status: 'ready', writable: true, value: {mode: 'recover'}};
  const settingsListeners = new Set(), settingsWrites = [];
  const React = {
    createElement: (type, props, ...children) => ({type, props: props ?? {}, children}),
    useState(value) {
      const c = current, at = c.index++;
      if (!(at in c.cells)) c.cells[at] = typeof value === 'function' ? value() : value;
      return [c.cells[at], value => { c.cells[at] = typeof value === 'function' ? value(c.cells[at]) : value; }];
    },
    useRef(value) {
      const c = current, at = c.index++;
      return c.cells[at] ??= {current: value};
    },
    useEffect(fn, deps) {
      const c = current, at = c.index++, before = c.cells[at];
      if (!before || deps.some((value, i) => value !== before.deps[i])) {
        before?.cleanup?.(); c.effects.push(() => {c.cells[at] = {deps, cleanup: fn()};});
      }
    }
  };
  const context = {
    window: {__ModuleLoader__: {load(value) {bundle = value;}}}, AbortController,
    setTimeout: (fn, ms) => {const n = ++nextTimer; timers.set(n, {fn, ms}); return n;},
    clearTimeout: n => timers.delete(n)
  };
  vm.runInNewContext(source, context);
  let response = initial;
  const ctx = {
    effect: fn => fn(),
    locale: {
      register(namespace, value) {
        assert.equal(namespace, 'ricePatrol');
        assert.deepEqual(Object.keys(value.zh).sort(), Object.keys(value.en).sort());
        dictionaries = value;
        return () => {dictionaries = undefined;};
      },
      bind(namespace) {
        assert.equal(namespace, 'ricePatrol');
        return (key, params) => {
          const template = dictionaries[activeLocale][key];
          assert.equal(typeof template, 'string', `Missing ${activeLocale} translation: ${key}`);
          return template.replace(/\{(\w+)\}/g, (match, name) => String(params?.[name] ?? match));
        };
      }
    },
    slots: {inject: (_name, fn) => fn(), register: (meta, component) => {
      assert.equal(meta.locale, 'ricePatrol');
      if (meta.name === 'conversation.input.dock') Panel = component;
      else if (meta.name === 'plugins.bundle.config') SettingsPage = component;
      else assert.fail(`Unexpected slot ${meta.name}`);
    }},
    settingsScope: {bind: ({namespace}) => {assert.equal(namespace, 'rice-patrol'); return {
      getSnapshot: () => settingsSnapshot,
      subscribe: fn => {settingsListeners.add(fn); return () => settingsListeners.delete(fn)},
      async set(field, value) {
        settingsWrites.push({field, value});
        settingsSnapshot = {...settingsSnapshot, value: {...settingsSnapshot.value, [field]: value}};
        for (const listener of settingsListeners) listener();
      }
    }}},
    connection: {rpc: {async call(channel, endpoint, payload, signal) {
      calls.push({channel, endpoint, payload: JSON.parse(JSON.stringify(payload)), signal});
      return endpoint === 'research-guard/status' ? response : endpoint === 'research-guard/dismiss'
        ? {ok: true, value: {dismissed: true}} : {ok: true, value: {accepted: true}};
    }}},
    uiWorkspace: {openSession: address => opened.push(JSON.parse(JSON.stringify(address)))}
  };
  assert.equal(bundle.id, 'dsh-rice-patrol');
  const exports = bundle.factory(name => {assert.equal(name, 'react'); return React;});
  exports.apply(ctx);
  const mount = (Component, props) => {
    const c = {cells: [], effects: [], index: 0};
    return {
      render(next = props) {props = next; c.index = 0; current = c; const tree = Component(props); c.effects.splice(0).forEach(fn => fn()); return tree;},
      unmount() {for (const cell of c.cells) cell?.cleanup?.();}
    };
  };
  return {mount, Panel, SettingsPage, calls, opened, timers, settingsWrites,
    setLocale(locale) {assert.ok(['zh', 'en'].includes(locale)); activeLocale = locale;},
    setResponse(value) {response = value;}, setSettingsSnapshot(value) {
      settingsSnapshot = value; for (const listener of settingsListeners) listener();
    }};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const ok = episodes => ({ok: true, value: {schema: 1, episodes}});
const episode = (state, extra = {}) => ({schema: 1, episodeId: 'episode-1', state, ...extra});
const flatten = tree => Array.isArray(tree) ? tree.flatMap(flatten) : !tree || typeof tree !== 'object' ? [tree] : [tree, ...(tree.children ?? []).flatMap(flatten)];

test('mode card offers three choices and saves only the selected mode in DSH settings', async () => {
  const f = fixture(ok([]));
  const element = f.SettingsPage({view: 'page'});
  const page = f.mount(element.type, element.props);
  let tree = page.render();
  let select = flatten(tree).find(x => x?.type === 'select');
  assert.deepEqual(flatten(select).filter(x => x?.type === 'option').map(x => x.props.value),
    ['observe', 'stop', 'recover']);
  assert.equal(select.props.value, 'recover');
  await select.props.onChange({target: {value: 'stop'}});
  tree = page.render(); select = flatten(tree).find(x => x?.type === 'select');
  assert.equal(select.props.value, 'stop');
  assert.deepEqual(f.settingsWrites, [{field: 'mode', value: 'stop'}]);
  assert.ok(flatten(tree).some(x => typeof x === 'string' && x.includes('重启 DSH Web')));
  f.setLocale('en');
  tree = page.render();
  assert.equal(tree.props['aria-label'], 'Rice Patrol settings');
  assert.ok(flatten(tree).some(x => x === 'Response mode'));
  assert.ok(flatten(tree).some(x => x === 'Stop: interrupt confirmed repetition'));
  assert.ok(flatten(tree).some(x => typeof x === 'string' && x.includes('Restart DSH Web')));
  page.unmount();
});

test('polls only sidecar RPC, one card per episode, stops exact session/episode, navigates native one-shot child', async () => {
  const f = fixture(ok([episode('RECOVERING', {childSessionId: 'child-1', requests: 2})]));
  const panel = f.mount(f.Panel, {sessionId: 'parent-1'}); panel.render(); await tick();
  const tree = panel.render();
  const cardElement = tree.children[0];
  const card = f.mount(cardElement.type, cardElement.props); card.render();
  f.setLocale('en');
  const cardTree = card.render();
  const buttons = flatten(cardTree).filter(x => x?.type === 'button');
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].children[0], 'View recovery session and result');
  assert.equal(buttons[1].children[0], 'Stop recovery');
  assert.ok(flatten(cardTree).some(x => x === 'Recovery requests 2'));
  buttons[0].props.onClick();
  assert.deepEqual(f.opened, [{childSessionId: 'child-1', parentSessionId: 'parent-1', mode: 'one-shot'}]);
  await buttons[1].props.onClick();
  assert.deepEqual(f.calls.at(-1).payload, {sessionId: 'parent-1', episodeId: 'episode-1'});
  assert.equal(f.calls.at(-1).endpoint, 'research-guard/stop');
  assert.ok(f.calls.every(c => c.channel === '/api'));
  card.unmount(); panel.unmount(); assert.equal(f.timers.size, 0);
});

test('terminal state has a dismiss control, no stop control, and escapes text as React content', async () => {
  const f = fixture(ok([episode('FAILED', {reason: '<script>not-executed</script>'})]));
  const panel = f.mount(f.Panel, {sessionId: 'parent-1'}); panel.render(); await tick();
  const element = panel.render().children[0];
  const card = f.mount(element.type, element.props); const tree = card.render();
  const buttons = flatten(tree).filter(x => x?.type === 'button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].children[0], '关闭提醒');
  assert.ok(flatten(tree).some(x => typeof x === 'string' && x.includes('<script>')));
  assert.ok(!flatten(tree).some(x => x?.props?.dangerouslySetInnerHTML));
  f.setLocale('en');
  const english = card.render();
  assert.equal(english.props['aria-label'], 'Task recovery status');
  assert.ok(flatten(english).some(x => x === 'Task recovery · Recovery did not complete'));
  assert.equal(flatten(english).find(x => x?.type === 'button').children[0], 'Dismiss reminder');
  await buttons[0].props.onClick();
  assert.deepEqual(f.calls.at(-1).payload, {sessionId: 'parent-1', episodeId: 'episode-1'});
  assert.equal(f.calls.at(-1).endpoint, 'research-guard/dismiss');
  f.setResponse(ok([]));
  panel.render(); await tick();
  assert.equal(panel.render(), null);
  card.unmount(); panel.unmount();
});

test('known recovery reasons translate with DSH locale, and unknown codes use a safe fallback', async () => {
  const f = fixture(ok([episode('BLOCKED', {reason: 'EXTERNAL_TOOL_RECONCILIATION_REQUIRED'})]));
  const panel = f.mount(f.Panel, {sessionId: 'parent-1'}); panel.render(); await tick();
  const element = panel.render().children[0];
  const card = f.mount(element.type, element.props);
  assert.ok(flatten(card.render()).some(x => x === '原因：需要确认此前工具或后台任务的状态'));
  f.setLocale('en');
  assert.ok(flatten(card.render()).some(x => x === 'Reason: Check the status of earlier tools or background jobs'));
  card.render({...element.props, data: episode('BLOCKED', {reason: 'MANDATORY_FACTS_TOO_LARGE'})});
  assert.ok(flatten(card.render()).some(x => x === 'Reason: Required handoff records exceeded the size limit; the main Agent was not resumed'));
  card.render({...element.props, data: episode('BLOCKED', {reason: 'UNSUPPORTED_USER_CONTENT'})});
  assert.ok(flatten(card.render()).some(x => x === 'Reason: The original task contains an unsupported attachment or content block; the main Agent was not resumed'));
  f.setLocale('zh');
  assert.ok(flatten(card.render()).some(x => x === '原因：原任务包含暂不支持的附件或内容，主 Agent 没有接续'));
  card.render({...element.props, data: episode('BLOCKED', {reason: 'COMPACTION_INCOMPLETE'})});
  assert.ok(flatten(card.render()).some(x => x === '原因：整理上下文的模型请求未正常完成，主 Agent 没有接续'));
  f.setLocale('en');
  assert.ok(flatten(card.render()).some(x => x === 'Reason: The context compaction request did not finish normally; the main Agent was not resumed'));
  card.render({...element.props, data: episode('BLOCKED', {reason: 'RECOVERY_ALREADY_USED_THIS_TURN'})});
  assert.ok(flatten(card.render()).some(x => x === 'Reason: Recovery was already attempted in this turn; a later user turn can recover again'));
  f.setLocale('zh');
  assert.ok(flatten(card.render()).some(x => x === '原因：本轮对话已尝试恢复；下一轮用户消息可再次自动恢复'));
  f.setLocale('en');
  card.render({...element.props, data: episode('BLOCKED', {reason: 'NEW_UNRECOGNIZED_REASON'})});
  assert.ok(flatten(card.render()).some(x => x === 'Reason: Recovery paused. Inspect the current session'));
  card.unmount(); panel.unmount();
});

test('a completed deterministic fallback is explicitly shown in both interface languages',async()=>{
  const f=fixture(ok([episode('COMPLETED',{compactionFallback:'max-tokens'})]));
  const panel=f.mount(f.Panel,{sessionId:'parent-1'});panel.render();await tick();
  const element=panel.render().children[0];const card=f.mount(element.type,element.props);
  assert.ok(flatten(card.render()).some(x=>x==='整理达到输出上限；已弃用半截摘要，改用已核验记录继续'));
  f.setLocale('en');
  assert.ok(flatten(card.render()).some(x=>x==='Compaction reached its output limit; the partial summary was discarded and verified records were used'));
  card.unmount();panel.unmount();
});

test('session switch drops old visible cards and aborts old polling; malformed payload cannot become a card', async () => {
  const f = fixture(ok([episode('COMPLETED')]));
  const panel = f.mount(f.Panel, {sessionId: 'parent-1'}); panel.render(); await tick(); panel.render();
  const oldSignal = f.calls[0].signal;
  f.setResponse(ok([{schema: 1, episodeId: 'bad/id', state: 'RECOVERING'}]));
  assert.equal(panel.render({sessionId: 'parent-2'}), null);
  assert.equal(oldSignal.aborted, true);
  await tick(); assert.equal(panel.render(), null);
  panel.unmount(); assert.equal(f.timers.size, 0);
});

test('limits response to five snapshots and ignores duplicate episode IDs', async () => {
  const episodes = Array.from({length: 10}, (_, i) => ({...episode('OBSERVED'), episodeId: `ep-${i}`}));
  const f = fixture(ok(episodes)); const panel = f.mount(f.Panel, {sessionId: 'parent-1'});
  panel.render(); await tick(); const tree = panel.render();
  assert.equal(tree.children.filter(x => typeof x?.type === 'function').length, 5);
  panel.unmount();
});
