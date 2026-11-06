/**
 * Wallet connection via Wallet Selector.
 *
 * Same UX as nearblocks: a modal listing every wallet, sign-in in place, no
 * redirect. The selector is built once and reused; the session survives a page
 * change because the selector persists it in localStorage.
 */
import { setupWalletSelector } from '@near-wallet-selector/core';
import { setupModal } from '@near-wallet-selector/modal-ui';
import '@near-wallet-selector/modal-ui/styles.css';
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet';
import { setupHereWallet } from '@near-wallet-selector/here-wallet';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import { CONTRACT, NETWORK } from './contract';

let selector = null;
let modal = null;
let listeners = new Set();

function notify() {
  const id = accountId();
  listeners.forEach((fn) => fn(id));
}

async function getSelector() {
  if (selector) return selector;

  // Each wallet is loaded defensively: one failing to initialise must not
  // take the whole selector down.
  const modules = [];
  for (const setup of [setupMyNearWallet, setupHereWallet, setupMeteorWallet]) {
    try {
      modules.push(setup());
    } catch {
      /* wallet unavailable, skip it */
    }
  }

  selector = await setupWalletSelector({ network: NETWORK, modules });
  selector.subscribeOnAccountChange(() => notify());
  return selector;
}

/** Open the wallet modal and wait for a connection. */
export async function connect() {
  selector = await getSelector();

  const existing = accountId();
  if (existing) return existing;

  if (!modal) {
    modal = setupModal(selector, {
      contractId: CONTRACT,
      theme: 'dark',
      description: 'Connect a wallet to settle your catch on NEAR.',
    });
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const hideSub = modal.on('onHide', () => {
      if (!settled && !accountId()) {
        settled = true;
        // v10 subscriptions are removed with .remove(), not .unsubscribe().
        hideSub.remove();
        reject(new Error('wallet selection cancelled'));
      }
    });

    modal.show();

    const check = setInterval(() => {
      const id = accountId();
      if (id && !settled) {
        settled = true;
        clearInterval(check);
        hideSub.remove();
        modal.hide();
        resolve(id);
      }
    }, 200);
  });
}

/** Currently connected account, or null. */
export function accountId() {
  if (!selector) return null;
  return selector.store.getState().accounts[0]?.accountId ?? null;
}

/** Restore a session saved by a previous page. */
export async function restoreSession() {
  await getSelector();
  return accountId();
}

export async function disconnect() {
  if (!selector) return;
  const wallet = await selector.wallet();
  await wallet.signOut();
}

/** The wallet object, for signing transactions. */
export async function getWallet() {
  if (!selector) throw new Error('wallet not connected');
  return selector.wallet();
}

/** Subscribe to account changes. Returns an unsubscribe function. */
export function onAccountChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
