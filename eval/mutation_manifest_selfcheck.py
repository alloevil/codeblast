#!/usr/bin/env python3
import json
from pathlib import Path

manifest = json.loads(Path("eval/mutants/trpc-modern-573d4f3.json").read_text())
expected = [
    "packages/server/src/unstable-core-do-not-import/stream/utils/disposable.ts#makeResource",
    "packages/server/src/observable/operators.ts#distinctUntilChanged",
    "packages/server/src/unstable-core-do-not-import/stream/sse.ts#sseStreamProducer",
]
assert manifest["commit"] == "573d4f33ee2896c2bb7106203a936ae892d1ef1c"
assert manifest["mutants"] == expected
print("fixed mutant manifest passed")
