#!/usr/bin/env python3
import json
import sys
from pathlib import Path

if len(sys.argv) != 3:
    raise SystemExit("usage: compare-mutation-runs.py first.json second.json")

first = json.loads(Path(sys.argv[1]).read_text())
second = json.loads(Path(sys.argv[2]).read_text())


def normalize(rows):
    return [
        {
            "node": row.get("node"),
            "truth": row.get("truth"),
            "missed": row.get("missed", []),
            "recall_hit": row.get("recall_hit"),
            "note": row.get("note"),
        }
        for row in rows
    ]

left = normalize(first)
right = normalize(second)
if left != right:
    print(json.dumps({"stable": False, "first": left, "second": right}, indent=2))
    raise SystemExit(1)
print(json.dumps({"stable": True, "mutants": len(left), "nodes": [row["node"] for row in left]}))
