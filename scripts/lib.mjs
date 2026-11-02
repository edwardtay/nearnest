// Shared helpers: key store under ../keys (gitignored), testnet/mainnet connections.
import fs from 'node:fs';
import path from 'node:path';
import { connect, keyStores, KeyPair } from 'near-api-js';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const KEYS = path.join(ROOT, 'keys');
export const WASM = path.join(ROOT, 'contract/target/wasm32-unknown-unknown/release/nearnest_vault.wasm');

export const NET = {
  testnet: { networkId: 'testnet', nodeUrl: 'https://rpc.testnet.fastnear.com', explorer: 'https://testnet.nearblocks.io' },
  mainnet: { networkId: 'mainnet', nodeUrl: 'https://free.rpc.fastnear.com', explorer: 'https://nearblocks.io' },
};

export function stateFile(net) { return path.join(KEYS, `${net}.json`); }
export function loadState(net) {
  try { return JSON.parse(fs.readFileSync(stateFile(net), 'utf8')); } catch { return {}; }
}
export function saveState(net, s) {
  fs.mkdirSync(KEYS, { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFile(net), JSON.stringify(s, null, 2), { mode: 0o600 });
}

export function newKey() {
  const kp = KeyPair.fromRandom('ed25519');
  return { public: kp.getPublicKey().toString(), secret: kp.toString() };
}

/** Connection whose key store holds every key in the state file, mapped to its account. */
export async function near(net, s) {
  const ks = new keyStores.InMemoryKeyStore();
  for (const [acct, secret] of Object.entries(s.signers || {})) {
    await ks.setKey(NET[net].networkId, acct, KeyPair.fromString(secret));
  }
  return connect({ ...NET[net], keyStore: ks });
}

export const TGAS = 10n ** 12n;
export const NEAR = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
export function txUrl(net, outcome) { return `${NET[net].explorer}/txns/${outcome.transaction.hash}`; }
