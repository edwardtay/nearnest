// Bundled to public/js/wallet.js. A small wallet API for the page: connect a NEAR
// wallet, sign out, and send function calls or NEAR. Keys stay in the wallet.
import { setupWalletSelector } from '@near-wallet-selector/core';
import { setupModal } from '@near-wallet-selector/modal-ui';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import { setupIntearWallet } from '@near-wallet-selector/intear-wallet';
import { actionCreators } from '@near-js/transactions';
import { PublicKey } from '@near-js/crypto';

let selector;
let modal;
const listeners = new Set();
const current = () => selector?.store.getState().accounts.find((a) => a.active)?.accountId || null;

export async function init(network) {
  selector = await setupWalletSelector({
    network,
    modules: [setupMeteorWallet(), setupIntearWallet()],
  });
  modal = setupModal(selector, { description: network === 'mainnet' ? 'Connect the NEAR account that will own the mainnet vault.' : 'Connect a NEAR testnet wallet to create and manage your own NEARnest vault.' });
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
/** One transaction to receiverId: function calls, a NEAR transfer, or (mainnet setup) CreateAccount and a
    full-access AddKey. Amounts are yocto strings. Wallet Selector v10 takes near-api-js actions. */
export async function send(receiverId, calls) {
  const w = await selector.wallet();
  const actions = calls.map((c) => (c.createAccount ? actionCreators.createAccount()
    : c.deploy ? actionCreators.deployContract(c.deploy)
    : c.addFullKey ? actionCreators.addKey(PublicKey.from(c.addFullKey), actionCreators.fullAccessKey())
    : c.transfer ? actionCreators.transfer(BigInt(c.transfer))
    : actionCreators.functionCall(c.method, c.args || {}, BigInt(c.tgas || 100) * TGAS, BigInt(c.deposit || '0'))));
  return w.signAndSendTransaction({ receiverId, actions });
}
