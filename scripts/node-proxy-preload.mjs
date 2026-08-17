// Node preload module: route the global fetch dispatcher through the configured
// HTTP proxy so zero-dependency skill CLIs can reach Binance Web3 endpoints.
import { ProxyAgent, setGlobalDispatcher } from "../node_modules/undici/index.js";

const proxy = process.env.BINANCE_HTTP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxy) {
  setGlobalDispatcher(new ProxyAgent(proxy));
}
