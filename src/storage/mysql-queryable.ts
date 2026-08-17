import type { Queryable } from "./futures-repository";

type QueryResult = {
  affectedRows?: number;
  insertId?: number | string;
};

export interface MysqlRawQueryable {
  query(text: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
}

function normalizeMysqlRow<Row extends Record<string, unknown>>(row: Row): Row {
  if (!("interval" in row) && "interval_name" in row) {
    return {
      ...row,
      interval: row.interval_name,
    };
  }

  return row;
}

function serializeValue(value: unknown): unknown {
  if (value !== null && typeof value === "object") {
    return JSON.stringify(value);
  }

  return value;
}

function replaceParameters(text: string): string {
  return text.replace(/\$\d+/g, "?");
}

function replaceConflictUpdate(text: string): string {
  const withMysqlValues = text.replace(/EXCLUDED\.([a-zA-Z0-9_]+)/g, "VALUES($1)");
  const checkpointWhere = /\s+WHERE VALUES\(timestamp\) > connector_checkpoints\.timestamp\s*/i;
  if (checkpointWhere.test(withMysqlValues)) {
    return withMysqlValues
      .replace(/ON CONFLICT \(stream\) DO UPDATE\s+SET\s+timestamp = VALUES\(timestamp\)/i, "ON DUPLICATE KEY UPDATE timestamp = IF(VALUES(timestamp) > connector_checkpoints.timestamp, VALUES(timestamp), connector_checkpoints.timestamp)")
      .replace(checkpointWhere, "");
  }

  return withMysqlValues.replace(
    /ON CONFLICT \s*\([^)]*\)\s*DO UPDATE\s*SET/i,
    "ON DUPLICATE KEY UPDATE",
  );
}

export function translatePostgresQuery(text: string): string {
  let translated = replaceParameters(text);
  // The MySQL migration avoids the reserved INTERVAL keyword by using
  // interval_name. The repository keeps its domain-oriented SQL readable,
  // so this adapter translates that column at the database boundary.
  translated = translated.replace(/\binterval\b/g, "interval_name");
  const insertIfNew = /RETURNING\s+1\s+AS\s+created/i.test(text);
  translated = translated.replace(/\s+ON CONFLICT \s*\([^)]*\)\s*DO NOTHING\s+RETURNING\s+1\s+AS\s+created\s*$/is, "");
  // INSERT ... ON CONFLICT (...) DO NOTHING without RETURNING has no created
  // marker, so translate it directly to INSERT IGNORE here; the query()
  // wrapper only handles the RETURNING variant above.
  if (!insertIfNew && /^\s*INSERT\s+/i.test(translated) && /ON CONFLICT \s*\([^)]*\)\s*DO NOTHING\s*$/i.test(translated)) {
    translated = translated
      .replace(/\s+ON CONFLICT \s*\([^)]*\)\s*DO NOTHING\s*$/i, "")
      .replace(/^\s*INSERT\s+/i, "INSERT IGNORE ");
  }
  if (/ON CONFLICT/i.test(translated)) {
    translated = replaceConflictUpdate(translated);
  }

  return translated.trim();
}

export class MysqlQueryable implements Queryable {
  constructor(private readonly raw: MysqlRawQueryable) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; affectedRows?: number }> {
    const isInsertIfNew = /RETURNING\s+1\s+AS\s+created/i.test(text);
    const translated = translatePostgresQuery(text);
    const placeholderCount = (translated.match(/\?/g) ?? []).length;
    if (placeholderCount !== values.length) {
      // 占位符与参数数量不一致会在 MySQL 客户端替换时残留 ? 导致语法错误，
      // 这里直接抛错以便在开发/测试期立即暴露（如重复引用同一 $N 参数）。
      throw new Error(
        `SQL placeholder count (${placeholderCount}) does not match values count (${values.length}): ${text.slice(0, 120)}…`,
      );
    }
    const mysqlText = isInsertIfNew
      ? translated.replace(/^INSERT\s+/i, "INSERT IGNORE ")
      : translated;
    const [result] = await this.raw.query(mysqlText, values.map(serializeValue));

    if (Array.isArray(result)) {
      return { rows: (result as Row[]).map((row) => normalizeMysqlRow(row)) };
    }

    if (isInsertIfNew && (result as QueryResult).affectedRows === 1) {
      return { rows: [{ created: 1 } as unknown as Row] };
    }

    return { rows: [], affectedRows: (result as QueryResult).affectedRows };
  }
}
