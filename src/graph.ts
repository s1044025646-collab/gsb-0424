import {
  AnalysisResult,
  ConflictEdge,
  CycleEdgeDetail,
  ScheduleInput,
} from "./types";
import { RULES_VERSION, SCOPE_NOTE } from "./validate";

/**
 * 从事件顺序建立冲突图：
 * 两个不同事务访问同一数据项且至少一方为写时，较早事件事务 -> 较晚事件事务。
 * 读-读不产生边；同事务内部不连边。边按 (from,to) 去重但保留全部来源见证。
 */
export function buildConflictGraph(schedule: ScheduleInput): ConflictEdge[] {
  const edgeMap = new Map<string, ConflictEdge>();
  // 每个数据项上，按事务记录该事务最早的读与写事件下标。
  // 边 A→B 存在当且仅当存在一对冲突事件 (a 早于 b)；用最早读/写即可覆盖全部边，
  // 同时保证见证中的 earlierSeq 确实早于 laterSeq。
  interface FirstAccess {
    firstR?: number;
    firstW?: number;
  }
  const access = new Map<string, Map<string, FirstAccess>>();

  const opAt = (seq: number): "R" | "W" => schedule.events[seq].op as "R" | "W";

  const addEdge = (from: string, to: string, item: string, earlierSeq: number, laterSeq: number) => {
    const key = `${from}→${to}`;
    let edge = edgeMap.get(key);
    if (!edge) {
      edge = { from, to, witnesses: [] };
      edgeMap.set(key, edge);
    }
    if (
      !edge.witnesses.some(
        (w) => w.item === item && w.earlierSeq === earlierSeq && w.laterSeq === laterSeq
      )
    ) {
      edge.witnesses.push({
        item,
        earlierSeq,
        earlierOp: opAt(earlierSeq),
        laterSeq,
        laterOp: opAt(laterSeq),
      });
    }
  };

  schedule.events.forEach((ev, seq) => {
    if (ev.op === "C") return;
    const item = ev.item!;
    let perTx = access.get(item);
    if (!perTx) {
      perTx = new Map();
      access.set(item, perTx);
    }
    for (const [otherTx, fa] of perTx) {
      if (otherTx === ev.tx) continue;
      if (ev.op === "W") {
        // 对方此前任意读或写都与本写冲突
        const earlier = Math.min(fa.firstR ?? Infinity, fa.firstW ?? Infinity);
        if (earlier !== Infinity) addEdge(otherTx, ev.tx, item, earlier, seq);
      } else {
        // 本读只与对方此前的写冲突
        if (fa.firstW !== undefined) addEdge(otherTx, ev.tx, item, fa.firstW, seq);
      }
    }
    let fa = perTx.get(ev.tx);
    if (!fa) {
      fa = {};
      perTx.set(ev.tx, fa);
    }
    if (ev.op === "R") {
      if (fa.firstR === undefined) fa.firstR = seq;
    } else {
      if (fa.firstW === undefined) fa.firstW = seq;
    }
  });

  return [...edgeMap.values()].sort((a, b) =>
    a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)
  );
}

/** 稳定拓扑排序（Kahn）：零入度候选按事务编号字典序选择 */
export function topoSort(
  transactions: string[],
  edges: ConflictEdge[]
): { order: string[] | null; multiple: boolean } {
  const indegree = new Map<string, number>();
  const adj = new Map<string, Set<string>>();
  for (const tx of transactions) {
    indegree.set(tx, 0);
    adj.set(tx, new Set());
  }
  for (const e of edges) {
    if (!adj.get(e.from)!.has(e.to)) {
      adj.get(e.from)!.add(e.to);
      indegree.set(e.to, indegree.get(e.to)! + 1);
    }
  }
  const ready = transactions.filter((t) => indegree.get(t) === 0).sort();
  const order: string[] = [];
  let multiple = false;
  while (ready.length > 0) {
    if (ready.length > 1) multiple = true;
    const tx = ready.shift()!;
    order.push(tx);
    for (const next of [...adj.get(tx)!].sort()) {
      const d = indegree.get(next)! - 1;
      indegree.set(next, d);
      if (d === 0) {
        // 保持 ready 有序，保证选择稳定
        const pos = ready.findIndex((r) => r.localeCompare(next) > 0);
        if (pos === -1) ready.push(next);
        else ready.splice(pos, 0, next);
      }
    }
  }
  if (order.length !== transactions.length) return { order: null, multiple };
  return { order, multiple };
}

/** 用迭代 DFS 在冲突图中找一条闭合事务环，返回形如 [A, B, C, A] */
export function findCycle(transactions: string[], edges: ConflictEdge[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const tx of transactions) adj.set(tx, []);
  for (const e of edges) adj.get(e.from)!.push(e.to);
  for (const list of adj.values()) list.sort();

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(transactions.map((t) => [t, WHITE]));
  const parent = new Map<string, string | null>();

  for (const start of [...transactions].sort()) {
    if (color.get(start) !== WHITE) continue;
    const stack: Array<{ node: string; childIdx: number }> = [{ node: start, childIdx: 0 }];
    color.set(start, GRAY);
    parent.set(start, null);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const children = adj.get(top.node)!;
      if (top.childIdx < children.length) {
        const child = children[top.childIdx++];
        const c = color.get(child)!;
        if (c === WHITE) {
          color.set(child, GRAY);
          parent.set(child, top.node);
          stack.push({ node: child, childIdx: 0 });
        } else if (c === GRAY) {
          // 找到环：从 top.node 沿 parent 回到 child
          const path = [top.node];
          let cur: string | null = top.node;
          while (cur !== child) {
            cur = parent.get(cur!)!;
            path.push(cur);
          }
          path.reverse();
          path.push(child); // 闭合
          return path;
        }
      } else {
        color.set(top.node, BLACK);
        stack.pop();
      }
    }
  }
  return null;
}

/** 分析调度：建图 → 拓扑排序或找环 */
export function analyze(schedule: ScheduleInput): AnalysisResult {
  const edges = buildConflictGraph(schedule);
  const { order, multiple } = topoSort(schedule.transactions, edges);
  if (order) {
    return {
      rulesVersion: RULES_VERSION,
      serializable: true,
      serialOrder: order,
      multipleOrdersPossible: multiple,
      cycle: null,
      cycleEdges: null,
      edges,
      scopeNote: SCOPE_NOTE,
    };
  }
  const cycle = findCycle(schedule.transactions, edges)!;
  const cycleEdges: CycleEdgeDetail[] = [];
  for (let i = 0; i < cycle.length - 1; i++) {
    const edge = edges.find((e) => e.from === cycle[i] && e.to === cycle[i + 1])!;
    cycleEdges.push({ from: edge.from, to: edge.to, witness: edge.witnesses[0] });
  }
  return {
    rulesVersion: RULES_VERSION,
    serializable: false,
    serialOrder: null,
    multipleOrdersPossible: false,
    cycle,
    cycleEdges,
    edges,
    scopeNote: SCOPE_NOTE,
  };
}
