import * as fs from "node:fs";
import { Service } from "./service";
import { startServer } from "./server";

const USAGE = `事务冲突可串行化分析 CLI

用法: node dist/src/cli.js <命令> [参数]

命令:
  serve [--port N]                      启动 HTTP 服务（默认自动选择空闲端口）
  import <file.json> [--name 名称]      导入调度文件，输出版本 ID 与分析结果
  add-version <scheduleId> <file.json>  为既有调度追加新版本（如修改了事件顺序）
  analyze <versionId>                   重新分析指定版本
  result <versionId>                    查看已存分析结果
  edges <versionId>                     查看全部冲突边及来源事件
  pair <versionId> <from> <to>          查询一对事务的依赖依据
  verify-order <versionId> <file.json>  核验外部串行顺序（{"order":[...]}）
  verify-cycle <versionId> <file.json>  核验外部依赖环（{"cycle":[...]}）
  compare <versionIdA> <versionIdB>     比较同一调度的两个版本
  export <versionId> [out.json]         导出版本全部信息
  demo                                  运行内置演示（依赖环 + 读读交错）

调度文件格式:
  {"transactions": ["T1","T2"],
   "events": [{"tx":"T1","op":"R","item":"X"}, ..., {"tx":"T1","op":"C"}]}
  op: R=读 W=写 C=提交；数组顺序即发生顺序。
`;

function print(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
}

function readJsonFile(path: string): unknown {
  return JSON.parse(fs.readFileSync(path, "utf-8"));
}

function runDemo(service: Service): void {
  console.log("=== 演示 1：依赖环（r1(X) w2(X) r2(Y) w1(Y)，随后两者提交） ===");
  const cyclic = service.importSchedule({
    transactions: ["T1", "T2"],
    events: [
      { tx: "T1", op: "R", item: "X" },
      { tx: "T2", op: "W", item: "X" },
      { tx: "T2", op: "R", item: "Y" },
      { tx: "T1", op: "W", item: "Y" },
      { tx: "T1", op: "C" },
      { tx: "T2", op: "C" },
    ],
  }, "demo-cycle");
  print(cyclic.result);

  console.log("\n=== 演示 2：只有读读交错，没有任何冲突边 ===");
  const readOnly = service.importSchedule({
    transactions: ["T1", "T2"],
    events: [
      { tx: "T1", op: "R", item: "X" },
      { tx: "T2", op: "R", item: "X" },
      { tx: "T1", op: "R", item: "Y" },
      { tx: "T2", op: "R", item: "Y" },
      { tx: "T1", op: "C" },
      { tx: "T2", op: "C" },
    ],
  }, "demo-readonly");
  print(readOnly.result);
}

function main(): void {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }
  if (cmd === "serve") {
    const idx = args.indexOf("--port");
    const port = idx !== -1 ? Number(args[idx + 1]) : undefined;
    startServer(port);
    return;
  }

  const service = new Service();
  try {
    switch (cmd) {
      case "import": {
        const nameIdx = args.indexOf("--name");
        const name = nameIdx !== -1 ? args[nameIdx + 1] : undefined;
        print(service.importSchedule(readJsonFile(args[0]), name));
        break;
      }
      case "add-version":
        print(service.addVersion(Number(args[0]), readJsonFile(args[1])));
        break;
      case "analyze":
        print(service.analyzeVersion(Number(args[0])));
        break;
      case "result":
        print(service.getResult(Number(args[0])));
        break;
      case "edges":
        print({ edges: service.getEdges(Number(args[0])) });
        break;
      case "pair":
        print(service.getDependency(Number(args[0]), args[1], args[2]));
        break;
      case "verify-order": {
        const body = readJsonFile(args[1]) as { order: unknown };
        print(service.verifyOrder(Number(args[0]), body.order));
        break;
      }
      case "verify-cycle": {
        const body = readJsonFile(args[1]) as { cycle: unknown };
        print(service.verifyCycle(Number(args[0]), body.cycle));
        break;
      }
      case "compare":
        print(service.compare(Number(args[0]), Number(args[1])));
        break;
      case "export": {
        const data = service.exportVersion(Number(args[0]));
        if (args[1]) {
          fs.writeFileSync(args[1], JSON.stringify(data, null, 2), "utf-8");
          console.log(`已导出到 ${args[1]}`);
        } else {
          print(data);
        }
        break;
      }
      case "demo":
        runDemo(service);
        break;
      default:
        console.error(`未知命令: ${cmd}\n`);
        console.log(USAGE);
        process.exitCode = 1;
    }
  } finally {
    service.store.close();
  }
}

main();
