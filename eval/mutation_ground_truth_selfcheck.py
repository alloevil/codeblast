#!/usr/bin/env python3
from mutation_ground_truth import remove_clean_failures

truth = {"server.test.ts", "upgrade/transforms.test.ts"}
predicted = {"server.test.ts"}
filtered, reproduced = remove_clean_failures(
    truth,
    predicted,
    isolated_clean_failures=set(),
    full_clean_failures={"upgrade/transforms.test.ts"},
)
assert filtered == {"server.test.ts"}, filtered
assert reproduced == {"upgrade/transforms.test.ts"}, reproduced

# A clean full-suite run must not hide a genuine graph miss.
unchanged, reproduced = remove_clean_failures(truth, predicted, set(), set())
assert unchanged == truth, unchanged
assert reproduced == set(), reproduced
print("mutation ground-truth filtering passed")
