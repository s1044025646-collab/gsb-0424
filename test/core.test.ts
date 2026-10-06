import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/analyze";
import { bruteForceSerializable } from "../src/bruteforce";
import { buildConflictEdges } from "../src/graph";
import { ScheduleError, ScheduleInput } from "../src/types";
import { validateSchedule } from "../src/validate";
import { verifyCycle, verifySerialOrder } from "../src/verify";

function run(input: ScheduleInput) {
  const v = validateSchedule(input);
  return { ...v, result: analyze(v.transactions, v.events) };
}

test("演示：r1(X) w2(X) r2(Y) w1(Y) 形成 1->2 与 2->1 的环", () => {
  const { result } = run({
    transactions: ["1", "2"],
    events: [
      { tx: "1", type: "read", item: "X" },
      { tx: "2", type: "write", item: "X" },
      { tx: "2", type: "read", item: "Y" },
      { tx: "1", type: "write", item: "Y" },
      { tx: "1", type: "commit" },
      { tx: "2", type: "commit" },
    ],
  });
  assert.equal(result.serializable, false);
  assert.ok(result.cycle);
  assert.deepEqual(result.cycle!.ring, ["1", "2", "1"]);
  const edgeKeys = result.cycle!.edges.map((e) => `${e.from}->${e.to}@${e.item}`);
  assert.ok(edgeKeys.includes("1->2@X"));
  assert.ok(edgeKeys.includes("2->1@Y"));
  // 每段环边都有具体事件见证
  for (const e of result.cycle!.edges) {
    assert.ok(e.witnesses.length >= 1);
    assert.equal(e.witnesses[0].earlier.tx, e.from);
    assert.equal(e.witnesses[0].later.tx, e.to);
  }
  // 环见证可被独立核验
  const v = validateSchedule({
    transactions: ["1", "2"],
    events: [
      { tx: "1", type: "read", item: "X" },
      { tx: "2", type: "write", item: "X" },
      { tx: "2", type: "read", item: "Y" },
      { tx: "1", type: "write", item: "Y" },
      { tx: "1", type: "commit" },
      { tx: "2", type: "commit" },
    ],
  });
  const check = verifyCycle(v.transactions, v.events, result.cycle!.ring);
  assert.equal(check.valid, true);
});

test("演示：只读交错没有任何冲突边，可串行化", () => {
  const { result } = run({
    transactions: ["1", "2"],
    events: [
      { tx: "1", type: "read", item: "X" },
      { tx: "2", type: "read", item: "X" },
      { tx: "2", type: "read", item: "Y" },
      { tx: "1", type: "read", item: "Y" },
      { tx: "1", type: "commit" },
      { tx: "2", type: "commit" },
    ],
  });
  assert.equal(result.serializable, true);
  assert.equal(result.edges.length, 0);
  assert.deepEqual(result.order, ["1", "2"]);
});

test("同项多次写：边去重但保留全部来源事件对", () => {
  const v = validateSchedule({
    transactions: ["1", "2"],
    events: [
      { tx: "1", type: "write", item: "X" },
      { tx: "2", type: "write", item: "X" },
      { tx: "1", type: "write", item: "X" },
      { tx: "2", type: "write", item: "X" },
      { tx: "1", type: "commit" },
      { tx: "2", type: "commit" },
    ],
  });
  const edges = buildConflictEdges(v.events);
  assert.equal(edges.length, 2); // 1->2 与 2->1 各一条（去重后）
  const e12 = edges.find((e) => e.from === "1" && e.to === "2")!;
  const e21 = edges.find((e) => e.from === "2" && e.to === "1")!;
  assert.equal(e12.witnesses.length, 3); // (0,1) (0,3) (2,3)
  assert.equal(e21.witnesses.length, 1); // (1,2)
});

test("不同数据项不产生冲突边", () => {
  const { result } = run({
    transactions: ["1", "2"],
    events: [
      { tx: "1", type: "write", item: "X" },
      { tx: "2", type: "write", item: "Y" },
      { tx: "1", type: "commit" },
      { tx: "2", type: "commit" },
    ],
  });
  assert.equal(result.edges.length, 0);
  assert.equal(result.serializable, true);
});

test("数据项名称区分大小写", () => {
  const { result } = run({
    transactions: ["1", "2"],
    events: [
      { tx: "1", type: "write", item: "x" },
      { tx: "2", type: "write", item: "X" },
      { tx: "1", type: "commit" },
      { tx: "2", type: "commit" },
    ],
  });
  assert.equal(result.edges.length, 0);
});

test("孤立事务（无冲突）参与拓扑排序且顺序稳定", () => {
  const { result } = run({
    transactions: ["3", "1", "2"],
    events: [
      { tx: "3", type: "read", item: "Z" },
      { tx: "1", type: "write", item: "X" },
      { tx: "2", type: "read", item: "X" },
      { tx: "1", type: "commit" },
      { tx: "2", type: "commit" },
      { tx: "3", type: "commit" },
    ],
  });
  assert.equal(result.serializable, true);
  // 零入度候选按固定编号选择：1 在 3 前，2 依赖 1
  assert.deepEqual(result.order, ["1", "2", "3"]);
});

