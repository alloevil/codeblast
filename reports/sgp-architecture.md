# Architecture Map

> codeblast M3-v0（目录级折叠）· 节点=模块（含文件数/盲区数），边=import 依赖（数字=强度）

```mermaid
flowchart TD
    M0[/"tests<br/>22 files · 461 blind"/]
    M1["sgp_client<br/>13 files · 105 blind"]
    M2["sgp_utils<br/>8 files · 177 blind"]
    M3["sgp_service<br/>6 files · 147 blind"]
    M4["solver_transfer<br/>6 files · 243 blind"]
    M5["(root)<br/>4 files · 102 blind"]
    M6["sgp_entity<br/>4 files · 24 blind"]
    M7["srvcfg<br/>4 files"]
    M8["proto<br/>3 files · 12 blind"]
    M9["examples<br/>1 files · 58 blind"]
    M0 -->|17| M4
    M3 -->|9| M2
    M0 -->|9| M3
    M0 -->|7| M5
    M3 -->|4| M8
    M0 -->|4| M6
    M1 -->|3| M3
    M2 -->|3| M4
    M1 -->|2| M4
    M3 -->|2| M5
    M2 -->|2| M6
    M4 -->|2| M2
    M0 -->|2| M1
    M9 -->|1| M4
    M5 -->|1| M7
    M1 -->|1| M6
    M1 -->|1| M5
    M5 -->|1| M8
    M5 -->|1| M3
    M3 -->|1| M4
    M2 -->|1| M7
    M4 -->|1| M6
    M4 -->|1| M5
    M4 -->|1| M7
```

| 模块 | 文件数 | 盲区 | 出边依赖 | 入边被依赖 |
|---|---|---|---|---|
| tests | 22 | 461 | 39 | 0 |
| sgp_client | 13 | 105 | 7 | 2 |
| sgp_utils | 8 | 177 | 6 | 11 |
| sgp_service | 6 | 147 | 16 | 13 |
| solver_transfer | 6 | 243 | 5 | 24 |
| (root) | 4 | 102 | 3 | 11 |
| sgp_entity | 4 | 24 | 0 | 8 |
| srvcfg | 4 | 0 | 0 | 3 |
| proto | 3 | 12 | 0 | 5 |
| examples | 1 | 58 | 1 | 0 |
