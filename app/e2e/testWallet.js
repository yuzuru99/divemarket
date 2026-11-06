/**
 * TEST-ONLY wallet for end-to-end runs. Swapped in for ./wallet by the `e2e`
 * Vite mode (see vite.config.js); never part of a production build. It signs
 * with a throwaway testnet key passed in at e2e build time, so a headless
 * browser can click real buttons and send real testnet transactions.
 */
import { connect as nearConnect, keyStores, KeyPair, transactions } from 'near-api-js';

const ACCOUNT = import.meta.env.VITE_E2E_ACCOUNT;
const KEY = import.meta.env.VITE_E2E_KEY;
let accountPromise;

function account() {
  if (!accountPromise) {
    const ks = new keyStores.InMemoryKeyStore();
    accountPromise = ks.setKey('testnet', ACCOUNT, KeyPair.fromString(KEY))
      .then(() => nearConnect({ networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', keyStore: ks }))
      .then((near) => near.account(ACCOUNT));
  }
  return accountPromise;
}

/** Translate whatever action shape the app built into a near-api-js action. */
function toAction(a) {
  const fc = a.functionCall || a.params || a;
  let args = fc.args;
  if (args instanceof Uint8Array) args = JSON.parse(new TextDecoder().decode(args));
  return transactions.functionCall(fc.methodName, args, BigInt(fc.gas), BigInt(fc.deposit ?? 0));
}

const wallet = {
  async signAndSendTransaction({ receiverId, actions }) {
    const acc = await account();
    return acc.signAndSendTransaction({ receiverId, actions: actions.map(toAction) });
  },
};

export const accountId = () => ACCOUNT;
export const restoreSession = async () => ACCOUNT;
export const connect = async () => ACCOUNT;
export const disconnect = async () => {};
export const onAccountChange = () => () => {};
export const getWallet = async () => wallet;
