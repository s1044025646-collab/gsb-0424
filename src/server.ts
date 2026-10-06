import * as http from "node:http";
import { AddressInfo } from "node:net";
import { analyze } from "./analyze";
import { compareSchedules } from "./compare";
import { Store } from "./store";
import { ScheduleError } from "./types";
import { validateSchedule } from "./validate";
import { verifyCycle, verifySerialOrder } from "./verify";

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof ScheduleError) {
    const status =
      err.code === "NOT_FOUND" ? 404 : err.code === "LIMIT_EXCEEDED" ? 413 : 400;
    send(res, status, { error: { code: err.code, message: err.message, details: err.details ?? null } });
  } else {
    send(res, 500, { error: { code: "INTERNAL", message: String(err) } });
  }
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new ScheduleError("INVALID_INPUT", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true });
      }

      if (method === "GET" && url.pathname === "/schedules") {
        return send(res, 200, { schedules: store.listSchedules() });
      }

      if (method === "POST" && url.pathname === "/schedules") {
        const validated = validateSchedule(await readBody(req));
        const stored = store.importSchedule(
          validated.name,
          validated.transactions,
          validated.events
        );
        return send(res, 201, {
          id: stored.id,
          name: stored.name,
          version: stored.version,
          ruleVersion: stored.ruleVersion,
        });
      }

      if (method === "GET" && url.pathname === "/compare") {
        const a = Number(url.searchParams.get("a"));
        const b = Number(url.searchParams.get("b"));
        if (!Number.isInteger(a) || !Number.isInteger(b)) {
          throw new ScheduleError("INVALID_INPUT", "compare 需要整数参数 a 与 b（调度 id）");
        }
        return send(res, 200, compareSchedules(store.getSchedule(a), store.getSchedule(b)));
      }

      if (parts[0] === "schedules" && parts.length >= 2) {
        const id = Number(parts[1]);
        if (!Number.isInteger(id)) {
          throw new ScheduleError("INVALID_INPUT", "调度 id 必须是整数");
        }
        const action = parts[2];

        if (method === "GET" && !action) {
          const s = store.getSchedule(id);
          return send(res, 200, s);
        }

        if (method === "POST" && action === "analyze") {
          const s = store.getSchedule(id);
          const result = analyze(s.transactions, s.events);
          store.saveResult(id, result);
          return send(res, 200, result);
        }

        if (method === "GET" && action === "result") {
          const cached = store.getResult(id);
          if (!cached) throw new ScheduleError("NOT_FOUND", `调度 ${id} 尚未分析`);
          return send(res, 200, cached);
        }

        if (method === "GET" && action === "edges") {
          const s = store.getSchedule(id);
          const result = analyze(s.transactions, s.events);
          return send(res, 200, { edges: result.edges });
        }

        if (method === "GET" && action === "dependency") {
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          if (!from || !to) {
            throw new ScheduleError("INVALID_INPUT", "dependency 需要 from 与 to 参数");
          }
          const s = store.getSchedule(id);
          const result = analyze(s.transactions, s.events);
          const matches = result.edges.filter((e) => e.from === from && e.to === to);
          return send(res, 200, { from, to, edges: matches });
        }

        if (method === "POST" && action === "verify-order") {
          const s = store.getSchedule(id);
          const body = (await readBody(req)) as { order?: unknown };
          return send(res, 200, verifySerialOrder(s.transactions, s.events, body.order));
        }

        if (method === "POST" && action === "verify-cycle") {
          const s = store.getSchedule(id);
          const body = (await readBody(req)) as { cycle?: unknown };
          return send(res, 200, verifyCycle(s.transactions, s.events, body.cycle));
        }

        if (method === "GET" && action === "export") {
          const s = store.getSchedule(id);
          const result = store.getResult(id);
          return send(res, 200, {
            schedule: s,
            result,
            exportedAt: new Date().toISOString(),
          });
        }
      }

      send(res, 404, { error: { code: "NOT_FOUND", message: "路由不存在" } });
    } catch (err) {
      sendError(res, err);
    }
  });
}

export function startServer(store: Store, port: number): Promise<number> {
  const server = createServer(store);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}
