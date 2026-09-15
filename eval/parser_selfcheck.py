"""解析器自检：喂进带 pnpm 横幅 + 多行 JSON 的 vitest 输出，必须能解析出来。

这就是 #45 的真实形态：报告本身是好的，只是解析方式不对（原来是"倒着找以 { 开头的行"）。
"""
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("mc", "eval/mutation_check.py")
mc = importlib.util.module_from_spec(spec)
sys.modules["mc"] = mc
spec.loader.exec_module(mc)

BANNER = "Progress: resolved 1, reused 1, downloaded 0, added 0\n> @trpc/server@11.0.0 test\n> vitest\n"
REPORT = {
    "numTotalTests": 3,
    "testResults": [
        {"name": "/tmp/trpc/packages/server/src/a.test.ts", "status": "passed"},
        {"name": "/tmp/trpc/packages/server/src/b.test.ts", "status": "failed"},
    ],
}
expected = {"packages/server/src/b.test.ts"}
cases = {
    "banner + 多行 JSON": BANNER + json.dumps(REPORT, indent=2),
    "单行 JSON": BANNER + json.dumps(REPORT),
    "JSON 前后有杂音": "noise\n" + json.dumps(REPORT, indent=2) + "\ntrailing noise\n",
}
for label, text in cases.items():
    report = mc._load_report(text)
    assert report is not None, f"{label}: 解析失败"
    assert mc.failed_files(report) == expected, f"{label}: 失败集合不对"
print("parser self-check: ok —", ", ".join(cases))
