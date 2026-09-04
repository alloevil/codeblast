/**
 * SQLite 运行时适配：bun 走 bun:sqlite，node 走 node:sqlite（≥22.13 内建）。
 * 只暴露两边语义一致的最小面：prepare/run/get/all/exec/close + 显式事务。
 * 行对象：bun 返回普通对象，node 返回 null-prototype 对象——两者都能被解构/JSON 化；
 * get() 无行时 bun 给 null、node 给 undefined——调用方统一用真值判断，不比较 null。
 */
import { createRequire } from "node:module";

export interface Statement {
  run(...params: SqlParam[]): unknown;
  get(...params: SqlParam[]): unknown;
  all(...params: SqlParam[]): unknown[];
}

export interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}

export type SqlParam = string | number | bigint | null | Uint8Array;
type DatabaseCtor = new (file: string, opts: object) => Database;

const require = createRequire(import.meta.url);
const isBun = "Bun" in globalThis;

// node:sqlite 在 22.x 仍打 ExperimentalWarning；CLI 的 stderr 是用户界面，静掉这一条（只这一条）。
if (!isBun) {
  const emit = process.emitWarning;
  const filtered: typeof process.emitWarning = (warning, ...rest) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (text.includes("SQLite is an experimental feature")) return;
    Reflect.apply(emit, process, [warning, ...rest]);
  };
  process.emitWarning = filtered;
}

export function openDatabase(file: string, opts: { readonly?: boolean } = {}): Database {
  if (isBun) {
    // require 结果无类型；两运行时的 Database 类在本模块使用的面上结构一致，按构造器使用。
    const mod: { Database: DatabaseCtor } = require("bun:sqlite");
    return new mod.Database(file, { readonly: !!opts.readonly, create: true });
  }
  const mod: { DatabaseSync: DatabaseCtor } = require("node:sqlite");
  return new mod.DatabaseSync(file, { readOnly: !!opts.readonly });
}

/** 显式事务：失败回滚并抛出。等价于 bun:sqlite 的 db.transaction(fn)，但不依赖运行时。 */
export function transaction<A extends unknown[]>(db: Database, fn: (...args: A) => void): (...args: A) => void {
  return (...args: A) => {
    db.exec("BEGIN");
    try {
      fn(...args);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
}
