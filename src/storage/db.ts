import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MysqlQueryable, type MysqlRawQueryable } from "./mysql-queryable";

type MysqlRawConnection = MysqlRawQueryable & {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
};

type MysqlRawPool = MysqlRawQueryable & {
  getConnection(): Promise<MysqlRawConnection>;
  end(): Promise<void>;
};

export class MysqlConnection extends MysqlQueryable {
  constructor(private readonly connection: MysqlRawConnection) {
    super(connection);
  }

  beginTransaction(): Promise<void> {
    return this.connection.beginTransaction();
  }

  commit(): Promise<void> {
    return this.connection.commit();
  }

  rollback(): Promise<void> {
    return this.connection.rollback();
  }

  release(): void {
    this.connection.release();
  }
}

export class MysqlPool extends MysqlQueryable {
  constructor(private readonly pool: MysqlRawPool) {
    super(pool);
  }

  async connect(): Promise<MysqlConnection> {
    return new MysqlConnection(await this.pool.getConnection());
  }

  end(): Promise<void> {
    return this.pool.end();
  }
}

const require = createRequire(import.meta.url);

function loadMysqlCreatePool(): (options: Record<string, unknown>) => MysqlRawPool {
  const mysqlModule = require("mysql2/promise") as {
    createPool: (options: Record<string, unknown>) => MysqlRawPool;
  };

  return mysqlModule.createPool;
}

export function createMysqlPool(env: NodeJS.ProcessEnv = process.env): MysqlPool {
  const createPool = loadMysqlCreatePool();
  const rawPool = createPool({
    host: env.MYSQL_HOST ?? "127.0.0.1",
    port: Number(env.MYSQL_PORT ?? 3306),
    user: env.MYSQL_USER ?? "root",
    password: env.MYSQL_PASSWORD ?? "gao",
    database: env.MYSQL_DATABASE ?? "crypto_monitor",
    waitForConnections: true,
    connectionLimit: Number(env.MYSQL_CONNECTION_LIMIT ?? 10),
    charset: "utf8mb4",
  });

  return new MysqlPool(rawPool);
}

async function ensureSchemaMigrationsTable(db: MysqlQueryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function getPendingMigrationNames(db: MysqlQueryable, allMigrationNames: readonly string[]): Promise<string[]> {
  const result = await db.query<{ name: string }>("SELECT name FROM schema_migrations");
  const applied = new Set(result.rows.map((row) => row.name));
  return allMigrationNames.filter((name) => !applied.has(name));
}

function splitMigrationStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function runMigrations(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const pool = createMysqlPool(env);
  const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "migrations");

  try {
    await ensureSchemaMigrationsTable(pool);

    const migrationNames = (await readdir(migrationDirectory))
      .filter((entry) => entry.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));
    const pendingNames = await getPendingMigrationNames(pool, migrationNames);

    for (const migrationName of pendingNames) {
      const migrationSql = await readFile(resolve(migrationDirectory, migrationName), "utf8");
      const client = await pool.connect();

      try {
        await client.beginTransaction();
        for (const statement of splitMigrationStatements(migrationSql)) {
          await client.query(statement);
        }
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [migrationName]);
        await client.commit();
        console.log(`applied migration ${migrationName}`);
      } catch (error) {
        await client.rollback();
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

function isExecutedDirectly(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url);
}

if (isExecutedDirectly()) {
  runMigrations().catch((error) => {
    console.error(error instanceof Error ? error.message : "db:migrate failed");
    process.exitCode = 1;
  });
}
