#!/usr/bin/env node
// filer 自检：验收回归失败时，两个 "Open issue on regression" 步骤必须真能把 issue 开出来。
//
// 背景（#48）：tRPC job 的 `const evidence = [...]` 在自己的初始化式里引用了 `evidence`
// （TDZ，只有在 mutation 日志存在时才进入那个分支）；jest job 只定义了 `log`，body 里却插值
// `${evidence}`。两个步骤都只在「schedule 触发 + 有回归」的路径上执行，每周绿灯把它盖住了 ——
// 真出回归时 filer 自己抛 ReferenceError，回归信号静默丢失（issue #44 收到的那份就是这样）。
//
// 做法：把 acceptance.yml 里每个 filer 步骤的 `script: |` 抠出来，在 node:vm 里用假的
// github / context / fs 各跑三遍（mutation 日志存在 / 读不到 × job 日志下载成功 / 失败），断言：
//   - 块本身不抛错（TDZ / undefined 变量都会在这里现形）
//   - issues.create 被调用恰好一次
//   - body 里有非空代码块、不含 undefined / [object Object]、带本次 run 的链接
// 任何一条不成立 → 退出码 1，并点名 workflow 文件与步骤。
//
// 用法：
//   node eval/filer_selfcheck.mjs [workflow.yml]              # 默认 .github/workflows/acceptance.yml
//   ACCEPTANCE_WORKFLOW=/tmp/acceptance.prefix.yml node eval/filer_selfcheck.mjs
import { readFileSync as realReadFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import vm from 'node:vm';

const WORKFLOW = process.argv[2] || process.env.ACCEPTANCE_WORKFLOW || '.github/workflows/acceptance.yml';
const STEP_NAME = 'Open issue on regression';
const TIMEOUT_MS = 10_000;
const REAL_REQUIRE = createRequire(import.meta.url);

/** 致命问题（读不到文件、结构解析不出来）→ 立刻退出。 */
function fail(message) {
  console.error(`filer self-check: FAIL — ${WORKFLOW}: ${message}`);
  process.exit(1);
}

/** 单个 filer/场景的问题 → 记下来继续跑，让一次运行把所有缺陷摊开。 */
class FilerError extends Error {}
const filerFail = (message) => {
  throw new FilerError(message);
};

const indentOf = (line) => line.match(/^\s*/)[0].length;
const unquote = (s) => (/^(['"]).*\1$/.test(s) ? s.slice(1, -1) : s);

/**
 * 抠出每个名为 STEP_NAME 的步骤里的 `script: |` 块。
 * 手写扫描而不是引 YAML 依赖：跳过整个块标量，避免 run: | 里的内容被误判成步骤。
 */
function extractFilerScripts(text, stepName) {
  const lines = text.split(/\r?\n/);
  const found = [];
  let step = null;

  for (let i = 0; i < lines.length; i++) {
    const nameMatch = /^(\s*)- name:\s*(.*?)\s*$/.exec(lines[i]);
    if (nameMatch) {
      step = { name: unquote(nameMatch[2]), line: i + 1 };
      continue;
    }
    if (!step || step.name !== stepName) continue;

    const scriptMatch = /^(\s*)script:\s*\|\s*$/.exec(lines[i]);
    if (!scriptMatch) continue;

    const indent = indentOf(lines[i]);
    const raw = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (lines[j].trim() === '') {
        raw.push('');
        continue;
      }
      if (indentOf(lines[j]) <= indent) break;
      raw.push(lines[j]);
    }

    const nonBlank = raw.filter((l) => l.trim() !== '');
    if (!nonBlank.length) fail(`step "${step.name}" (line ${step.line}): script block is empty`);
    const base = Math.min(...nonBlank.map(indentOf)); // 块内相对缩进，避免把 YAML 缩进带进 JS
    found.push({
      step: step.name,
      stepLine: step.line,
      scriptLine: i + 1,
      code: raw.map((l) => (l.trim() === '' ? '' : l.slice(base))).join('\n'),
    });

    i = j - 1;
    step = null;
  }
  return found;
}

/** 假 fs / 假 github：log 为 null 表示日志文件不存在（回归发生在更早的步骤）。 */
function makeSandbox({ log, jobLog }) {
  const created = [];
  const jobLogText = 'RUN  step: Install benchmark deps\n├─ pnpm install --ignore-scripts\n└─ Error: exit code 1\n'.repeat(20);

  const fs = {
    readFileSync(path, ...rest) {
      if (/^\/tmp\/mutation(-jest)?\.log$/.test(String(path))) {
        if (log === null) {
          const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
          err.code = 'ENOENT';
          throw err;
        }
        return log;
      }
      return realReadFileSync(path, ...rest);
    },
  };

  const sandbox = {
    created,
    github: {
      rest: {
        issues: {
          create: async (args) => {
            created.push(args);
            return { data: { number: 1, html_url: 'https://github.com/alloevil/codeblast/issues/1' } };
          },
        },
        actions: {
          listJobsForWorkflowRun: async () => ({
            data: {
              jobs: [
                {
                  id: 111,
                  name: 'mutation-recall',
                  conclusion: 'success',
                  steps: [{ name: 'Build graph', conclusion: 'success' }],
                },
                {
                  id: 222,
                  name: 'mutation-recall-jest',
                  conclusion: 'failure',
                  steps: [
                    { name: 'Install benchmark deps', conclusion: 'success' },
                    { name: 'Mutation testing (jest) — recall must be 100%', conclusion: 'failure' },
                  ],
                },
              ],
            },
          }),
          downloadJobLogsForWorkflowRun: async () => {
            if (jobLog === null) throw new Error('job log download failed (410 Gone)');
            return { data: jobLogText };
          },
        },
      },
    },
    context: {
      repo: { owner: 'alloevil', repo: 'codeblast' },
      serverUrl: 'https://github.com',
      runId: 424242,
      eventName: 'schedule',
    },
    require: (id) => (id === 'fs' ? fs : REAL_REQUIRE(id)),
    process: { env: {}, platform: process.platform, version: process.version },
    console: { log() {}, warn() {}, error() {} },
  };
  return sandbox;
}

function assertUsableBody(body, label) {
  if (typeof body !== 'string' || !body.trim()) filerFail(`${label}: issue body is empty`);
  const fences = [...body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
  if (!fences.length) filerFail(`${label}: issue body has no fenced code block`);
  fences.forEach((m, n) => {
    if (!m[1].trim()) filerFail(`${label}: fenced code block #${n + 1} in the body is empty/blank`);
  });
  for (const token of ['undefined', '[object Object]']) {
    if (body.includes(token)) filerFail(`${label}: issue body contains "${token}"`);
  }
  // 一条没有 run 链接的 issue 等于没证据（AGENTS.md: 每条结论带证据）。
  if (!body.includes('/actions/runs/424242')) filerFail(`${label}: issue body is missing the run link`);
}

async function runFiler(block, index, scenario) {
  const label = `line ${block.scriptLine} step "${block.step}" #${index + 1} [${scenario.label}]`;
  try {
    return await runFilerInner(block, label, scenario);
  } catch (err) {
    if (err instanceof FilerError) throw err;
    throw new FilerError(`${label}: unexpected harness error — ${err && err.stack ? err.stack : err}`);
  }
}

async function runFilerInner(block, label, scenario) {
  const sandbox = makeSandbox(scenario);
  const ctx = vm.createContext(sandbox);

  let invoke;
  try {
    // new Function 建在 vm 上下文里 → 块内 new Date / 全局对象都取自该隔离上下文。
    invoke = vm.runInContext(
      "(body) => new Function('github', 'context', 'require', 'process', body)",
      ctx,
      { timeout: TIMEOUT_MS },
    );
  } catch (err) {
    filerFail(`${label}: could not build the filer function — ${err.stack || err}`);
  }

  try {
    // 包一层 async IIFE：步骤里有顶层 await。
    const fn = invoke(`return (async () => {\n${block.code}\n})();\n`);
    await Promise.race([
      fn(sandbox.github, sandbox.context, sandbox.require, sandbox.process),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS).unref()),
    ]);
  } catch (err) {
    filerFail(`${label}: the step threw — ${err && err.stack ? err.stack.split('\n')[0] : err}`);
  }

  if (sandbox.created.length !== 1) {
    filerFail(`${label}: expected issues.create to be called exactly once, got ${sandbox.created.length}`);
  }
  const call = sandbox.created[0];
  if (!call.title || !String(call.title).trim()) filerFail(`${label}: issue title is empty`);
  if (!Array.isArray(call.labels) || !call.labels.includes('acceptance-regression')) {
    filerFail(`${label}: issue is not labelled acceptance-regression`);
  }
  assertUsableBody(call.body, label);
  return `${label} ${call.body.length}B`;
}

const SCENARIOS = [
  // 正常回归：mutation 日志被 tee 到了 /tmp，这是 #48 那个 TDZ 真正会炸的分支。
  { label: 'mutation log present, job log ok', log: 'mutant 3/4: recall 3/4 = 75%\nrecall: 3/4 = 75\n'.repeat(3), jobLog: 'ok' },
  // 失败发生在更早的步骤（安装/建图）→ 日志文件根本不存在。
  { label: 'mutation log unreadable, job log ok', log: null, jobLog: 'ok' },
  // 最难的一条：日志没有、job 日志也下不动 —— 仍然要在 failed steps 里留下可核对的信息。
  { label: 'mutation log unreadable, job log download fails', log: null, jobLog: null },
];

const yaml = (() => {
  try {
    return realReadFileSync(WORKFLOW, 'utf8');
  } catch (err) {
    return fail(`cannot read ${WORKFLOW} — ${err.message}`);
  }
})();

const filers = extractFilerScripts(yaml, STEP_NAME);
if (!filers.length) fail(`no step named "${STEP_NAME}" with a "script: |" block found`);

const ok = [];
const failures = [];
for (const [i, block] of filers.entries()) {
  for (const scenario of SCENARIOS) {
    try {
      ok.push(await runFiler(block, i, scenario));
    } catch (err) {
      failures.push(err instanceof FilerError ? err.message : `${err && err.stack ? err.stack : err}`);
    }
  }
}

if (failures.length) {
  for (const message of failures) console.error(`filer self-check: FAIL — ${message}`);
  console.error(
    `filer self-check: FAIL — ${failures.length} of ${ok.length + failures.length} check(s) failed in ${WORKFLOW}`,
  );
  process.exit(1);
}

for (const line of ok) console.log(`filer self-check: ok — ${line}`);
console.log(
  `filer self-check: ok — ${filers.length} filer step(s) × ${SCENARIOS.length} scenario(s), ${ok.length}/${ok.length} bodies usable`,
);
