<!-- fix(server): use correct call index in batch stream error handling (#7262) -->
## 🧭 codeblast · 结构变更分析

**2 项结构变更**（符号 +0 −0 ↻0，依赖边 +2 −0）

| 模块 | 符号变化 | 依赖变化 |
|---|---|---|
| client | +0 −0 ↻0 | +1 −0 |
| tests | +0 −0 ↻0 | +1 −0 |

### 新增依赖

- `fetch` → `ResponseEsque.json` （packages/client/src/links/httpBatchStreamLink.ts:107）
- `packages/tests/server/batching.test.ts` → `TRPCError` （packages/tests/server/batching.test.ts:71）

### 函数体内改动（结构未变,行为可能变）

| 函数 | 调用链影响 | 受影响测试 | 位置 |
|---|---|---|---|
| `fetch` | 0 | 0 | packages/client/src/links/httpBatchStreamLink.ts:68 |
| `resolveResponse` | 66 | 33 | packages/server/src/unstable-core-do-not-import/http/resolveResponse.ts:218 |

<sub>由 [codeblast](https://github.com/alloevil/codeblast) 生成 · 每条结论基于静态分析,含证据链接 · 动态调用盲区不在本报告内</sub>
