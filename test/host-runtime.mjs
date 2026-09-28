// Minimal real DSH composition: no credentials, titles, telemetry, loaders or file stores.
import { createRequire } from 'node:module';
const fromRepo = createRequire(import.meta.url);
const requireHost = createRequire(fromRepo.resolve('@deepseek-ai/dsh-agent-loop/package.json'));
export const host = name => import(requireHost.resolve(name));
export async function createHost() {
  const { Context } = await host('@deepseek-ai/cordis');
  const ctx = new Context();
  const events = new Map();
  ctx.on('session/event', (session, event) => {
    const list = events.get(session.id) ?? [];
    list.push(event); events.set(session.id, list);
  });
  const fibers = [];
  for (const [pkg, config] of [
    ['dsh-agent', {}], ['dsh-session', {}], ['dsh-session-projection', {}],['dsh-token-meter', {}],
    ['dsh-system-prompt', {includeRuntimeContext:false}], ['dsh-tools', {mode:'native'}],
    ['dsh-llm', {}], ['dsh-agent-loop', {agents:[]}], ['dsh-llm-retry', {}]
  ]) {
    const mod = await host(`@deepseek-ai/${pkg}`);
    const fiber = await ctx.plugin(mod.default ?? mod, config);
    fibers.push(fiber);
  }
  return { ctx, events, async close() { for (const f of fibers.reverse()) await f.dispose(); } };
}
