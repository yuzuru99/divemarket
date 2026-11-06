/**
 * Account names for display. Simulated anglers (`dmsim-*`, see sim/) and the
 * end-to-end test wallet are labelled, so nobody mistakes them for players.
 */
export const isSim = (a) => typeof a === 'string' && a.startsWith('dmsim-');
export const isTest = (a) => a === 'fisher.dm21.testnet';

export function short(a, max = 20) {
  if (!a) return a;
  const tag = isSim(a) ? ' [sim]' : isTest(a) ? ' [test]' : '';
  const base = isSim(a) ? a.replace(/^dmsim-/, '').replace(/\.testnet$/, '') : a;
  return (base.length > max ? `${base.slice(0, max - 3)}…` : base) + tag;
}
