import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, buildConflictGraph } from "../src/graph";
import { validateSchedule } from "../src/validate";
import { verifyCycle, verifySerialOrder } from "../src/verify";
import { ApiError, ScheduleInput } from "../src/types";

function s(input: unknown): ScheduleInput {
  return validateSchedule(input);
}

// ---------- 校验 ----------

test("校验：拒绝未声明事务", () => {
  assert.throws(
    () => s({ transactions: ["T1"], events: [{ tx: "T9", op: "R", item: "X" }] }),
    (e: ApiError) => e.code === "UNKNOWN_TRANSACTION"
  );
});

test("校验：拒绝缺少提交 / 重复提交 / 提交后读写 / 无读写", () => {
  assert.throws(
    () => s({ transactions: ["T1"], events: [{ tx: "T1", op: "R", item: "X" }] }),
    (e: ApiError) => e.code === "MISSING_COMMIT"
  );
  assert.throws(
    () =>
      s({
        transactions: ["T1"],
        events: [
          { tx: "T1", op: "R", item: "X" },
          { tx: "T1", op: "C" },
          { tx: "T1", op: "C" },
        ],
      }),
    (e: ApiError) => e.code === "DUPLICATE_COMMIT"
  );
  assert.throws(
    () =>
      s({
        transactions: ["T1"],
        events: [
          { tx: "T1", op: "C" },
          { tx: "T1", op: "R", item: "X" },
        ],
      }),
    (e: ApiError) => e.code === "EVENT_AFTER_COMMIT"
  );
  assert.throws(
    () => s({ transactions: ["T1"], events: [{ tx: "T1", op: "C" }] }),
    (e: ApiError) => e.code === "NO_OPERATIONS"
  );
});

test("校验：数据项区分大小写，x 与 X 是不同项", () => {
  const r = analyze(
    s({
      transactions: ["T1", "T2"],
      events: [
        { tx: "T1", op: "W", item: "x" },
        { tx: "T2", op: "W", item: "X" },
        { tx: "T1", op: "C" },
        { tx: "T2", op: "C" },
      ],
    })
  );
  assert.equal(r.edges.length, 0);
  assert.equal(r.serializable, true);
});

// ---------- 冲突图 ----------

test("读读交错不产生任何边", () => {
  const r = analyze(
    s({
      transactions: ["T1", "T2"],
      events: [
        { tx: "T1", op: "R", item: "X" },
        { tx: "T2", op: "R", item: "X" },
        { tx: "T1", op: "C" },
        { tx: "T2", op: "C" },
      ],
    })
  );
  assert.equal(r.edges.length, 0);
  assert.equal(r.serializable, true);
  assert.equal(r.multipleOrdersPossible, true);
});

test("演示用例：r1(X) w2(X) r2(Y) w1(Y) 形成双向依赖环", () => {
  const r = analyze(
    s({
      transactions: ["T1", "T2"],
      events: [
        { tx: "T1", op: "R", item: "X" },
        { tx: "T2", op: "W", item: "X" },
        { tx: "T2", op: "R", item: "Y" },
        { tx: "T1", op: "W", item: "Y" },
        { tx: "T1", op: "C" },
        { tx: "T2", op: "C" },
      ],
    })
  );
  assert.equal(r.serializable, false);
  assert.deepEqual(r.cycle, ["T1", "T2", "T1"]);
  assert.equal(r.cycleEdges!.length, 2);
  const e12 = r.edges.find((e) => e.from === "T1" && e.to === "T2")!;
  const e21 = r.edges.find((e) => e.from === "T2" && e.to === "T1")!;
  assert.equal(e12.witnesses[0].item, "X");
  assert.deepEqual([e12.witnesses[0].earlierOp, e12.witnesses[0].laterOp], ["R", "W"]);
  assert.equal(e21.witnesses[0].item, "Y");
});

test("同项多次写：边去重但保留多个来源见证", () => {
  const edges = buildConflictGraph(
    s({
      transactions: ["T1", "T2"],
      events: [
        { tx: "T1", op: "W", item: "X" },
        { tx: "T2", op: "W", item: "X" },
        { tx: "T1", op: "W", item: "X" },
        { tx: "T2", op: "W", item: "X" },
        { tx: "T1", op: "C" },
        { tx: "T2", op: "C" },
      ],
    })
  );
  const e12 = edges.filter((e) => e.from === "T1" && e.to === "T2");
  const e21 = edges.filter((e) => e.from === "T2" && e.to === "T1");
  assert.equal(e12.length, 1);
  assert.equal(e21.length, 1);
  assert.ok(e12[0].witnesses.length >= 1);
  assert.ok(e12[0].witnesses.every((w) => w.earlierSeq < w.laterSeq));
});

test("不同数据项不冲突；孤立事务无边且可排任意位置", () => {
  const r = analyze(
    s({
      transactions: ["T1", "T2", "T3"],
      events: [
        { tx: "T1", op: "W", item: "A" },
        { tx: "T2", op: "W", item: "B" },
        { tx: "T3", op: "R", item: "C" },
        { tx: "T1", op: "C" },
        { tx: "T2", op: "C" },
        { tx: "T3", op: "C" },
      ],
    })
  );
  assert.equal(r.edges.length, 0);
  assert.deepEqual(r.serialOrder, ["T1", "T2", "T3"]);
  assert.equal(r.multipleOrdersPossible, true);
});

