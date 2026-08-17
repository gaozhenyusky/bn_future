import { describe, expect, it } from "vitest";
import { MysqlQueryable, translatePostgresQuery } from "../src/storage/mysql-queryable";

describe("translatePostgresQuery", () => {
  it("converts numbered parameters and conflict updates to MySQL syntax", () => {
    const translated = translatePostgresQuery(`
      INSERT INTO demo (id, payload)
      VALUES ($1, $2)
      ON CONFLICT (id) DO UPDATE
      SET payload = EXCLUDED.payload
    `);

    expect(translated).toContain("VALUES (?, ?)");
    expect(translated).toContain("ON DUPLICATE KEY UPDATE");
    expect(translated).toContain("payload = VALUES(payload)");
    expect(translated).not.toMatch(/ON DUPLICATE KEY UPDATE\s+SET/i);
    expect(translated).not.toContain("$1");
  });

  it("maps the repository interval column to the MySQL migration column", () => {
    const translated = translatePostgresQuery("SELECT interval FROM futures_candles WHERE interval = $1");

    expect(translated).toBe("SELECT interval_name FROM futures_candles WHERE interval_name = ?");
  });

  it("translates the monotonic checkpoint upsert without leaving a PostgreSQL WHERE clause", () => {
    const translated = translatePostgresQuery(`
      INSERT INTO connector_checkpoints (stream, timestamp)
      VALUES ($1, $2)
      ON CONFLICT (stream) DO UPDATE
      SET timestamp = EXCLUDED.timestamp
      WHERE EXCLUDED.timestamp > connector_checkpoints.timestamp
    `);

    expect(translated).toContain("ON DUPLICATE KEY UPDATE timestamp = IF(VALUES(timestamp) > connector_checkpoints.timestamp, VALUES(timestamp), connector_checkpoints.timestamp)");
    expect(translated).not.toMatch(/\bWHERE\b/i);
  });

  it("translates ON CONFLICT DO NOTHING without RETURNING into INSERT IGNORE", () => {
    const translated = translatePostgresQuery(`
      INSERT INTO execution_processed_signals (dedupe_key)
      VALUES ($1)
      ON CONFLICT (dedupe_key) DO NOTHING
    `);

    expect(translated.replace(/\s+/g, " ")).toBe("INSERT IGNORE INTO execution_processed_signals (dedupe_key) VALUES (?)");
  });
});

describe("MysqlQueryable", () => {
  it("serializes JSON values and returns inserted rows for insert-if-new", async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const db = new MysqlQueryable({
      async query(text, values) {
        calls.push({ text, values: values ?? [] });
        return [{ affectedRows: 1 }, []];
      },
    });

    const result = await db.query<{ created: number }>(`
      INSERT INTO demo (id, payload)
      VALUES ($1, $2)
      ON CONFLICT (id) DO NOTHING
      RETURNING 1 AS created
    `, ["x", { ok: true }]);

    expect(result.rows).toEqual([{ created: 1 }]);
    expect(calls[0]?.values).toEqual(["x", JSON.stringify({ ok: true })]);
    expect(calls[0]?.text).toContain("INSERT IGNORE INTO demo");
    expect(calls[0]?.text).not.toContain("RETURNING");
  });

  it("returns no created row when an insert-if-new hits a duplicate", async () => {
    const db = new MysqlQueryable({
      async query() {
        return [{ affectedRows: 0 }, []];
      },
    });

    const result = await db.query<{ created: number }>(`
      INSERT INTO demo (id) VALUES ($1)
      ON CONFLICT (id) DO NOTHING
      RETURNING 1 AS created
    `, ["x"]);

    expect(result.rows).toEqual([]);
  });

  it("throws when placeholder count does not match values count", async () => {
    const db = new MysqlQueryable({
      async query() {
        throw new Error("should not be called");
      },
    });

    // 同一 $3 出现两次但只传了一个值：占位符 4 个 vs 值 3 个
    await expect(db.query(
      "SELECT * FROM t WHERE a = $1 AND ($3 IS NULL OR b <= $3) AND c = $2",
      ["x", "y", 20],
    )).rejects.toThrow(/placeholder count \(4\) does not match values count \(3\)/);
  });
});
