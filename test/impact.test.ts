import { describe, expect, test } from "bun:test";
import { impact } from "../src/impact";
import { addBinding, addBlind, memGraph } from "./helpers";

/**
 * 手工图：
 *   b.ts#callB --calls--> a.ts#callA --calls--> lib.ts#target
 *   t.test.ts#t1 --calls--> a.ts#callA           (测试文件,2 跳)
 *   c.ts --imports--> lib.ts --contains--> lib.ts#target  (文件级通道)
 */
function baseGraph() {
  return memGraph(
    [
      { id: "lib.ts" }, { id: "lib.ts#target", exported: 1 },
      { id: "a.ts" }, { id: "a.ts#callA" },
      { id: "b.ts#callB" },
      { id: "t.test.ts#t1", kind: "test" },
      { id: "c.ts" },
    ],
    [
      { src: "lib.ts", dst: "lib.ts#target", kind: "contains" },
      { src: "a.ts#callA", dst: "lib.ts#target", kind: "calls", line: 7 },
      { src: "b.ts#callB", dst: "a.ts#callA", kind: "calls" },
      { src: "t.test.ts#t1", dst: "a.ts#callA", kind: "calls" },
      { src: "c.ts", dst: "lib.ts", kind: "imports", line: 2 },
    ],
  );
}
const byId = (r: ReturnType<typeof impact>) => Object.fromEntries(r.items.map((i) => [i.id, i]));

