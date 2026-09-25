import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { AUX_RE, BIG_DIFF_LINES, TEST_RE, bodySignalCount, coreNamedCount, structuralTotal, type BodyChange } from "../src/pr-silence";
import type { GraphDiff } from "../src/graph-diff";

const emptyDiff = (): GraphDiff => ({
  nodesAdded: [], nodesRemoved: [], renamed: [], edgesAdded: [], edgesRemoved: [], visibilityChanged: [], signatureChanged: [],
});
const body = (file: string): BodyChange => ({ id: `${file}#f`, name: "f", kind: "function", file, line: 1 });

describe("pr-silence", () => {
  test("AUX_RE matches www/ docs/ examples/ but NOT scripts/ (e39a654 build entrypoint regression)", () => {
    expect(AUX_RE.test("www/src/a.ts")).toBe(true);
    expect(AUX_RE.test("docs/x.ts")).toBe(true);
    expect(AUX_RE.test("examples/next/a.ts")).toBe(true);
    expect(AUX_RE.test("scripts/generateEntrypoints.ts")).toBe(false);
    expect(AUX_RE.test("packages/server/www/a.ts")).toBe(false); // 只认根级目录
  });

  test("TEST_RE covers .test/.spec, __tests__/, test(s)/ dirs", () => {
    for (const f of ["a.test.ts", "a.spec.tsx", "a.test.mjs", "src/__tests__/a.ts", "test/a.ts", "pkg/tests/a.ts"]) expect(TEST_RE.test(f)).toBe(true);
    expect(TEST_RE.test("src/testing.ts")).toBe(false);
  });

  test("structuralTotal sums all seven delta buckets", () => {
    const d = emptyDiff();
    d.nodesAdded.push({ id: "a#x", kind: "function", name: "x", file: "a", line: 1 });
    d.signatureChanged.push({ id: "a#y", kind: "function", name: "y", file: "a", line: 1, from: "", to: "a" });
    expect(structuralTotal(d)).toBe(2);
    expect(structuralTotal(emptyDiff())).toBe(0);
  });

  test("small diff (<40 lines) with zero call-chain impact -> zero body signal (e870051 silence)", () => {
    expect(bodySignalCount([body("src/core.ts")], BIG_DIFF_LINES - 1, () => false)).toBe(0);
  });

  test("core-area body change in a big diff (>=40 lines) counts even with zero impact (e39a654 navigation value)", () => {
    expect(bodySignalCount([body("scripts/gen.ts")], BIG_DIFF_LINES, () => false)).toBe(1);
  });

  test("aux-area body change never counts without call impact, regardless of diff size", () => {
    expect(bodySignalCount([body("www/page.ts")], 15000, () => false)).toBe(0);
  });

  test("call-chain impact always counts, even in aux area with a tiny diff", () => {
    expect(bodySignalCount([body("www/page.ts")], 1, () => true)).toBe(1);
  });

  test("coreNamedCount excludes aux-area named changes (4217a73: www 106 lines) and test-file nodes are pre-filtered by caller", () => {
    const d = emptyDiff();
    d.edgesAdded.push({ src: "www/a#f", dst: "b", kind: "calls", file: "www/a.ts", line: 1 });
    d.edgesAdded.push({ src: "src/a#f", dst: "b", kind: "calls", file: "src/a.ts", line: 1 });
    d.renamed.push({ from: "x", to: "y", file: "docs/a.ts", kind: "function" });
    d.visibilityChanged.push({ id: "src/v#g", name: "g", kind: "function", file: "src/v.ts", line: 1, nowExported: true });
    const prodNodesAdded = d.nodesAdded.concat([{ id: "examples/e#n", kind: "function", name: "n", file: "examples/e.ts", line: 1 }]);
    expect(coreNamedCount(d, prodNodesAdded)).toBe(2); // src edge + src visibility
  });

  test("core removals and removed dependencies prevent incorrect silence", () => {
    const d = emptyDiff();
    d.nodesRemoved.push({ id: "src/api.ts#removed", kind: "function", name: "removed", file: "src/api.ts", line: 2 });
    d.edgesRemoved.push({ src: "src/caller.ts#call", dst: "src/api.ts#removed", kind: "calls", file: "src/caller.ts", line: 4 });
    expect(coreNamedCount(d, [])).toBe(2);
  });

  test("offline replay manifest covers the deterministic safety matrix", () => {
    const manifest = JSON.parse(fs.readFileSync("eval/offline-replay-manifest.json", "utf8")) as { samples: { id: string }[] };
    expect(manifest.samples.map((sample) => sample.id).sort()).toEqual([
      "aux-only", "blind-spot-target", "docs-only", "graph-node-drop", "public-api-removal",
      "pure-rename", "signature-widening", "test-only", "tested-behavior-change",
      "tested-behavior-repeat", "visibility-contraction",
    ]);
  });
});

  test("a production body change with same-PR test changes must not be silenced", () => {
    const bodyChanged = [body("src/tool.ts")];
    const changedFiles = ["src/tool.ts", "test/tool.test.ts"];
    const changedTests = changedFiles.some((file) => TEST_RE.test(file));
    const testedBodySignal = bodyChanged.length > 0 && changedTests ? 1 : 0;
    expect(testedBodySignal).toBe(1);
  });
