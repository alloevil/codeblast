import { describe, expect, test } from "bun:test";
import { applyOverlay } from "../src/overlay";
import { invalidateFile, openGraph } from "../src/schema";
import { addBinding, addBlind, memGraph } from "./helpers";

describe("overlay", () => {
  test("rename: display uses overlay name; effective stays the directory key", () => {
    const m = applyOverlay(["srv", "web"], { modules: { srv: { name: "服务端" } } });
    expect(m.get("srv")).toEqual({ display: "服务端", effective: "srv", hidden: false });
    expect(m.get("web")).toEqual({ display: "web", effective: "web", hidden: false });
  });

  test("mergeInto redirects to target module and follows chains, display from final target", () => {
    const m = applyOverlay(["srvcfg", "srv", "core"], {
      modules: { srvcfg: { mergeInto: "srv" }, srv: { mergeInto: "core" }, core: { name: "Core" } },
    });
    expect(m.get("srvcfg")).toMatchObject({ effective: "core", display: "Core" });
    expect(m.get("srv")).toMatchObject({ effective: "core", display: "Core" });
  });

  test("mergeInto cycle terminates (max 5 hops)", () => {
    const m = applyOverlay(["a", "b"], { modules: { a: { mergeInto: "b" }, b: { mergeInto: "a" } } });
    expect(m.get("a")!.effective).toMatch(/^(a|b)$/);
  });

  test("hidden: own flag or merged target's flag hides the module", () => {
    const m = applyOverlay(["gen", "sub", "keep"], {
      modules: { gen: { hidden: true }, sub: { mergeInto: "gen" } },
    });
    expect(m.get("gen")!.hidden).toBe(true);
    expect(m.get("sub")!.hidden).toBe(true);
    expect(m.get("keep")!.hidden).toBe(false);
  });
});

describe("schema", () => {
  test("openGraph creates all tables incl. import_bindings and nodes.signature", () => {
    const db = openGraph(":memory:");
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(["blind_spots", "edges", "files", "import_bindings", "meta", "nodes"]);
    const cols = (db.prepare("PRAGMA table_info(nodes)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("signature");
    expect(cols).toContain("src_file");
  });

  test("openGraph is idempotent on an existing db (signature migration guarded)", () => {
    const db = openGraph(":memory:");
    expect(() => db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)).not.toThrow();
    // 再次执行迁移语句不应抛出到调用方：openGraph 内部 try/catch
    expect(() => openGraph(":memory:")).not.toThrow();
  });

  test("invalidateFile deletes rows by src_file across all four tables plus files, leaving other files intact", () => {
    const db = memGraph(
      [{ id: "a.ts" }, { id: "a.ts#f" }, { id: "b.ts#g" }],
      [{ src: "a.ts#f", dst: "b.ts#g", kind: "calls" }, { src: "b.ts#g", dst: "a.ts#f", kind: "calls" }],
    );
    addBinding(db, "a.ts", "b.ts", "g");
    addBlind(db, "a.ts", 3, "dynamic call: x");
    db.prepare("INSERT INTO files (path, hash) VALUES ('a.ts','h1'), ('b.ts','h2')").run();
    invalidateFile(db, "a.ts");
    const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
    expect(count("SELECT COUNT(*) c FROM nodes WHERE src_file='a.ts'")).toBe(0);
    expect(count("SELECT COUNT(*) c FROM nodes")).toBe(1);
    expect(count("SELECT COUNT(*) c FROM edges")).toBe(1);
    expect(count("SELECT COUNT(*) c FROM import_bindings")).toBe(0);
    expect(count("SELECT COUNT(*) c FROM blind_spots")).toBe(0);
    expect(count("SELECT COUNT(*) c FROM files")).toBe(1);
  });

  test("edge primary key is (src,dst,kind,file,line): same edge at another line is a distinct row", () => {
    const db = memGraph([{ id: "a.ts#f" }, { id: "b.ts#g" }], [
      { src: "a.ts#f", dst: "b.ts#g", kind: "calls", line: 1 },
      { src: "a.ts#f", dst: "b.ts#g", kind: "calls", line: 2 },
      { src: "a.ts#f", dst: "b.ts#g", kind: "calls", line: 2 },
    ]);
    expect((db.prepare("SELECT COUNT(*) c FROM edges").get() as { c: number }).c).toBe(2);
  });
});
