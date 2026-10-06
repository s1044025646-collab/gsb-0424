import * as http from "node:http";
import { AddressInfo } from "node:net";
import { Service } from "./service";
import { ApiError } from "./types";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new ApiError("INVALID_BODY", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function toInt(v: string | undefined, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ApiError("BAD_REQUEST", `路径参数 ${name} 必须是正整数`);
  }
  return n;
}

export function createServer(service: Service = new Service()): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true });
      }

      // POST /schedules  导入调度（body: {name?, transactions, events}）
      if (method === "POST" && parts.length === 1 && parts[0] === "schedules") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const name = typeof body.name === "string" ? body.name : undefined;
        return sendJson(res, 201, service.importSchedule(body, name));
      }

      // POST /schedules/:id/versions  追加新版本
      if (method === "POST" && parts.length === 3 && parts[0] === "schedules" && parts[2] === "versions") {
        const body = await readBody(req);
        return sendJson(res, 201, service.addVersion(toInt(parts[1], "scheduleId"), body));
      }

      // POST /versions/:id/analyze
      if (method === "POST" && parts.length === 3 && parts[0] === "versions" && parts[2] === "analyze") {
        return sendJson(res, 200, service.analyzeVersion(toInt(parts[1], "versionId")));
      }

      // GET /versions/:id/result | /edges | /export
      if (method === "GET" && parts.length === 3 && parts[0] === "versions") {
        const vid = toInt(parts[1], "versionId");
        if (parts[2] === "result") return sendJson(res, 200, service.getResult(vid));
        if (parts[2] === "edges") return sendJson(res, 200, { edges: service.getEdges(vid) });
        if (parts[2] === "export") return sendJson(res, 200, service.exportVersion(vid));
      }

      // GET /versions/:id/dependency?from=T1&to=T2
      if (method === "GET" && parts.length === 3 && parts[0] === "versions" && parts[2] === "dependency") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!from || !to) throw new ApiError("BAD_REQUEST", "缺少查询参数 from / to");
        return sendJson(res, 200, service.getDependency(toInt(parts[1], "versionId"), from, to));
      }

      // POST /versions/:id/verify-order  body: {order: [...]}
      if (method === "POST" && parts.length === 3 && parts[0] === "versions" && parts[2] === "verify-order") {
        const body = (await readBody(req)) as Record<string, unknown>;
        return sendJson(res, 200, service.verifyOrder(toInt(parts[1], "versionId"), body.order));
      }

      // POST /versions/:id/verify-cycle  body: {cycle: [...]}
      if (method === "POST" && parts.length === 3 && parts[0] === "versions" && parts[2] === "verify-cycle") {
        const body = (await readBody(req)) as Record<string, unknown>;
        return sendJson(res, 200, service.verifyCycle(toInt(parts[1], "versionId"), body.cycle));
      }

      // GET /schedules/:id/compare?a=1&b=2  （a、b 为 versionId）
      if (method === "GET" && parts.length === 3 && parts[0] === "schedules" && parts[2] === "compare") {
        toInt(parts[1], "scheduleId");
        const a = url.searchParams.get("a");
        const b = url.searchParams.get("b");
        if (!a || !b) throw new ApiError("BAD_REQUEST", "缺少查询参数 a / b（版本 ID）");
        return sendJson(res, 200, service.compare(toInt(a, "a"), toInt(b, "b")));
      }

      throw new ApiError("NOT_FOUND", `未知路由: ${method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof ApiError) {
        return sendJson(res, err.code === "NOT_FOUND" ? 404 : 400, {
          error: { code: err.code, message: err.message },
        });
      }
      const anyErr = err as { code?: string; message?: string };
      if (anyErr?.code === "NOT_FOUND") {
        return sendJson(res, 404, { error: { code: "NOT_FOUND", message: anyErr.message } });
      }
      return sendJson(res, 500, {
        error: { code: "INTERNAL", message: anyErr?.message ?? String(err) },
      });
    }
  });
}

export function startServer(port?: number): http.Server {
  const service = new Service();
  const server = createServer(service);
  // 默认 0：由操作系统分配空闲端口
  const listenPort = port ?? Number(process.env.PORT ?? 0);
  server.listen(listenPort, () => {
    const addr = server.address() as AddressInfo;
    console.log(`冲突可串行化分析服务已启动: http://127.0.0.1:${addr.port}`);
  });
  return server;
}

if (require.main === module) {
  const idx = process.argv.indexOf("--port");
  const port = idx !== -1 ? Number(process.argv[idx + 1]) : undefined;
  startServer(port);
}
