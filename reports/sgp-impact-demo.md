# sgp 项目影响分析报告

> codeblast 方案 B（Python 文件级）试运行 · 2026-08-27
> 索引：71 文件 / 376 节点 / 536 边 / 1344 盲区，全量 0.7s，增量重跑 0.1s

## 查询：改 `solver_transfer/solver_builder.py` 会影响什么？

**30 个文件受影响（直接 3 / 间接 16 / 测试 11），查询 2ms**

⚠️ 目标文件有 165 个盲区（属性链调用等 Python 动态特性），影响可能被低估。

### 直接依赖（改了它们立刻受影响）

| 文件 | 证据位置 |
|---|---|
| examples/multi_solver_example.py | :9 |
| solver_transfer/solver_engine.py | :11 |
| solver_transfer/solver_serializer.py | :16 |

### 传递影响链（关键路径）

```
solver_builder.py
  └─ solver_serializer.py (1跳)
       └─ solver_util.py (2跳)
            └─ copt_client.py / gurobi_client.py / solve_service.py (3跳)
                 └─ sgp_server.py / client_factory.py (4跳)
                      └─ sgp_client/factory.py (5跳)
                           └─ sgp_client/client.py (6跳)
                                └─ sgp_client/examples/* (7跳)
```

含义：**改动求解器构建层，波及一路穿透到客户端 SDK 和全部示例代码**——
这是典型的"底层核心模块"影响形态,7 跳纵深说明该文件处于依赖链最上游。

### 受影响测试（改完该跑什么）

1 跳（直接测目标文件）：
- tests/test_solver_builder_client.py
- tests/copt_new/test_json_solver_sum_var.py
- tests/copt_new/test_whole_process.py
- tests/integration/test_expression_ops_regression.py

传递受影响（4-7 跳）：
- tests/integration/test_gurobi_json_solver_builder.py
- tests/integration/test_json_solver_builder.py
- tests/integration/test_long_running_concurrency.py
- tests/unit/test_client_factory_unit.py
- tests/integration/test_dual_solver_factory.py
- tests/integration/test_mps_export_integration.py
- tests/verify_install.py

### 每条结论的证据

每行 `via 文件:行号` 都指向依赖实际发生的代码行（import 语句），可直接打开核对。
例：`sgp_client/client.py:3` 处是它对上游模块的 import。

---

复现命令：
```bash
bun run src/cli.ts <sgp路径> --db /tmp/sgp.db
bun run src/impact-cli.ts /tmp/sgp.db "solver_transfer/solver_builder.py" --max 5000
```
