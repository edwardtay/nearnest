// Bundled to public/js/wallet.js. A small wallet API for the page: connect a NEAR
// wallet, sign out, and send function calls or NEAR. Keys stay in the wallet.
import { setupWalletSelector } from '@near-wallet-selector/core';
import { setupModal } from '@near-wallet-selector/modal-ui';
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import { setupIntearWallet } from '@near-wallet-selector/intear-wallet';

let selector;
let modal;
const listeners = new Set();
const current = () => selector?.store.getState().accounts.find((a) => a.active)?.accountId || null;

export async function init(network) {
  selector = await setupWalletSelector({
    network,
    modules: [setupMyNearWallet(), setupMeteorWallet(), setupIntearWallet()],
  });
  modal = setupModal(selector, { description: 'Connect a NEAR testnet wallet to create and manage your own NEARnest vault.' });
  selector.store.observable.subscribe(() => listeners.forEach((f) => f(current())));
  return current();
}

export const account = current;
export const onChange = (f) => { listeners.add(f); return () => listeners.delete(f); };
export const signIn = () => modal.show();
export async function signOut() {
  const w = await selector.wallet();
  await w.signOut();
}

const TGAS = 10n ** 12n;
/** One transaction to receiverId: function calls and/or a NEAR transfer. Amounts are yocto strings. */
export async function send(receiverId, calls) {
  const w = await selector.wallet();
  const actions = calls.map((c) => (c.transfer
    ? { type: 'Transfer', params: { deposit: String(c.transfer) } }
    : { type: 'FunctionCall', params: { methodName: c.method, args: c.args || {}, gas: String(BigInt(c.tgas || 100) * TGAS), deposit: String(c.deposit || '0') } }));
  return w.signAndSendTransaction({ receiverId, actions });
}
