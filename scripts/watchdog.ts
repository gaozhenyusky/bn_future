// 自愈看门狗：每分钟检查服务健康与数据新鲜度，异常时自动重启后端进程。
// 解决：长时间运行后 WS 断开 / MySQL 连接池损坏 / REST 轮询停滞导致的
// “K 线时间停更”（无时间对齐机制时需人工重启）。
// 用法：nohup node --env-file=.env --import tsx/esm scripts/watchdog.ts > /tmp/futures-radar-watchdog.log 2>&1 &
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const PROJECT_ROOT = resolve(import.meta.dirname ?? process.cwd(), "..");
const HEALTH_URL = "http://127.0.0.1:8787/health";
const CHECK_INTERVAL_MS = 60_000;
/** 数据新鲜度阈值：最新 K 线收到时间距现在超过该值时判定为停更 */
const STALE_MS = 5 * 60 * 1000;
const MYSQL_QUERY_TIMEOUT_MS = 5_000;

function log(message: string): void {
  console.log(`[watchdog ${new Date().toISOString()}] ${message}`);
}

async function checkHealth(): Promise<boolean> {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** 查 MySQL 最新 K 线收到时间，返回与当前时间的偏差（毫秒）；查询失败返回 Infinity */
async function checkFreshness(): Promise<number> {
  try {
    const mysql = require("mysql2/promise");
    const connection = await mysql.createConnection({
      host: process.env.MYSQL_HOST ?? "127.0.0.1",
      port: Number(process.env.MYSQL_PORT ?? 3306),
      user: process.env.MYSQL_USER ?? "root",
      password: process.env.MYSQL_PASSWORD ?? "gao",
      database: process.env.MYSQL_DATABASE ?? "crypto_monitor",
      connectTimeout: MYSQL_QUERY_TIMEOUT_MS,
    });
    try {
      const [rows] = await connection.query(
        "SELECT MAX(received_timestamp) AS last_received FROM futures_candles WHERE interval_name = '5m'",
      );
      const lastReceived = Number((rows as Array<{ last_received: number | null }>)[0]?.last_received ?? 0);
      return lastReceived > 0 ? Date.now() - lastReceived : Infinity;
    } finally {
      await connection.end();
    }
  } catch {
    return Infinity;
  }
}

function restartService(): void {
  log("检测到异常，正在重启后端服务…");
  // 参数列表方式（无 shell），仅按进程名匹配后端入口。
  execFile("pkill", ["-f", "tsx/esm src/main"], { stdio: "ignore" }, () => {
    const child = spawn(
      process.execPath,
      ["--env-file=.env", "--import", "tsx/esm", "src/main.ts"],
      {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: "ignore",
        env: process.env,
      },
    );
    child.unref();
    log(`已重启（PID ${child.pid ?? "?"}）`);
  });
}

async function main() {
  log(`看门狗启动：每 ${CHECK_INTERVAL_MS / 1000}s 检查健康与数据新鲜度（阈值 ${STALE_MS / 60_000} 分钟）`);
  while (true) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, CHECK_INTERVAL_MS));
    const healthOk = await checkHealth();
    const stalenessMs = await checkFreshness();
    const stale = stalenessMs > STALE_MS;
    log(`健康=${healthOk} 数据偏差=${stalenessMs === Infinity ? "未知" : `${Math.round(stalenessMs / 60_000)}m`}`);
    if (!healthOk || stale) {
      restartService();
    }
  }
}

void main();
