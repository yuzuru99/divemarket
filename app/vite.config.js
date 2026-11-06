import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => ({
  define: {
    // near-api-js (via the wallet selector) references `global` at module
    // scope. Browsers do not have it, and the bundle throws on load — a blank
    // page with no visible error.
    global: 'globalThis',
  },
  build: {
    // The wallet bundle is ~2 MB; the default warning is just noise here.
    chunkSizeWarningLimit: 4096,
  },
  // The `e2e` mode swaps the real wallet for a test wallet that signs with a
  // throwaway testnet key. Production builds never take this branch.
  resolve: mode === 'e2e'
    ? { alias: [{ find: /^\.\/wallet$/, replacement: fileURLToPath(new URL('./e2e/testWallet.js', import.meta.url)) }] }
    : {},
}));
