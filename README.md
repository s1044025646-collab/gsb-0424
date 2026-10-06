# 事务冲突可串行化与依赖环见证核验后端

离线事务调度分析服务：输入若干事务编号和按发生顺序排列的读 / 写 / 提交事件，判断该调度是否**冲突可串行化（conflict serializable）**，并给出可行串行顺序或导致失败的依赖环见证。仅提供 HTTP API 与 CLI，TypeScript + Node.js + SQLite，Windows 本地运行，不依赖 Docker / WSL / 外部在线服务。

## 范围说明（重要）

- 只分析**冲突可串行化**。报告中的结论不代表可恢复性、业务正确性或读取值正确，也不覆盖更宽泛的视图可串行化。
- 数据项只是区分大小写的名称；不连接真实数据库、不执行 SQL、不计算读取值、不实现锁管理或崩溃恢复。
- 只接受**所有事务都已提交**的完整调度；不含中止、脏读修复或分布式提交。
- 输入数组顺序就是事件先后，不使用客户端时间戳排序。

## 事件格式

```json
{
  "transactions": ["T1", "T2"],
  "events": [
    { "tx": "T1", "op": "R", "item": "X" },
    { "tx": "T2", "op": "W", "item": "X" },
    { "tx": "T2", "op": "R", "item": "Y" },
    { "tx": "T1", "op": "W", "item": "Y" },
    { "tx": "T1", "op": "C" },
    { "tx": "T2", "op": "C" }
  ]
}
```

- `op`：`R` 读、`W` 写、`C` 提交。`R`/`W` 必须带非空 `item`；`C` 不允许带 `item`。
- 校验规则：事务编号非空且不重复；每个事务至少一次读写且恰好一次提交；提交后不能再有该事务的读写；事件不得引用未声明事务；重复提交拒绝。
- 规模限制：事务数 ≤ 64、事件数 ≤ 10000（可用环境变量 `CS_MAX_TRANSACTIONS` / `CS_MAX_EVENTS` 调整）。
- 非法调度返回 4xx 错误码，**不会**被当作"合法但不可串行化"。

## 冲突规则

两个**不同**事务访问同一数据项且至少一方为写时产生冲突，较早事件所属事务向较晚事件所属事务连边。读-读不冲突；同事务内部不连边。每条边保留具体来源事件（读写种类、事件下标、数据项），边按 `(from, to)` 去重但不丢来源见证。图无环时返回稳定拓扑顺序（零入度候选按事务编号字典序选择，可能还有其他合法顺序）；有环时返回闭合事务环及环上每条边的实际冲突事件。

## 快速开始

```powershell
npm install        # 安装 devDependencies（typescript、@types/node）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 HTTP 服务（默认自动选择空闲端口）
npm run demo       # 运行内置演示：依赖环 + 读读交错
```

端口配置：`node dist/src/cli.js serve --port 8080` 或环境变量 `PORT`；不传则选择空闲端口。
数据目录：项目内 `data/`（可用 `CS_DATA_DIR` / `CS_DB_PATH` 覆盖），SQLite 保存原始事件、规则版本与分析结果，重启后可复核同一见证；修改事件顺序请用 `add-version` 产生新版本。

## CLI

```powershell
node dist/src/cli.js import examples/cycle.json        # 导入并分析，记下返回的 versionId
node dist/src/cli.js import examples/readonly.json     # 读读交错：无任何冲突边
node dist/src/cli.js edges 1                           # 查看冲突边及来源事件
node dist/src/cli.js pair 1 T1 T2                      # 查询一对事务的依赖依据
node dist/src/cli.js verify-cycle 1 cycle.json         # 核验外部环 {"cycle":["T1","T2","T1"]}
node dist/src/cli.js verify-order 1 order.json         # 核验外部顺序 {"order":["T1","T2"]}
node dist/src/cli.js add-version 1 changed.json        # 修改事件顺序 → 新版本
node dist/src/cli.js compare 1 2                       # 比较两个版本
node dist/src/cli.js export 1 out.json                 # 导出版本全部信息
node dist/src/cli.js analyze 1                         # 重新分析（幂等）
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/schedules` | 导入调度（body 为事件格式，可带 `name`），返回 versionId 与分析结果 |
| POST | `/schedules/:id/versions` | 为既有调度追加新版本 |
| POST | `/versions/:id/analyze` | 重新分析指定版本 |
| GET | `/versions/:id/result` | 查看分析结果 |
| GET | `/versions/:id/edges` | 查看全部冲突边 |
| GET | `/versions/:id/dependency?from=T1&to=T2` | 查询一对事务的依赖依据 |
| POST | `/versions/:id/verify-order` | 核验外部串行顺序 `{order:[...]}` |
| POST | `/versions/:id/verify-cycle` | 核验外部依赖环 `{cycle:[...]}` |
| GET | `/schedules/:id/compare?a=1&b=2` | 比较两个版本（结论变化、边的新增/消失） |
| GET | `/versions/:id/export` | 导出版本全部信息 |

错误响应形如 `{"error":{"code":"UNKNOWN_TRANSACTION","message":"..."}}`，错误码包括：`INVALID_BODY`、`INVALID_TRANSACTIONS`、`INVALID_EVENT`、`UNKNOWN_TRANSACTION`、`MISSING_COMMIT`、`DUPLICATE_COMMIT`、`EVENT_AFTER_COMMIT`、`NO_OPERATIONS`、`LIMIT_EXCEEDED`、`NOT_FOUND`、`BAD_REQUEST`。

## 见证核验语义

- **串行顺序**：必须包含每个事务恰好一次，且尊重所有冲突边方向（对每条边 `from -> to`，`from` 必须排在 `to` 之前）。
- **依赖环**：环首尾相接（`["T1","T2","T1"]`，也可省略末尾自动闭合），且环上每条边确实由原事件中的冲突对支持；核验通过时返回每条边对应的具体冲突事件。

## 测试

`npm test` 覆盖：同项多次写、不同数据项、孤立事务、重复边去重、多种拓扑顺序、稳定排序、错误见证（伪造环 / 逆序 / 缺漏事务）、全部校验错误，以及对随机小规模调度**独立穷举全部串行排列**（直接按原始事件检查冲突先后）与图判定结果交叉核对。

## 项目结构

```
src/types.ts     类型与错误码
src/validate.ts  输入校验（规则版本 conflict-serializability-v1）
src/graph.ts     冲突图构建、稳定拓扑排序、找环
src/verify.ts    外部串行顺序 / 依赖环见证核验
src/store.ts     SQLite 持久化（node:sqlite，零原生依赖）
src/service.ts   业务层
src/server.ts    HTTP API
src/cli.ts       命令行入口
test/analysis.test.ts   测试
scripts/smoke-api.js    API 冒烟脚本
examples/               示例调度
```
