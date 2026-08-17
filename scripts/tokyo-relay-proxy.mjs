import { Server } from 'proxy-chain';

// Tokyo relay HTTP proxy (direct mode, no upstream).
// Binance API IP whitelist egress: traffic exits from this server's IP.
const PROXY_USER = 'bnrelay';
const PROXY_PASS = 'BnRelay#2026!xk9';

const server = new Server({
  port: 18443,
  verbose: false,
  prepareRequestFunction: ({ username, password }) => {
    const ok = username === PROXY_USER && password === PROXY_PASS;
    return {
      requestAuthentication: !ok,
      failMsg: 'Bad proxy credentials',
    };
  },
});

server.on('requestFailed', ({ request, error }) => {
  console.error(`[proxy] ${request.url} failed: ${error?.message}`);
});

await server.listen();
console.log(`[proxy] Tokyo relay listening on 0.0.0.0:18443 (auth: ${PROXY_USER})`);
