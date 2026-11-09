#!/usr/bin/env node
/* Hosted agent: every NEARNEST_AGENT_EVERY_MIN minutes (default 30), run the agent once for the
   mainnet vault and every vault the mainnet factory made. One vault at a time, each in its own
   short-lived process (scripts/run-agent.mjs), so nothing stays in memory between rounds.
   Started by server.mjs when NEARNEST_AGENT=1. Keys come from the environment:
     NEARNEST_KEYS  base64 JSON from scripts/export-agent-keys.mjs (agent, factory agent and
                    feeder keys only; no owner or factory maintenance key)
     NEARAI_KEY     NEAR AI Cloud key; without it the agent runs on the policy alone
     NEARNEST_AGENT_DRY=1  plan and propose only, sign nothing (for testing)
   Writes demo/agent-service.json as a heartbeat for the page. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(DIR, '..');
const KEYS = path.join(ROOT, 'keys');
const EVERY = Math.max(10, Number(process.env.NEARNEST_AGENT_EVERY_MIN || 30)) * 60_000;
const BEAT = path.join(ROOT, 'demo', 'agent-service.json');

fs.mkdirSync(KEYS, { recursive: true, mode: 0o700 });
if (process.env.NEARNEST_KEYS) fs.writeFileSync(path.join(KEYS, 'mainnet.json'), Buffer.from(process.env.NEARNEST_KEYS, 'base64').toString(), { mode: 0o600 });
if (process.env.NEARAI_KEY) fs.writeFileSync(path.join(KEYS, 'near-ai.txt'), process.env.NEARAI_KEY.trim(), { mode: 0o600 });
const state = () => JSON.parse(fs.readFileSync(path.join(KEYS, 'mainnet.json'), 'utf8'));
const AI = fs.existsSync(path.join(KEYS, 'near-ai.txt'));

async function view(contract, method, args) {
  const r = await fetch('https://free.rpc.fastnear.com', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { finality: 'final', request_type: 'call_function', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) });
  const j = await r.json();
  if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error || j.result.error).slice(0, 200));
  return JSON.parse(Buffer.from(j.result.result).toString());
}

async function vaults() {
  const s = state();
  const list = [s.vault];
  if (s.factory) for (const [id] of await view(s.factory, 'get_vaults', { limit: 500 }).catch(() => [])) list.push(id);
  return list;
}

function runOne(vault) {
  return new Promise((resolve) => {
    const args = ['run-agent.mjs', 'mainnet', '--vault', vault, ...(AI ? ['--ai'] : []), ...(process.env.NEARNEST_AGENT_DRY === '1' ? ['--dry'] : [])];
    let out = '';
    const p = spawn(process.execPath, args, { cwd: DIR, timeout: 5 * 60_000 });
    p.stdout.on('data', (d) => { out = (out + d).slice(-4000); });
    p.stderr.on('data', (d) => { out = (out + d).slice(-4000); });
    p.on('close', (code) => {
      const last = out.trim().split('\n').filter((l) => /^(done|REFUSED|nothing to do|cooldown|read failed|NEAR AI|policy check)/.test(l.trim())).slice(-3);
      resolve({ vault, ok: code === 0, summary: last.join(' | ').slice(0, 400) });
    });
  });
}

async function round() {
  const started = new Date().toISOString();
  let results = [];
  try {
    for (const v of await vaults()) results.push(await runOne(v));
  } catch (e) {
    results.push({ vault: null, ok: false, summary: `could not list vaults: ${String(e.message || e).slice(0, 200)}` });
  }
  const beat = { started_at: started, finished_at: new Date().toISOString(), every_min: EVERY / 60_000, ai: AI, results };
  fs.writeFileSync(BEAT, JSON.stringify(beat, null, 2));
  console.log(`[agent-service] round done: ${results.length} vault(s)`);
}

await round();
setInterval(round, EVERY);
