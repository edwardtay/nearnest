#!/usr/bin/env node
// Run the agent once for the demo vault and for every vault the factory has created,
// one after another. Extra flags pass through (for example --loop or --dry).
import { spawnSync } from 'node:child_process';
import { loadState, near } from './lib.mjs';
const s = loadState('testnet');
const nc = await near('testnet', { signers: {} });
const acct = await nc.account(s.owner);
const made = s.factory ? (await acct.viewFunction({ contractId: s.factory, methodName: 'get_vaults', args: { limit: 200 } })).map(([id]) => id) : [];
const extra = process.argv.slice(2);
for (const v of [s.vault, ...made]) {
  console.log(`\n=== ${v}`);
  spawnSync(process.execPath, ['run-agent.mjs', 'testnet', '--vault', v, ...extra], { stdio: 'inherit', cwd: new URL('.', import.meta.url).pathname });
}
