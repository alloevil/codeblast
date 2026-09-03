import { describe, expect, test } from "bun:test";
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
});
