// Tunnel watchdog: health-checks each SSH SOCKS5 tunnel every 15s and
// restarts any that died (the local->Tokyo link is lossy; tunnels stall).
// Usage: node scripts/tunnel-watchdog.mjs
import { execSync, spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createConnection } = require("socks");

const PORTS = (process.env.TUNNEL_PORTS ?? "7899,7999,8099").split(",").map(Number);
const REMOTE = process.env.RELAY_HOST ?? "45.195.8.131";
const CHECK_INTERVAL_MS = parseInt(process.env.WATCHDOG_INTERVAL_MS ?? "15000", 10);
const CONNECT_TIMEOUT_MS = parseInt(process.env.WATCHDOG_CONNECT_TIMEOUT_MS ?? "8000", 10);

function checkTunnel(port) {
  return new Promise((resolve) => {
    createConnection(
      {
        proxy: { ipaddress: "127.0.0.1", port, type: 5 },
        target: { host: "fapi.binance.com", port: 443 },
        command: "connect",
        timeout: CONNECT_TIMEOUT_MS,
      },
      (err, info) => {
        const sock = info && (info.socket || info);
        if (sock && sock.destroy) sock.destroy();
        resolve(!err);
      },
    );
  });
}

function tunnelPid(port) {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, { encoding: "utf8" });
    const lines = out.trim().split("\n");
    if (lines.length >= 2) return parseInt(lines[1].split(/\s+/)[1], 10);
  } catch {
    /* no listener */
  }
  return null;
}

function startTunnel(port) {
  const env = {
    ...process.env,
    DISPLAY: ":0",
    SSH_ASKPASS: "/tmp/askpass.sh",
    SSH_ASKPASS_REQUIRE: "force",
  };
  const child = spawn(
    "ssh",
    [
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=20",
      "-o", "PreferredAuthentications=password",
      "-o", "PubkeyAuthentication=no",
      "-o", "NumberOfPasswordPrompts=1",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "ExitOnForwardFailure=yes",
      "-D", String(port), "-N", "-f",
      `root@${REMOTE}`,
    ],
    { env, stdio: "ignore", detached: true },
  );
  child.unref();
}

console.log(
  `[watchdog] monitoring tunnels ${PORTS.join(",")} -> ${REMOTE}, interval ${CHECK_INTERVAL_MS}ms`,
);

while (true) {
  for (const port of PORTS) {
    const ok = await checkTunnel(port);
    if (!ok) {
      const pid = tunnelPid(port);
      console.log(`[watchdog] ${new Date().toISOString()} tunnel ${port} DOWN (pid ${pid ?? "none"}), restarting`);
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      startTunnel(port);
    }
  }
  await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS));
}
