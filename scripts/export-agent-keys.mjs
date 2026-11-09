#!/usr/bin/env node
// Prints NEARNEST_KEYS for the hosted agent: base64 JSON with only what the agent needs (vault
// ids, the agent keys and the risk feeder key). The owner's key never exists here, and the
// factory maintenance key and spent setup keys are left out.
import { loadState } from './lib.mjs';
const s = loadState('mainnet');
const keep = { owner: s.owner, vault: s.vault, feeder: s.feeder, factory: s.factory, agentKey: s.agentKey, factoryAgentKey: s.factoryAgentKey, signers: { [s.feeder]: s.signers[s.feeder] } };
process.stdout.write(Buffer.from(JSON.stringify(keep)).toString('base64') + '\n');
