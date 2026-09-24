import { describe, expect, test } from "bun:test";
import { reviewDecision } from "../src/pr-decision";
import type { GraphDiff, NodeDelta } from "../src/graph-diff";

const emptyDiff = (): GraphDiff => ({
  nodesAdded: [], nodesRemoved: [], renamed: [], edgesAdded: [], edgesRemoved: [], visibilityChanged: [], signatureChanged: [],
});
const added = (name = "created"): NodeDelta => ({ id: `src/a.ts#${name}`, kind: "function", name, file: "src/a.ts", line: 3 });

function decide(diff = emptyDiff(), overrides = {}) {
  return reviewDecision({ diff, prodNodesAdded: diff.nodesAdded, bodyChanged: [], affectedTests: 0, truncated: false, blindSpotCount: 0, ...overrides });
}

describe("reviewDecision", () => {
  test("additive production symbols without affected tests are low risk", () => {
    const diff = emptyDiff(); diff.nodesAdded.push(added());
    expect(decide(diff)).toMatchObject({ risk: "low", reasons: ["1 production symbol was added"] });
  });

  test("export contraction and symbol removal are high risk", () => {
    const diff = emptyDiff();
    diff.visibilityChanged.push({ id: "src/a.ts#api", name: "api", kind: "function", file: "src/a.ts", line: 1, nowExported: false });
    diff.nodesRemoved.push(added("removed"));
    const decision = decide(diff);
    expect(decision.risk).toBe("high");
    expect(decision.reasons).toContain("1 exported symbol is no longer public");
    expect(decision.recommendedActions[0]).toMatch(/public API/);
  });

  test("signature changes, body changes, affected tests and blind spots produce targeted guidance", () => {
    const diff = emptyDiff();
    diff.signatureChanged.push({ id: "src/a.ts#api", name: "api", kind: "function", file: "src/a.ts", line: 1, from: "a:string", to: "a:string,b:number" });
    const decision = decide(diff, {
      bodyChanged: [{ id: "src/a.ts#api", name: "api", kind: "function", file: "src/a.ts", line: 1 }],
      affectedTests: 3,
      blindSpotCount: 2,
    });
    expect(decision.risk).toBe("medium");
    expect(decision.recommendedActions.join(" ")).toContain("3 predicted affected test files");
    expect(decision.recommendedActions.join(" ")).toContain("blind spots");
  });

  test("truncation is high risk and requires the full suite", () => {
    const decision = decide(emptyDiff(), { truncated: true, affectedTests: 4 });
    expect(decision.risk).toBe("high");
    expect(decision.recommendedActions).toContain("Run the full test suite; the reported impact list is truncated.");
  });
});

test("unified safety output keeps the merge decision vocabulary stable", () => {
  const decision = reviewDecision({ diff: emptyDiff(), prodNodesAdded: [], bodyChanged: [], affectedTests: 0, truncated: false, blindSpotCount: 0 });
  expect(["high", "medium", "low"]).toContain(decision.risk);
  expect(decision.recommendedActions.length).toBeGreaterThan(0);
});
