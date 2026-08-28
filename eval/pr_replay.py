#!/usr/bin/env python3
"""M4 验收 — 50 个真实提交回放 PR bot，统计静默率与评论产出。"""
import json
import subprocess
import sys
import time
from pathlib import Path

REPO = "/tmp/trpc"
ATLAS = Path.home() / "projects/codeblast"
OUT_DIR = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("/tmp/pr-replay")
OUT_DIR.mkdir(exist_ok=True)
SKIP = int(sys.argv[1]) if len(sys.argv) > 1 else 0
N = 50

commits = subprocess.run(
    ["git", "log", "--oneline", "--no-merges", "--format=%h %s", "origin/main", f"--skip={SKIP}", f"-{N}"],
    cwd=REPO, capture_output=True, text=True,
).stdout.strip().splitlines()

results = []
for i, line in enumerate(commits, 1):
    sha, _, subject = line.partition(" ")
    t0 = time.time()
    p = subprocess.run(
        ["bun", "run", "src/pr-comment.ts", REPO, f"{sha}~1", sha],
        cwd=ATLAS, capture_output=True, text=True, timeout=600,
    )
    dt = round(time.time() - t0, 1)
    comment = p.stdout.strip()
    ok = p.returncode == 0
    results.append({
        "sha": sha, "subject": subject[:80], "ok": ok,
        "silent": ok and not comment, "seconds": dt,
        "comment_lines": len(comment.splitlines()) if comment else 0,
    })
    if comment:
        (OUT_DIR / f"{i:02d}-{sha}.md").write_text(f"<!-- {subject} -->\n{comment}\n")
    status = "SILENT" if not comment else f"{len(comment.splitlines())}L"
    err = "" if ok else f" ERR:{p.stderr.strip().splitlines()[-1][:60] if p.stderr.strip() else '?'}"
    print(f"[{i}/{len(commits)}] {sha} {dt}s {status}{err} | {subject[:60]}", flush=True)

silent = sum(1 for r in results if r["silent"])
failed = sum(1 for r in results if not r["ok"])
commented = len(results) - silent - failed
print(f"\n=== SUMMARY === total={len(results)} commented={commented} silent={silent} failed={failed}")
print(f"mean_seconds={sum(r['seconds'] for r in results)/len(results):.0f}")
Path("/tmp/pr-replay/results.json").write_text(json.dumps(results, indent=1))
