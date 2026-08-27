"""
M1 验收 — 变异测试对照（方法照 arXiv:1812.06286）。

每个变异点：
1. 有测试覆盖的源码函数注入变异（函数体首行 throw）。
2. 跑【全量】vitest → 失败测试文件 = ground truth。
3. 召回命中 = 引擎预测的 tests 文件集 ⊇ 真实失败文件集。
4. 恢复文件。

召回率硬门槛 100%；精确率报实数。
"""
import json
import sqlite3
import subprocess
from pathlib import Path

REPO = Path("/tmp/trpc")
DB = "/tmp/trpc-full.db"
ATLAS = Path.home() / "projects/codeatlas"
N_MUTANTS = 10

def impact_test_files(node_id: str) -> set[str]:
    out = subprocess.run(
        ["bun", "run", "src/impact-cli.ts", DB, node_id, "--max", "100000", "--json"],
        cwd=ATLAS, capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr[:500])
    data = json.loads(out.stdout)
    return {it["file"] for it in data["items"] if it["level"] == "tests"}

def run_full_vitest() -> set[str] | None:
    """全量测试，返回失败测试文件相对路径集合；报告解析失败返回 None。"""
    out = subprocess.run(
        ["pnpm", "vitest", "run", "--reporter=json", "--passWithNoTests"],
        cwd=REPO, capture_output=True, text=True, timeout=1800,
    )
    for line in reversed(out.stdout.splitlines()):
        if line.startswith("{"):
            report = json.loads(line)
            failed = set()
            for tr in report.get("testResults", []):
                if tr.get("status") == "failed":
                    p = Path(tr["name"])
                    failed.add(str(p.relative_to(REPO)) if p.is_absolute() else str(p))
            return failed
    return None

def mutate(file_path: Path, line_no: int) -> str | None:
    original = file_path.read_text()
    lines = original.splitlines(keepends=True)
    for i in range(line_no - 1, min(line_no + 10, len(lines))):
        if lines[i].rstrip().endswith("{"):
            indent = " " * (len(lines[i]) - len(lines[i].lstrip()) + 2)
            lines.insert(i + 1, f"{indent}throw new Error('MUTATION');\n")
            file_path.write_text("".join(lines))
            return original
    return None

def main():
    con = sqlite3.connect(DB)
    candidates = con.execute("""
        SELECT DISTINCT n.id, n.file, n.line FROM nodes n
        JOIN edges e ON e.dst = n.id AND e.kind = 'tests'
        WHERE n.kind IN ('function','method')
          AND n.file NOT LIKE '%test%' AND n.file NOT LIKE '%__tests__%'
        ORDER BY RANDOM()
    """).fetchall()
    print(f"total candidates: {len(candidates)}, running {N_MUTANTS} mutants")

    # 基线：未变异时的失败集（flaky/环境性失败要从 ground truth 里扣除）
    baseline = run_full_vitest()
    if baseline is None:
        raise SystemExit("baseline vitest report unparsable")
    print(f"baseline failing files (excluded from ground truth): {len(baseline)}")

    results, done = [], 0
    for node_id, rel_file, line in candidates:
        if done >= N_MUTANTS:
            break
        abs_file = REPO / rel_file
        predicted = impact_test_files(node_id)
        original = mutate(abs_file, line)
        if original is None:
            continue
        try:
            failed = run_full_vitest()
        finally:
            abs_file.write_text(original)
        if failed is None:
            continue
        truth = failed - baseline
        if not truth:
            results.append({"node": node_id, "note": "mutant not killed (dead code path or type-only)"})
            done += 1
            continue
        missed = truth - predicted
        precision = len(truth) / len(predicted) if predicted else 0.0
        results.append({
            "node": node_id,
            "truth": len(truth), "predicted": len(predicted),
            "missed": sorted(missed), "recall_hit": not missed,
            "precision": round(precision, 3),
        })
        done += 1
        status = "HIT" if not missed else f"MISS {sorted(missed)}"
        print(f"[{done}/{N_MUTANTS}] {node_id}: truth={len(truth)} predicted={len(predicted)} {status}")

    killed = [r for r in results if "recall_hit" in r]
    hits = sum(1 for r in killed if r["recall_hit"])
    print("\n=== SUMMARY ===")
    print(f"mutants run: {len(results)}, killed: {len(killed)}")
    if killed:
        print(f"recall: {hits}/{len(killed)} = {hits/len(killed):.0%}")
        print(f"mean precision: {sum(r['precision'] for r in killed)/len(killed):.3f}")
    Path("/tmp/mutation_results.json").write_text(json.dumps(results, indent=2))
    print("details: /tmp/mutation_results.json")

if __name__ == "__main__":
    main()
