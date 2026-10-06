// API 冒烟测试：启动服务 → 导入 → 查询依赖 → 核验环/顺序 → 错误码
const { createServer } = require("../dist/src/server");
const { Service } = require("../dist/src/service");

async function main() {
  const service = new Service();
  const server = createServer(service);
  server.listen(18741);
  await new Promise((r) => server.on("listening", r));
  const base = "http://127.0.0.1:18741";
  const post = (p, body) =>
    fetch(base + p, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const get = (p) => fetch(base + p).then((r) => r.json());

  const imported = await post("/schedules", {
    transactions: ["T1", "T2"],
    events: [
      { tx: "T1", op: "R", item: "X" },
      { tx: "T2", op: "W", item: "X" },
      { tx: "T2", op: "R", item: "Y" },
      { tx: "T1", op: "W", item: "Y" },
      { tx: "T1", op: "C" },
      { tx: "T2", op: "C" },
    ],
  });
  const vid = imported.body.versionId;
  console.log("import:", imported.status, "serializable =", imported.body.result.serializable);

  const dep = await get(`/versions/${vid}/dependency?from=T1&to=T2`);
  console.log("dependency T1->T2:", JSON.stringify(dep.witnesses[0]));

  const vc = await post(`/versions/${vid}/verify-cycle`, { cycle: ["T1", "T2", "T1"] });
  console.log("verify-cycle valid:", vc.body.valid);

  const vo = await post(`/versions/${vid}/verify-order`, { order: ["T1", "T2"] });
  console.log("verify-order valid:", vo.body.valid, "|", vo.body.errors[0]);

  // 第二个版本：交换事件顺序 → 结论变化
  const v2 = await post(`/schedules/${imported.body.scheduleId}/versions`, {
    transactions: ["T1", "T2"],
    events: [
      { tx: "T1", op: "R", item: "X" },
      { tx: "T1", op: "W", item: "Y" },
      { tx: "T1", op: "C" },
      { tx: "T2", op: "W", item: "X" },
      { tx: "T2", op: "R", item: "Y" },
      { tx: "T2", op: "C" },
    ],
  });
  console.log("v2 serializable:", v2.body.result.serializable);
  const cmp = await get(
    `/schedules/${imported.body.scheduleId}/compare?a=${vid}&b=${v2.body.versionId}`
  );
  console.log("compare conclusionChanged:", cmp.conclusionChanged);

  const bad = await post("/schedules", {
    transactions: ["T1"],
    events: [{ tx: "T9", op: "R", item: "X" }],
  });
  console.log("bad input:", bad.status, bad.body.error.code);

  server.closeAllConnections?.();
  server.close(() => {
    service.store.close();
    console.log("done");
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
