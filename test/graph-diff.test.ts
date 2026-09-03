import { describe, expect, test } from "bun:test";
import { graphDiff, foldToModules } from "../src/graph-diff";
import { memGraph } from "./helpers";

describe("graph-diff", () => {
  test("node added / removed detected by id set difference", () => {
    const a = memGraph([{ id: "a.ts#old" }]);
    const b = memGraph([{ id: "a.ts#new", line: 100 }]); // 行号相差 >30,不算 rename
    const d = graphDiff(a, b);
    expect(d.nodesAdded.map((n) => n.id)).toEqual(["a.ts#new"]);
    expect(d.nodesRemoved.map((n) => n.id)).toEqual(["a.ts#old"]);
    expect(d.renamed).toEqual([]);
  });

  test("file nodes are excluded from node diff", () => {
    const a = memGraph([{ id: "a.ts" }]);
    const b = memGraph([{ id: "b.ts" }]);
    const d = graphDiff(a, b);
    expect(d.nodesAdded).toEqual([]);
    expect(d.nodesRemoved).toEqual([]);
  });

  test("same-file rename: same kind + line delta <=30 becomes renamed, not add+remove", () => {
    const a = memGraph([{ id: "a.ts#foo", line: 10 }]);
    const b = memGraph([{ id: "a.ts#bar", line: 25 }]);
    const d = graphDiff(a, b);
    expect(d.renamed).toEqual([{ from: "foo", to: "bar", file: "a.ts", kind: "function" }]);
    expect(d.nodesAdded).toEqual([]);
    expect(d.nodesRemoved).toEqual([]);
  });

  test("exported interface member change is a signatureChanged (blind-review bc215fe: batchIndex field added)", () => {
    const a = memGraph([{ id: "a.ts#Opts", kind: "interface", exported: 1, signature: "id: string" }]);
    const b = memGraph([{ id: "a.ts#Opts", kind: "interface", exported: 1, signature: "id: string; batchIndex?: number" }]);
    const d = graphDiff(a, b);
    expect(d.signatureChanged).toEqual([{ id: "a.ts#Opts", name: "Opts", kind: "interface", file: "a.ts", line: 1, from: "id: string", to: "id: string; batchIndex?: number" }]);
  });

  test("same-file rename requires same kind", () => {
    const a = memGraph([{ id: "a.ts#Foo", kind: "class", line: 10 }]);
    const b = memGraph([{ id: "a.ts#foo", kind: "function", line: 10 }]);
    const d = graphDiff(a, b);
    expect(d.renamed).toEqual([]);
    expect(d.nodesAdded).toHaveLength(1);
    expect(d.nodesRemoved).toHaveLength(1);
  });

  test("cross-file rename (492bacf): same name + kind + line delta <=5 is a file-level rename", () => {
    const a = memGraph([{ id: "src/old.ts#run", line: 12 }]);
    const b = memGraph([{ id: "src/new.ts#run", line: 14 }]);
    const d = graphDiff(a, b);
    expect(d.renamed).toEqual([{ from: "src/old.ts#run", to: "src/new.ts#run", file: "src/new.ts", kind: "function" }]);
    expect(d.nodesAdded).toEqual([]);
    expect(d.nodesRemoved).toEqual([]);
  });

  test("cross-file rename rejected when line delta >5", () => {
    const a = memGraph([{ id: "src/old.ts#run", line: 12 }]);
    const b = memGraph([{ id: "src/new.ts#run", line: 40 }]);
    const d = graphDiff(a, b);
    expect(d.renamed).toEqual([]);
    expect(d.nodesAdded).toHaveLength(1);
    expect(d.nodesRemoved).toHaveLength(1);
  });

  test("signatureChanged only for exported callables whose param text changed", () => {
    const a = memGraph([
      { id: "a.ts#pub", exported: 1, signature: "x: number" },
      { id: "a.ts#priv", exported: 0, signature: "x: number" },
    ]);
    const b = memGraph([
      { id: "a.ts#pub", exported: 1, signature: "x: number, y: string" },
      { id: "a.ts#priv", exported: 0, signature: "x: number, y: string" },
    ]);
    const d = graphDiff(a, b);
    expect(d.signatureChanged).toHaveLength(1);
    expect(d.signatureChanged[0]).toMatchObject({ id: "a.ts#pub", from: "x: number", to: "x: number, y: string" });
  });

  test("signatureChanged ignores empty->empty (non-callable nodes)", () => {
    const a = memGraph([{ id: "a.ts#T", kind: "interface", exported: 1, signature: "" }]);
    const b = memGraph([{ id: "a.ts#T", kind: "interface", exported: 1, signature: "" }]);
    expect(graphDiff(a, b).signatureChanged).toEqual([]);
  });

  test("visibilityChanged (62c6ab0) fires when exported bit flips, with nowExported direction", () => {
    const a = memGraph([{ id: "a.ts#f", exported: 0 }, { id: "a.ts#g", exported: 1 }]);
    const b = memGraph([{ id: "a.ts#f", exported: 1 }, { id: "a.ts#g", exported: 0 }]);
    const d = graphDiff(a, b);
    const byId = Object.fromEntries(d.visibilityChanged.map((v) => [v.id, v.nowExported]));
    expect(byId).toEqual({ "a.ts#f": true, "a.ts#g": false });
  });

  test("structural edge added/removed keyed on (src,dst,kind); line change alone is not a delta", () => {
    const a = memGraph([{ id: "a.ts#f" }, { id: "b.ts#g" }, { id: "b.ts#h" }], [
      { src: "a.ts#f", dst: "b.ts#g", kind: "calls", line: 3 },
    ]);
    const b = memGraph([{ id: "a.ts#f" }, { id: "b.ts#g" }, { id: "b.ts#h" }], [
      { src: "a.ts#f", dst: "b.ts#g", kind: "calls", line: 9 }, // 仅行号变化 → 不是 delta
      { src: "a.ts#f", dst: "b.ts#h", kind: "calls", line: 4 },
    ]);
    const d = graphDiff(a, b);
    expect(d.edgesAdded.map((e) => e.dst)).toEqual(["b.ts#h"]);
    expect(d.edgesRemoved).toEqual([]);
  });

  test("non-structural edges (contains/tests/co_change) never appear in edge diff", () => {
    const a = memGraph([{ id: "a.ts" }, { id: "a.ts#f" }]);
    const b = memGraph([{ id: "a.ts" }, { id: "a.ts#f" }], [
      { src: "a.ts", dst: "a.ts#f", kind: "contains" },
      { src: "t.test.ts#t", dst: "a.ts#f", kind: "tests" },
      { src: "a.ts", dst: "b.ts", kind: "co_change" },
    ]);
    const d = graphDiff(a, b);
    expect(d.edgesAdded).toEqual([]);
  });

  test("foldToModules: monorepo packages/<pkg> folds to pkg, test files fold to 'tests', root files to '(root)'", () => {
    const folded = foldToModules({
      nodesAdded: [
        { id: "packages/server/src/a.ts#x", kind: "function", name: "x", file: "packages/server/src/a.ts", line: 1 },
        { id: "packages/server/src/a.test.ts#t", kind: "test", name: "t", file: "packages/server/src/a.test.ts", line: 1 },
        { id: "index.ts#main", kind: "function", name: "main", file: "index.ts", line: 1 },
      ],
      nodesRemoved: [],
      renamed: [],
      edgesAdded: [{ src: "www/a.ts#f", dst: "b", kind: "calls", file: "www/a.ts", line: 1 }],
      edgesRemoved: [],
      visibilityChanged: [],
      signatureChanged: [],
    });
    expect(folded.get("server")).toEqual({ added: 1, removed: 0, renamed: 0, edgesIn: 0, edgesOut: 0 });
    expect(folded.get("tests")?.added).toBe(1);
    expect(folded.get("(root)")?.added).toBe(1);
    expect(folded.get("www")?.edgesIn).toBe(1);
  });
});