test("多种拓扑顺序：外部合法顺序通过核验，非法顺序被拒绝", () => {
  const input: ScheduleInput = {
    transactions: ["1", "2", "3"],
    events: [
      { tx: "1", type: "write", item: "X" },
      { tx: "2", type: "read", item: "X" },
      { tx: "3", type: "read", item: "Y" },
      { tx: "1", type: "commit" },
      { tx: "2", type: "commit" },
      { tx: "3", type: "commit" },
    ],
  };
  const v = validateSchedule(input);
  // 1->2，3 孤立：[1,2,3] [1,3,2] [3,1,2] 均合法
  for (const order of [["1", "2", "3"], ["1", "3", "2"], ["3", "1", "2"]]) {
    assert.equal(verifySerialOrder(v.transactions, v.events, order).valid, true);
  }
  assert.equal(verifySerialOrder(v.transactions, v.events, ["2", "1", "3"]).valid, false);
});

test("错误见证：缺事务、重复事务、未闭合环、无支持边均被拒绝", () => {
  const input: ScheduleInput = {
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
  const v = validateSchedule(input);
  assert.equal(verifySerialOrder(v.transactions, v.events, ["1"]).valid, false);
  assert.equal(verifySerialOrder(v.transactions, v.events, ["1", "1"]).valid, false);
  assert.equal(verifySerialOrder(v.transactions, v.events, ["1", "9"]).valid, false);
  assert.equal(verifyCycle(v.transactions, v.events, ["1", "2"]).valid, false); // 未闭合
  assert.equal(verifyCycle(v.transactions, v.events, ["2", "1", "2"]).valid, true);
  assert.equal(verifyCycle(v.transactions, v.events, ["1", "1"]).valid, false); // 无自环边支持
});

test("校验：未知事务、重复提交、提交后读写、缺提交、无操作均被拒绝", () => {
  const base = { transactions: ["1", "2"] };
  assert.throws(
    () =>
      validateSchedule({
        ...base,
        events: [
          { tx: "9", type: "read", item: "X" },
          { tx: "1", type: "read", item: "X" },
          { tx: "1", type: "commit" },
          { tx: "2", type: "read", item: "Y" },
          { tx: "2", type: "commit" },
        ],
      }),
    (e) => e instanceof ScheduleError && e.code === "UNKNOWN_TRANSACTION"
  );
  assert.throws(
    () =>
      validateSchedule({
        ...base,
        events: [
          { tx: "1", type: "read", item: "X" },
          { tx: "1", type: "commit" },
          { tx: "1", type: "commit" },
          { tx: "2", type: "read", item: "Y" },
          { tx: "2", type: "commit" },
        ],
      }),
    (e) => e instanceof ScheduleError && e.code === "DUPLICATE_COMMIT"
  );
  assert.throws(
    () =>
      validateSchedule({
        ...base,
        events: [
          { tx: "1", type: "read", item: "X" },
          { tx: "1", type: "commit" },
          { tx: "1", type: "write", item: "X" },
          { tx: "2", type: "read", item: "Y" },
          { tx: "2", type: "commit" },
        ],
      }),
    (e) => e instanceof ScheduleError && e.code === "EVENT_AFTER_COMMIT"
  );
  assert.throws(
    () =>
      validateSchedule({
        ...base,
        events: [
          { tx: "1", type: "read", item: "X" },
          { tx: "1", type: "commit" },
          { tx: "2", type: "read", item: "Y" },
        ],
      }),
    (e) => e instanceof ScheduleError && e.code === "MISSING_COMMIT"
  );
  assert.throws(
    () =>
      validateSchedule({
        ...base,
        events: [
          { tx: "1", type: "read", item: "X" },
          { tx: "1", type: "commit" },
          { tx: "2", type: "commit" },
        ],
      }),
    (e) => e instanceof ScheduleError && e.code === "NO_OPERATIONS"
  );
});

test("穷举交叉核对：随机小规模调度图判定与穷举一致", () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let trial = 0; trial < 200; trial++) {
    const txCount = 2 + Math.floor(rand() * 3); // 2..4 个事务
    const txs = Array.from({ length: txCount }, (_, i) => String(i + 1));
    const items = ["X", "Y", "Z"];
    const events: ScheduleInput["events"] = [];
    for (const tx of txs) {
      const ops = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < ops; k++) {
        events.push({
          tx,
          type: rand() < 0.5 ? "read" : "write",
          item: items[Math.floor(rand() * items.length)],
        });
      }
    }
    // 打乱操作顺序后按事务追加提交
    for (let i = events.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [events[i], events[j]] = [events[j], events[i]];
    }
    for (const tx of txs) events.push({ tx, type: "commit" });
    const input: ScheduleInput = { transactions: txs, events };
    const v = validateSchedule(input);
    const graph = analyze(v.transactions, v.events);
    const brute = bruteForceSerializable(v.transactions, v.events);
    assert.equal(
      graph.serializable,
      brute.serializable,
      `第 ${trial} 轮不一致: ${JSON.stringify(input)}`
    );
    if (graph.serializable) {
      assert.equal(
        verifySerialOrder(v.transactions, v.events, graph.order).valid,
        true
      );
    } else {
      assert.ok(graph.cycle);
      assert.equal(
        verifyCycle(v.transactions, v.events, graph.cycle!.ring).valid,
        true
      );
    }
  }
});
