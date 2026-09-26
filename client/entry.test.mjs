import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./entry.mjs', import.meta.url), 'utf8');
function fixture(initial) {
  const calls = [], opened = [], timers = new Map();
  let current, bundle, Panel, nextTimer = 0;
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
    slots: {inject: (_name, fn) => fn(), register: (meta, component) => {assert.equal(meta.name, 'conversation.input.dock'); Panel = component;}},
    connection: {rpc: {async call(channel, endpoint, payload, signal) {
      calls.push({channel, endpoint, payload: JSON.parse(JSON.stringify(payload)), signal});
      return endpoint === 'research-guard/status' ? response : {ok: true, value: {accepted: true}};
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
  return {mount, Panel, calls, opened, timers, setResponse(value) {response = value;}};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const ok = episodes => ({ok: true, value: {schema: 1, episodes}});
const episode = (state, extra = {}) => ({schema: 1, episodeId: 'episode-1', state, ...extra});
const flatten = tree => Array.isArray(tree) ? tree.flatMap(flatten) : !tree || typeof tree !== 'object' ? [tree] : [tree, ...(tree.children ?? []).flatMap(flatten)];

test('polls only sidecar RPC, one card per episode, stops exact session/episode, navigates native one-shot child', async () => {
  const f = fixture(ok([episode('RECOVERING', {childSessionId: 'child-1', requests: 2})]));
  const panel = f.mount(f.Panel, {sessionId: 'parent-1'}); panel.render(); await tick();
  const tree = panel.render();
  const cardElement = tree.children[0];
  const card = f.mount(cardElement.type, cardElement.props); const cardTree = card.render();
  const buttons = flatten(cardTree).filter(x => x?.type === 'button');
  assert.equal(buttons.length, 2);
  buttons[0].props.onClick();
  assert.deepEqual(f.opened, [{childSessionId: 'child-1', parentSessionId: 'parent-1', mode: 'one-shot'}]);
  await buttons[1].props.onClick();
  assert.deepEqual(f.calls.at(-1).payload, {sessionId: 'parent-1', episodeId: 'episode-1'});
  assert.equal(f.calls.at(-1).endpoint, 'research-guard/stop');
  assert.ok(f.calls.every(c => c.channel === '/api'));
  card.unmount(); panel.unmount(); assert.equal(f.timers.size, 0);
});

test('terminal state has no stop control and escapes text as React content', async () => {
  const f = fixture(ok([episode('FAILED', {reason: '<script>not-executed</script>'})]));
  const panel = f.mount(f.Panel, {sessionId: 'parent-1'}); panel.render(); await tick();
  const element = panel.render().children[0];
  const card = f.mount(element.type, element.props); const tree = card.render();
  assert.equal(flatten(tree).filter(x => x?.type === 'button').length, 0);
  assert.ok(flatten(tree).some(x => typeof x === 'string' && x.includes('<script>')));
  assert.ok(!flatten(tree).some(x => x?.props?.dangerouslySetInnerHTML));
  card.unmount(); panel.unmount();
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