test("拓扑顺序稳定：零入度按事务编号字典序", () => {
  const r = analyze(
    s({
      transactions: ["T2", "T1"],
      events: [
        { tx: "T2", op: "W", item: "X" },
        { tx: "T1", op: "R", item: "X" },
        { tx: "T1", op: "C" },
        { tx: "T2", op: "C" },
      ],
    })
  );
  assert.deepEqual(r.serialOrder, ["T2", "T1"]);
  assert.equal(r.multipleOrdersPossible, false);
});

// ---------- 见证核验 ----------

test("核验串行顺序：正确顺序通过，逆序与缺漏被拒绝", () => {
  const sched = s({
    transactions: ["T1", "T2"],
    events: [
      { tx: "T1", op: "W", item: "X" },
      { tx: "T2", op: "R", item: "X" },
      { tx: "T1", op: "C" },
      { tx: "T2", op: "C" },
    ],
  });
  assert.equal(verifySerialOrder(sched, ["T1", "T2"]).valid, true);
  const bad = verifySerialOrder(sched, ["T2", "T1"]);
  assert.equal(bad.valid, false);
  assert.ok(bad.errors[0].includes("T1 -> T2"));
  assert.equal(verifySerialOrder(sched, ["T1"]).valid, false);
  assert.equal(verifySerialOrder(sched, ["T1", "T1", "T2"]).valid, false);
  assert.equal(verifySerialOrder(sched, ["T1", "T2", "T9"]).valid, false);
});

test("核验依赖环：真实环通过，伪造环被拒绝", () => {
  const sched = s({
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
  const ok = verifyCycle(sched, ["T1", "T2", "T1"]);
  assert.equal(ok.valid, true);
  assert.equal(ok.edgeWitnesses!.length, 2);
  assert.equal(verifyCycle(sched, ["T1", "T1"]).valid, false); // 无自环边
  const acyclic = s({
    transactions: ["T1", "T2"],
    events: [
      { tx: "T1", op: "W", item: "X" },
      { tx: "T2", op: "R", item: "X" },
      { tx: "T1", op: "C" },
      { tx: "T2", op: "C" },
    ],
  });
  assert.equal(verifyCycle(acyclic, ["T1", "T2", "T1"]).valid, false);
});

// ---------- 穷举交叉验证 ----------

function* permutations<T>(arr: T[]): Generator<T[]> {
  if (arr.length <= 1) {
    yield [...arr];
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}

/** 独立判定：存在某个串行排列保持所有冲突事件的先后关系 */
function bruteForceSerializable(sched: ScheduleInput): boolean {
  // 直接从原始事件提取全部冲突对（不经过建图代码）
  const pairs: Array<[string, string]> = [];
  sched.events.forEach((a, i) => {
    if (a.op === "C") return;
    sched.events.forEach((b, j) => {
      if (j <= i || b.op === "C" || a.tx === b.tx || a.item !== b.item) return;
      if (a.op === "R" && b.op === "R") return;
      pairs.push([a.tx, b.tx]);
    });
  });
  for (const perm of permutations(sched.transactions)) {
    const pos = new Map(perm.map((t, i) => [t, i]));
    if (pairs.every(([f, t]) => pos.get(f)! < pos.get(t)!)) return true;
  }
  return false;
}

test("穷举：随机小规模调度与暴力排列判定一致", () => {
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let trial = 0; trial < 60; trial++) {
    const nTx = 2 + Math.floor(rand() * 3); // 2-4 个事务
    const txs = Array.from({ length: nTx }, (_, i) => `T${i + 1}`);
    const items = ["X", "Y", "Z"];
    const events: Array<{ tx: string; op: "R" | "W" | "C"; item?: string }> = [];
    for (const tx of txs) {
      const nOps = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < nOps; k++) {
        events.push({
          tx,
          op: rand() < 0.5 ? "R" : "W",
          item: items[Math.floor(rand() * items.length)],
        });
      }
    }
    // 随机交错（保持每事务内部顺序），再补提交
    const shuffled: typeof events = [];
    const queues = txs.map((tx) => events.filter((e) => e.tx === tx));
    while (queues.some((q) => q.length > 0)) {
      const i = Math.floor(rand() * txs.length);
      if (queues[i].length > 0) shuffled.push(queues[i].shift()!);
    }
    for (const tx of txs) shuffled.push({ tx, op: "C" });

    const sched = s({ transactions: txs, events: shuffled });
    const graphSays = analyze(sched).serializable;
    const bruteSays = bruteForceSerializable(sched);
    assert.equal(
      graphSays,
      bruteSays,
      `不一致，调度: ${JSON.stringify(shuffled)}`
    );
    if (graphSays) {
      assert.equal(verifySerialOrder(sched, analyze(sched).serialOrder).valid, true);
    } else {
      const cyc = analyze(sched).cycle!;
      assert.equal(verifyCycle(sched, cyc).valid, true);
    }
  }
});
