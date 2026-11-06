/**
 * TEST-ONLY local server: serves the e2e build and runs the real /api
 * handlers in-process, so the whole game loop runs without Vercel.
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';

const [, , distDir, port = '5190'] = process.argv;
const secret = JSON.parse(readFileSync('/root/divemarket/.secrets/game-signer.json', 'utf8'));
process.env.GAME_SIGNER_SECRET = secret.secret_key;
process.env.CAST_HMAC_SECRET = secret.hmac;
process.env.CONTRACT_ID = 'dm21.testnet';
const api = {};
for (const n of ['cast', 'strike', 'adopt']) api[n] = (await import(`../api/${n}.js`)).default;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/api\/(\w+)$/);
  if (m && api[m[1]]) {
    let body = '';
    for await (const c of req) body += c;
    const out = { status(s) { res.statusCode = s; return out; }, json(j) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(j)); }, setHeader: (k, v) => res.setHeader(k, v) };
    return api[m[1]]({ method: req.method, body: body ? JSON.parse(body) : {} }, out);
  }
  let file = join(distDir, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!existsSync(file)) file = join(distDir, 'index.html');
  res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
  res.end(readFileSync(file));
}).listen(Number(port), '127.0.0.1', () => console.log('e2e server on', port));
