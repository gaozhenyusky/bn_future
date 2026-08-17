// Multi-tunnel HTTP CONNECT proxy: round-robins each CONNECT over N parallel
// SSH SOCKS5 tunnels (each tunnel is an independent SSH TCP stream, avoiding
// the single-stream head-of-line blocking that degrades one ssh -D tunnel).
// Usage: node scripts/multi-tunnel-proxy.mjs
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createConnection } = require("socks");

const TUNNEL_PORTS = (process.env.TUNNEL_PORTS ?? "7899,7999,8099")
  .split(",")
  .map((p) => parseInt(p, 10))
  .filter((p) => Number.isInteger(p) && p > 0);
const LISTEN_PORT = parseInt(process.env.PROXY_LISTEN_PORT ?? "7898", 10);
const CONNECT_TIMEOUT_MS = parseInt(process.env.PROXY_CONNECT_TIMEOUT_MS ?? "25000", 10);

if (TUNNEL_PORTS.length === 0) {
  console.error("No tunnel ports configured (TUNNEL_PORTS)");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  res.writeHead(501, { "content-type": "text/plain" });
  res.end("Only HTTPS CONNECT is supported");
});

server.on("connect", (req, clientSocket, head) => {
  const sep = req.url.indexOf(":");
  if (sep === -1) {
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.destroy();
    return;
  }
  const host = req.url.slice(0, sep);
  const port = parseInt(req.url.slice(sep + 1), 10);
  const tunnelPort = TUNNEL_PORTS[Math.floor(Math.random() * TUNNEL_PORTS.length)];

  createConnection(
    {
      proxy: { ipaddress: "127.0.0.1", port: tunnelPort, type: 5 },
      target: { host, port },
      command: "connect",
      timeout: CONNECT_TIMEOUT_MS,
    },
    (err, info) => {
      if (err) {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        clientSocket.destroy();
        return;
      }
      const remote = info && (info.socket || info);
      if (!remote || typeof remote.pipe !== "function") {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        clientSocket.destroy();
        return;
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length > 0) remote.write(head);
      remote.pipe(clientSocket);
      clientSocket.pipe(remote);
      remote.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => remote.destroy());
    },
  );
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(
    `[multi-tunnel-proxy] listening 127.0.0.1:${LISTEN_PORT}, tunnels: ${TUNNEL_PORTS.join(",")}`,
  );
});
