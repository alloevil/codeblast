import type { GraphDiff, NodeDelta } from "./graph-diff";
import type { BodyChange } from "./pr-silence";

export type ReviewRisk = "high" | "medium" | "low";

export interface ReviewDecision {
  risk: ReviewRisk;
  summary: string;
  reasons: string[];
  recommendedActions: string[];
}

export interface ReviewDecisionInput {
  diff: GraphDiff;
  prodNodesAdded: readonly NodeDelta[];
  bodyChanged: readonly BodyChange[];
  affectedTests: number;
  truncated: boolean;
  blindSpotCount: number;
}

/**
 * Turn structural facts into a reviewer decision without inventing semantic meaning.
 * High risk is reserved for API removals/contractions or an incomplete impact result.
 */
export function reviewDecision(input: ReviewDecisionInput): ReviewDecision {
  const { diff, prodNodesAdded, bodyChanged, affectedTests, truncated, blindSpotCount } = input;
  const apiContractions = diff.visibilityChanged.filter((v) => !v.nowExported).length;
  const apiChanges = apiContractions + diff.signatureChanged.length;
  const renames = diff.renamed.length;
  const removals = diff.nodesRemoved.length;
  const behaviorChanges = bodyChanged.length;
  const reasons: string[] = [];
  const recommendedActions: string[] = [];
  let risk: ReviewRisk = "low";
  if (apiContractions > 0 || removals > 0 || truncated) risk = "high";
  else if (apiChanges > 0 || renames > 0 || behaviorChanges > 0 || affectedTests > 0 || blindSpotCount > 0) risk = "medium";

  if (apiContractions > 0) reasons.push(`${apiContractions} exported symbol${apiContractions === 1 ? " is" : "s are"} no longer public`);
  if (removals > 0) reasons.push(`${removals} symbol${removals === 1 ? " was" : "s were"} removed`);
  if (diff.signatureChanged.length > 0) reasons.push(`${diff.signatureChanged.length} exported signature${diff.signatureChanged.length === 1 ? " changed" : "s changed"}`);
  if (renames > 0) reasons.push(`${renames} symbol${renames === 1 ? " was" : "s were"} renamed`);
  if (behaviorChanges > 0) reasons.push(`${behaviorChanges} function bod${behaviorChanges === 1 ? "y" : "ies"} changed`);
  if (truncated) reasons.push("the impact set exceeded the reporting limit");
  if (blindSpotCount > 0) reasons.push(`${blindSpotCount} static-analysis blind spot${blindSpotCount === 1 ? "" : "s"} may hide impact`);
  if (reasons.length === 0 && prodNodesAdded.length > 0) reasons.push(`${prodNodesAdded.length} production symbol${prodNodesAdded.length === 1 ? " was" : "s were"} added`);
  if (reasons.length === 0) reasons.push("only low-risk structural additions were found");

  if (apiChanges > 0 || removals > 0) recommendedActions.push("Review the public API changes and migration impact.");
  if (truncated) recommendedActions.push("Run the full test suite; the reported impact list is truncated.");
  else if (affectedTests > 0) recommendedActions.push(`Run the ${affectedTests} predicted affected test file${affectedTests === 1 ? "" : "s"}.`);
  if (blindSpotCount > 0) recommendedActions.push("Inspect the reported blind spots before treating the impact set as complete.");
  if (behaviorChanges > 0) recommendedActions.push("Review the changed function bodies even where the exported shape is unchanged.");
  if (recommendedActions.length === 0) recommendedActions.push("Review the named structural additions; no existing API contraction was detected.");

  const summary = risk === "high"
    ? "Review before merge: the change removes API surface, deletes symbols, or has an incomplete impact set."
    : risk === "medium"
      ? "Targeted review recommended: behavior, API shape, tests, or blind spots changed."
      : "Low structural risk: only additive changes with no predicted affected tests were found.";

  return { risk, summary, reasons, recommendedActions };
}
