import * as fs from "node:fs";
import * as path from "node:path";
import { analyze } from "./analyze";
import { compareSchedules } from "./compare";
import { startServer } from "./server";
import { Store } from "./store";
import { validateSchedule } from "./validate";
import { verifyCycle, verifySerialOrder } from "./verify";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = process.env.SCHED_DB ?? path.join(DATA_DIR, "schedules.db");

function out(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function requireId(arg: string | undefined, what: string): number {
  const n = Number(arg);
  if (arg === undefined || !Number.isInteger(n)) {
    throw new Error(`${what} 必须是整数，收到: ${arg}`);
  }
  return n;
}

function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const DEMO_CYCLE = {
  name: "demo-cycle",
  transactions: ["1", "2"],
  events: [
    { tx: "1", type: "read", item: "X" },
    { tx: "2", type: "write", item: "X" },
    { tx: "2", type: "read", item: "Y" },
    { tx: "1", type: "write", item: "Y" },
    { tx: "1", type: "commit" },
    { tx: "2", type: "commit" },
  ],
};

const DEMO_READ_ONLY = {
  name: "demo-read-only",
  transactions: ["1", "2"],
  events: [
    { tx: "1", type: "read", item: "X" },
    { tx: "2", type: "read", item: "X" },
    { tx: "2", type: "read", item: "Y" },
    { tx: "1", type: "read", item: "Y" },
    { tx: "1", type: "commit" },
    { tx: "2", type: "commit" },
  ],
};

function runDemo(store: Store): void {
  for (const demo of [DEMO_CYCLE, DEMO_READ_ONLY]) {
    const validated = validateSchedule(demo);
    const stored = store.importSchedule(
      validated.name,
      validated.transactions,
      validated.events
    );
    const result = analyze(stored.transactions, stored.events);
    store.saveResult(stored.id, result);
    console.log(`=== ${stored.name} (id=${stored.id}, version=${stored.version}) ===`);
    out(result);
    if (result.cycle) {
      console.log("--- 环见证核验 ---");
      out(verifyCycle(stored.transactions, stored.events, result.cycle.ring));
    }
    if (result.order) {
      console.log("--- 串行顺序核验 ---");
      out(verifySerialOrder(stored.transactions, stored.events, result.order));
    }
  }
}

const USAGE = `用法: node dist/cli.js <命令> [参数]
  serve [--port N]                 启动 HTTP API（默认端口 0，即自动选择空闲端口）
  import <file.json>               导入调度（同名不同内容自动产生新版本）
  list                             列出全部调度版本
  analyze <id>                     分析调度并保存结果
  result <id>                      查看已保存的分析结果
  edges <id>                       查看冲突边及来源事件
  dep <id> <from> <to>             查询一对事务的依赖依据
  verify-order <id> '[...]'        验证外部串行顺序
  verify-cycle <id> '[...]'        验证外部环见证
  compare <idA> <idB>              比较两个调度版本
  export <id>                      导出调度与结果
  demo                             运行内置演示（环 + 只读交错）
数据库路径: 环境变量 SCHED_DB，默认 ./data/schedules.db`;

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }
  const store = new Store(DB_PATH);
  try {
    switch (cmd) {
      case "serve": {
        const portIdx = args.indexOf("--port");
        const port =
          portIdx >= 0 ? Number(args[portIdx + 1]) : Number(process.env.PORT ?? 0);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new Error(`非法端口: ${port}`);
        }
        const actual = await startServer(store, port);
        console.log(`API 已启动: http://127.0.0.1:${actual} (数据库: ${DB_PATH})`);
        return; // 保持进程运行
      }
      case "import": {
        const validated = validateSchedule(readJsonFile(args[0]));
        const s = store.importSchedule(validated.name, validated.transactions, validated.events);
        out({ id: s.id, name: s.name, version: s.version, ruleVersion: s.ruleVersion });
        break;
      }
      case "list":
        out(store.listSchedules());
        break;
      case "analyze": {
        const s = store.getSchedule(requireId(args[0], "调度 id"));
        const result = analyze(s.transactions, s.events);
        store.saveResult(s.id, result);
        out(result);
        break;
      }
      case "result":
        out(store.getResult(requireId(args[0], "调度 id")) ?? { error: "尚未分析" });
        break;
      case "edges": {
        const s = store.getSchedule(requireId(args[0], "调度 id"));
        out(analyze(s.transactions, s.events).edges);
        break;
      }
      case "dep": {
        const s = store.getSchedule(requireId(args[0], "调度 id"));
        const result = analyze(s.transactions, s.events);
        out(result.edges.filter((e) => e.from === args[1] && e.to === args[2]));
        break;
      }
      case "verify-order": {
        const s = store.getSchedule(requireId(args[0], "调度 id"));
        out(verifySerialOrder(s.transactions, s.events, JSON.parse(args[1])));
        break;
      }
      case "verify-cycle": {
        const s = store.getSchedule(requireId(args[0], "调度 id"));
        out(verifyCycle(s.transactions, s.events, JSON.parse(args[1])));
        break;
      }
      case "compare": {
        const a = store.getSchedule(requireId(args[0], "调度 id A"));
        const b = store.getSchedule(requireId(args[1], "调度 id B"));
        out(compareSchedules(a, b));
        break;
      }
      case "export": {
        const id = requireId(args[0], "调度 id");
        out({ schedule: store.getSchedule(id), result: store.getResult(id) });
        break;
      }
      case "demo":
        runDemo(store);
        break;
      default:
        console.error(`未知命令: ${cmd}\n\n${USAGE}`);
        process.exitCode = 1;
    }
  } finally {
    if (cmd !== "serve") store.close();
  }
}

main().catch((err) => {
  if (err && typeof err === "object" && "code" in err) {
    const e = err as { code: string; message: string; details?: unknown };
    console.error(`错误 [${e.code}] ${e.message}`);
    if (e.details) console.error(JSON.stringify(e.details));
  } else {
    console.error(`错误: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exitCode = 1;
});
