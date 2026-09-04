"""
M1 验收 — 变异测试对照（方法照 arXiv:1812.06286）。

每个变异点：
1. 有测试覆盖的源码函数注入变异（函数体首行 throw）。
2. 跑【全量】测试（vitest 或 jest，按目标仓 package.json 自动识别）→ 失败测试文件 = ground truth。
3. 召回命中 = 引擎预测的 tests 文件集 ⊇ 真实失败文件集。
4. 恢复文件。

召回率硬门槛 100%；精确率报实数。

用法: python3 eval/mutation_check.py [REPO] [DB] [N_MUTANTS] [--runner auto|vitest|jest]
"""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

def _pop_runner(argv: list[str]) -> str:
    for i, a in enumerate(argv):
        if a == "--runner" and i + 1 < len(argv):
            del argv[i]
            return argv.pop(i)
        if a.startswith("--runner="):
            del argv[i]
            return a.split("=", 1)[1]
    return "auto"

ARGV = sys.argv[1:]
RUNNER_ARG = _pop_runner(ARGV)
if RUNNER_ARG not in ("auto", "vitest", "jest"):
    raise SystemExit(f"--runner must be auto|vitest|jest, got {RUNNER_ARG!r}")

REPO = Path(ARGV[0]) if len(ARGV) > 0 else Path("/tmp/trpc")
DB = ARGV[1] if len(ARGV) > 1 else "/tmp/trpc-full.db"
ATLAS = Path(__file__).resolve().parent.parent
N_MUTANTS = int(ARGV[2]) if len(ARGV) > 2 else 10

def detect_runner() -> str:
    """从目标仓根 package.json 识别测试框架；无 jest 迹象时默认 vitest（保持原行为）。"""
    if RUNNER_ARG != "auto":
        return RUNNER_ARG
    try:
        pkg = json.loads((REPO / "package.json").read_text())
    except (OSError, ValueError):
        return "vitest"
    deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
    if "vitest" in deps:
        return "vitest"
    if "jest" in deps or "jest" in pkg.get("scripts", {}).get("test", ""):
        return "jest"
    return "vitest"

RUNNER = detect_runner()

def impact_test_files(node_id: str) -> set[str]:
    out = subprocess.run(
        ["node", "dist/bin.js", "impact", DB, node_id, "--max", "100000", "--json"],
        cwd=ATLAS, capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr[:500])
    data = json.loads(out.stdout)
    all_files = {it["file"] for it in data["items"] if it["level"] == "tests"}
    call_files = {it["file"] for it in data["items"] if it["level"] == "tests" and it.get("channel") == "call"}
    return all_files, call_files

def failed_files(report: dict) -> set[str]:
    """vitest json reporter 与 jest --json 同构：testResults[].{name,status}。"""
    failed = set()
    for tr in report.get("testResults", []):
        if tr.get("status") == "failed":
            p = Path(tr["name"])
            failed.add(str(p.relative_to(REPO)) if p.is_absolute() else str(p))
    return failed

def run_full_vitest() -> set[str] | None:
    """全量测试，返回失败测试文件相对路径集合；报告解析失败返回 None。"""
    if RUNNER == "jest":
        return run_full_jest()
    out = subprocess.run(
        ["pnpm", "vitest", "run", "--reporter=json", "--passWithNoTests"],
        cwd=REPO, capture_output=True, text=True, timeout=1800,
    )
    for line in reversed(out.stdout.splitlines()):
        if line.startswith("{"):
            return failed_files(json.loads(line))
    return None

def run_full_jest() -> set[str] | None:
    """jest 全量：--json --outputFile 落盘（stdout 混有 console 输出，不可靠）。"""
    fd, out_path = tempfile.mkstemp(prefix="jest-", suffix=".json")
    os.close(fd)
    try:
        subprocess.run(
            ["npx", "jest", "--ci", "--no-watchman", "--passWithNoTests",
             "--json", f"--outputFile={out_path}"],
            cwd=REPO, capture_output=True, text=True, timeout=1800,
            env={**os.environ, "CI": "true", "NODE_NO_WARNINGS": "1",
                 "NODE_OPTIONS": os.environ.get("NODE_OPTIONS", "--max-old-space-size=8192")},
        )
        try:
            return failed_files(json.loads(Path(out_path).read_text()))
        except (OSError, ValueError):
            return None
    finally:
        try:
            os.unlink(out_path)
        except OSError:
            pass

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
    print(f"runner: {RUNNER}")

    # 基线：未变异时的失败集（flaky/环境性失败要从 ground truth 里扣除）
    baseline = run_full_vitest()
    if baseline is None:
        raise SystemExit(f"baseline {RUNNER} report unparsable")
    print(f"baseline failing files (excluded from ground truth): {len(baseline)}")

    results, done = [], 0
    for node_id, rel_file, line in candidates:
        if done >= N_MUTANTS:
            break
        abs_file = REPO / rel_file
        predicted, predicted_call = impact_test_files(node_id)
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
        missed_call = truth - predicted_call
        precision = len(truth) / len(predicted) if predicted else 0.0
        precision_call = len(truth & predicted_call) / len(predicted_call) if predicted_call else 0.0
        results.append({
            "node": node_id,
            "truth": len(truth), "predicted": len(predicted),
            "missed": sorted(missed), "recall_hit": not missed,
            "precision": round(precision, 3),
            "predicted_call": len(predicted_call),
            "call_recall_hit": not missed_call,
            "precision_call": round(precision_call, 3),
        })
        done += 1
        status = "HIT" if not missed else f"MISS {sorted(missed)}"
        call_status = "call:HIT" if not missed_call else f"call:MISS({len(missed_call)})"
        print(f"[{done}/{N_MUTANTS}] {node_id}: truth={len(truth)} pred={len(predicted)}/{len(predicted_call)} {status} {call_status}")

    killed = [r for r in results if "recall_hit" in r]
    hits = sum(1 for r in killed if r["recall_hit"])
    print("\n=== SUMMARY ===")
    print(f"mutants run: {len(results)}, killed: {len(killed)}")
    if killed:
        print(f"recall: {hits}/{len(killed)} = {hits/len(killed):.0%}")
        print(f"mean precision: {sum(r['precision'] for r in killed)/len(killed):.3f}")
        call_hits = sum(1 for r in killed if r.get("call_recall_hit"))
        print(f"call-channel recall: {call_hits}/{len(killed)} = {call_hits/len(killed):.0%}")
        print(f"call-channel mean precision: {sum(r.get('precision_call', 0) for r in killed)/len(killed):.3f}")
    from datetime import date
    out_name = f"/tmp/mutation-{date.today()}-{REPO.name}-n{len(results)}.json"
    Path(out_name).write_text(json.dumps(results, indent=2))
    print(f"details: {out_name}")

if __name__ == "__main__":
    main()