describe("impact", () => {
  test("levels: 1 hop = direct, 2+ hops = indirect, test kind = tests regardless of hops", () => {
    const r = byId(impact(baseGraph(), "lib.ts#target"));
    expect(r["a.ts#callA"]).toMatchObject({ level: "direct", hops: 1 });
    expect(r["b.ts#callB"]).toMatchObject({ level: "indirect", hops: 2 });
    expect(r["t.test.ts#t1"]).toMatchObject({ level: "tests", hops: 2 });
  });

  test("evidence: via_file/via_line point at the callsite edge", () => {
    const r = byId(impact(baseGraph(), "lib.ts#target"));
    expect(r["a.ts#callA"]).toMatchObject({ via_file: "a.ts", via_line: 7 });
  });

  test("channel: pure calls path = call; path through imports/contains = file", () => {
    const r = byId(impact(baseGraph(), "lib.ts#target"));
    expect(r["a.ts#callA"].channel).toBe("call");
    expect(r["b.ts#callB"].channel).toBe("call");
    expect(r["c.ts"]).toMatchObject({ channel: "file", level: "indirect", hops: 2 });
  });

  test("target's own file node is dropped from items (noise), but still traversed", () => {
    const r = impact(baseGraph(), "lib.ts#target");
    expect(r.items.find((i) => i.id === "lib.ts")).toBeUndefined();
    expect(r.items.find((i) => i.id === "c.ts")).toBeDefined(); // 经 lib.ts 才可达
  });

  test("named_miss set when binding lacks target name and star=0", () => {
    const db = baseGraph();
    addBinding(db, "c.ts", "lib.ts", "other,another", 0);
    expect(byId(impact(db, "lib.ts#target"))["c.ts"].named_miss).toBe(true);
  });

  test("named_miss false when binding names include target", () => {
    const db = baseGraph();
    addBinding(db, "c.ts", "lib.ts", "target", 0);
    expect(byId(impact(db, "lib.ts#target"))["c.ts"].named_miss).toBe(false);
  });

  test("named_miss false when star=1 (namespace/default import, cannot enumerate)", () => {
    const db = baseGraph();
    addBinding(db, "c.ts", "lib.ts", "", 1);
    expect(byId(impact(db, "lib.ts#target"))["c.ts"].named_miss).toBe(false);
  });

  test("named_miss false when import_bindings is empty (old db)", () => {
    expect(byId(impact(baseGraph(), "lib.ts#target"))["c.ts"].named_miss).toBe(false);
  });

  test("named_miss never prunes: the importer still appears in the impact set (recall 100%->53% rollback)", () => {
    const db = baseGraph();
    addBinding(db, "c.ts", "lib.ts", "other", 0);
    expect(impact(db, "lib.ts#target").items.some((i) => i.id === "c.ts")).toBe(true);
  });

  test("conservative confidence propagates along the whole path", () => {
    const db = memGraph(
      [{ id: "i.ts#Iface.m", kind: "method" }, { id: "x.ts#Impl.m", kind: "method" }, { id: "y.ts#caller" }, { id: "z.ts#outer" }],
      [
        { src: "y.ts#caller", dst: "x.ts#Impl.m", kind: "calls", confidence: "conservative" },
        { src: "z.ts#outer", dst: "y.ts#caller", kind: "calls" },
      ],
    );
    const r = byId(impact(db, "x.ts#Impl.m"));
    expect(r["y.ts#caller"].confidence).toBe("conservative");
    expect(r["z.ts#outer"].confidence).toBe("conservative");
  });

  test("truncated=true once visited exceeds maxNodes", () => {
    const nodes = [{ id: "lib.ts#t" }];
    const edges = [];
    for (let i = 0; i < 6; i++) {
      nodes.push({ id: `c${i}.ts#f` });
      edges.push({ src: `c${i}.ts#f`, dst: "lib.ts#t", kind: "calls" as const });
    }
    expect(impact(memGraph(nodes, edges), "lib.ts#t", 3).truncated).toBe(true);
    expect(impact(memGraph(nodes, edges), "lib.ts#t", 500).truncated).toBe(false);
  });

  test("tests edges on affected nodes add tests-level items not reachable via calls", () => {
    const db = baseGraph();
    db.prepare("INSERT INTO nodes (id, kind, name, file, line, end_line, exported, signature, src_file) VALUES (?, 'test', 't2', 'u.test.ts', 3, 9, 0, '', 'u.test.ts')").run("u.test.ts#t2");
    db.prepare("INSERT INTO edges (src, dst, kind, file, line, confidence, src_file) VALUES ('u.test.ts#t2', 'a.ts#callA', 'tests', 'u.test.ts', 3, 'exact', 'u.test.ts')").run();
    const r = byId(impact(db, "lib.ts#target"));
    expect(r["u.test.ts#t2"]).toMatchObject({ level: "tests", hops: 2, channel: "call" });
  });

  test("blind-reach: test files with subprocess/dynamic-import blind spots are conservatively included; non-test files are not", () => {
    const db = baseGraph();
    addBlind(db, "e2e/run.test.ts", 5, "subprocess spawn: execSync");
    addBlind(db, "tool.ts", 5, "subprocess spawn: execSync");
    const r = byId(impact(db, "lib.ts#target"));
    expect(r["e2e/run.test.ts"]).toMatchObject({ level: "tests", confidence: "conservative", channel: "file", line: 5 });
    expect(r["tool.ts"]).toBeUndefined();
  });

  test("blind_spot_count counts target file's blind spots excluding test-global", () => {
    const db = baseGraph();
    addBlind(db, "lib.ts", 3, "dynamic call: obj[k]");
    addBlind(db, "lib.ts", 4, "test-global: describe");
    addBlind(db, "a.ts", 3, "dynamic call: x");
    expect(impact(db, "lib.ts#target").blind_spot_count).toBe(1);
  });

  test("dangling edge sources (conservative fan-out ids without nodes) are skipped silently", () => {
    const db = baseGraph();
    db.prepare("INSERT INTO edges (src, dst, kind, file, line, confidence, src_file) VALUES ('ghost.ts#Nope.m', 'lib.ts#target', 'calls', 'ghost.ts', 1, 'conservative', 'ghost.ts')").run();
    const r = impact(db, "lib.ts#target");
    expect(r.items.find((i) => i.id === "ghost.ts#Nope.m")).toBeUndefined();
  });

  test("co_change edges are hints only: reported but never traversed", () => {
    const db = baseGraph();
    db.prepare("INSERT INTO edges (src, dst, kind, file, line, confidence, src_file) VALUES ('lib.ts', 'far.ts', 'co_change', 'lib.ts', 7, 'exact', 'abc123')").run();
    const r = impact(db, "lib.ts#target");
    expect(r.co_change_hints).toEqual([{ file: "far.ts", co_commits: 7, evidence: "abc123" }]);
    expect(r.items.find((i) => i.id === "far.ts")).toBeUndefined();
  });

  test("unknown target throws instead of returning an empty set", () => {
    expect(() => impact(baseGraph(), "nope.ts#x")).toThrow(/node not found/);
  });
});
