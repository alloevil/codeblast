#!/usr/bin/env bash
# 重建全部验收基准环境（终端中断/机器重启后从零恢复）。
# 用法: bash eval/setup_benchmarks.sh
# 产物: /tmp/trpc /tmp/tabby /tmp/graphql-tools（源码+依赖）,
#       /tmp/trpc-full.db /tmp/tabby.db /tmp/graphql-tools.db（图谱）
set -euo pipefail
ATLAS="$(cd "$(dirname "$0")/.." && pwd)"

echo "== trpc (标准 TS monorepo, 变异测试/PR 回放基准) =="
if [ ! -d /tmp/trpc/.git ]; then
  git clone --depth 300 https://github.com/trpc/trpc.git /tmp/trpc
fi
cd /tmp/trpc
corepack enable 2>/dev/null || true
pnpm install --ignore-scripts

echo "== tabby (脏仓基准: 平铺 workspace + Angular 装饰器) =="
if [ ! -d /tmp/tabby/.git ]; then
  git clone --depth 1 https://github.com/Eugeny/tabby /tmp/tabby
fi
cd /tmp/tabby
yarn install --ignore-scripts --ignore-engines

echo "== graphql-tools (jest 基准: npm workspaces, babel-jest, 92 suites ~16s) =="
if [ ! -d /tmp/graphql-tools/.git ]; then
  git clone --depth 400 https://github.com/ardatan/graphql-tools.git /tmp/graphql-tools
fi
cd /tmp/graphql-tools
# 跳过 Chromium 下载；url-loader-browser.spec.ts 因此基线失败，变异脚本会从 ground truth 扣除
PUPPETEER_SKIP_DOWNLOAD=true npm install --ignore-scripts --no-audit --no-fund

echo "== 建图 =="
cd "$ATLAS"
rm -f /tmp/trpc-full.db* /tmp/tabby.db* /tmp/graphql-tools.db*
bun run src/cli.ts /tmp/trpc --db /tmp/trpc-full.db
bun run src/cli.ts /tmp/tabby --db /tmp/tabby.db
bun run src/cli.ts /tmp/graphql-tools --db /tmp/graphql-tools.db
bun run src/cochange.ts /tmp/trpc /tmp/trpc-full.db --commits 300

echo "== 冒烟 =="
bun run src/impact-cli.ts /tmp/trpc-full.db "createBuilder" --json | head -c 200; echo
echo "OK — 验收命令:"
echo "  python3 eval/mutation_check.py /tmp/trpc /tmp/trpc-full.db 10   # 召回率必须 100%"
echo "  python3 eval/mutation_check.py /tmp/graphql-tools /tmp/graphql-tools.db 10   # jest 路径，召回率必须 100%"
echo "  python3 eval/pr_replay.py                                        # 50 提交回放"
