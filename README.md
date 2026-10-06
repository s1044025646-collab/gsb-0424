# 事务冲突可串行化与依赖环见证核验后端

离线事务调度分析服务：输入若干事务编号和按发生顺序排列的读 / 写 / 提交事件，判断调度是否**冲突可串行化**，并给出可行串行顺序或导致失败的依赖环见证。仅提供 HTTP API 与 CLI，TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`，无原生依赖），Windows 本地运行，不需要 Docker / WSL / 外部服务。

## 范围与限制

- 只接受**所有事务都已提交**的完整调度；不含中止、脏读修复、分布式提交。
- 数据项只是区分大小写的名称；不连接真实数据库、不执行 SQL、不计算读取值、不实现锁管理或崩溃恢复。
- 报告**只声称冲突可串行化**结论：无环不等于可恢复性、业务正确性或读取值正确，也不是视图可串行化分析。
- 输入数组顺序就是事件先后顺序，不使用任何客户端时间戳排序。
- 规模限制：事务数不超过 64，事件数不超过 10000。

## 事件格式

```json
{
  "name": "my-schedule",
  "transactions": ["1", "2"],
  "events": [
    { "id": 0, "tx": "1", "type": "read",  "item": "X" },
    { "id": 1, "tx": "2", "type": "write", "item": "X" },
    { "id": 2, "tx": "2", "type": "read",  "item": "Y" },
    { "id": 3, "tx": "1", "type": "write", "item": "Y" },
    { "id": 4, "tx": "1", "type": "commit" },
    { "id": 5, "tx": "2", "type": "commit" }
  ]
}
```

- `transactions`：事务编号声明（字符串，字母数字 / `_` / `-`，不超过 64 字符，不可重复）。
- `events`：按发生先后排列。`type` 为 `read` / `write` / `commit`；`read`、`write` 必须带 `item`，`commit` 不允许带 `item`。
- `id` 可选，若提供必须是非负整数且不重复；事件先后只由数组下标决定。
- 校验规则：每个事务至少一次读写且恰好一次提交；提交后不能再有该事务的读写；未知事务、重复提交、重复事件编号均拒绝（返回对应错误码，不会被当作"合法但不可串行化"）。

## 冲突规则

两个**不同**事务访问**同一**数据项且至少一方为写时产生冲突边：较早事件所属事务指向较晚事件所属事务。读-读不连边，同事务不连边。边按 (from, to, item) 去重，但保留全部来源事件对（读写种类、位置、数据项）。不以提交先后代替冲突顺序，也不只看某项最后一次写入。

- 图无环：返回一个**稳定**拓扑顺序（Kahn 算法，零入度候选按固定事务编号选择），并注明可能还有其他合法顺序。
- 图有环：返回一条闭合事务环（如 `["1","2","1"]`），环上每条边附实际冲突事件见证。

## 构建、测试、启动、演示

```powershell
npm install        # 仅开发依赖 typescript 与 @types/node
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API（默认端口 0 = 自动选择空闲端口）
npm run demo       # 内置演示：环调度 + 只读交错调度
```

端口配置：`node dist/src/cli.js serve --port 8080` 或环境变量 `PORT`。数据库路径：环境变量 `SCHED_DB`，默认 `./data/schedules.db`（项目内数据目录，重启后可复核同一见证）。

## CLI

```
node dist/src/cli.js serve [--port N]    启动 HTTP API
node dist/src/cli.js import <file.json>  导入调度（同名不同内容自动产生新版本）
node dist/src/cli.js list                列出全部调度版本
node dist/src/cli.js analyze <id>        分析并保存结果
node dist/src/cli.js result <id>         查看已保存结果
node dist/src/cli.js edges <id>          查看冲突边及来源事件
node dist/src/cli.js dep <id> <from> <to>   查询一对事务的依赖依据
node dist/src/cli.js verify-order <id> '["1","2"]'      验证外部串行顺序
node dist/src/cli.js verify-cycle <id> '["1","2","1"]'  验证外部环见证
node dist/src/cli.js compare <idA> <idB> 比较两个调度版本
node dist/src/cli.js export <id>         导出调度与结果
node dist/src/cli.js demo                运行内置演示
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/schedules` | 导入调度（校验 + 版本化存储） |
| GET | `/schedules` | 列出全部调度版本 |
| GET | `/schedules/:id` | 查看调度原始事件与规则版本 |
| POST | `/schedules/:id/analyze` | 分析并保存结果 |
| GET | `/schedules/:id/result` | 读取已保存结果 |
| GET | `/schedules/:id/edges` | 查看冲突边及来源事件 |
| GET | `/schedules/:id/dependency?from=1&to=2` | 查询一对事务的依赖依据 |
| POST | `/schedules/:id/verify-order` | 验证外部串行顺序 `{ "order": [...] }` |
| POST | `/schedules/:id/verify-cycle` | 验证外部环见证 `{ "cycle": [...] }` |
| GET | `/schedules/:id/export` | 导出调度与结果 |
| GET | `/compare?a=1&b=2` | 比较两个调度版本（边差异与结论变化） |

示例（PowerShell）：

```powershell
$body = Get-Content schedule.json -Raw
Invoke-RestMethod -Uri http://127.0.0.1:8080/schedules -Method Post -ContentType 'application/json' -Body $body
Invoke-RestMethod -Uri http://127.0.0.1:8080/schedules/1/analyze -Method Post
Invoke-RestMethod -Uri 'http://127.0.0.1:8080/schedules/1/verify-cycle' -Method Post -ContentType 'application/json' -Body '{"cycle":["1","2","1"]}'
```

## 错误码

`INVALID_INPUT`（格式或 JSON 非法）、`INVALID_TRANSACTION`（事务编号非法或重复）、`UNKNOWN_TRANSACTION`（事件引用未声明事务）、`INVALID_EVENT`（事件类型或编号非法）、`INVALID_ITEM`（数据项非法）、`MISSING_COMMIT`、`DUPLICATE_COMMIT`、`EVENT_AFTER_COMMIT`、`NO_OPERATIONS`、`LIMIT_EXCEEDED`（超规模上限）、`NOT_FOUND`、`INTERNAL`。HTTP 状态：校验类 400，超限 413，不存在 404。

## 见证核验语义

- **串行顺序**：必须包含每个事务恰好一次，且尊重所有冲突边方向。
- **环见证**：首尾必须相同（闭合），除首尾外事务不重复，且每一段环边都必须有原始冲突事件支持（核验通过时返回对应支持边）。

## 存储与版本

SQLite 保存原始事件、规则版本（`conflict-serializable-v1`）与分析结果。同一名字导入相同内容返回已有记录；修改事件（如调整顺序）自动产生该名字的新版本，可用 `compare` 对比版本间冲突边与结论差异。

## 测试

`test/core.test.ts` 覆盖：演示环调度、只读交错无边、同项多次写（去重但保留全部来源）、不同数据项、大小写敏感、孤立事务、多种拓扑顺序、错误见证、全部校验错误码，以及对 2 到 4 个事务的 200 轮随机调度用穷举串行排列交叉核对图判定。
