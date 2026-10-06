import { ConflictEdge, CycleWitness, EventRef, NormEvent } from "./types";

function toRef(e: NormEvent): EventRef {
  return { pos: e.pos, id: e.id, tx: e.tx, type: e.type, item: e.item as string };
}

/** 事务编号固定比较：纯数字按数值，否则按字典序，保证拓扑选择稳定 */
export function compareTx(a: string, b: string): number {
  const na = /^\d+$/.test(a) ? Number(a) : NaN;
  const nb = /^\d+$/.test(b) ? Number(b) : NaN;
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 从事件顺序建立冲突图。
 * 不同事务访问同一数据项且至少一方为写：较早者 -> 较晚者。
 * 读-读不连边，同事务不连边。边去重但保留全部来源事件对。
 */
export function buildConflictEdges(events: NormEvent[]): ConflictEdge[] {
  const byItem = new Map<string, NormEvent[]>();
  for (const e of events) {
    if (e.type === "commit") continue;
    const list = byItem.get(e.item as string);
    if (list) list.push(e);
    else byItem.set(e.item as string, [e]);
  }
  const edgeMap = new Map<string, ConflictEdge>();
  for (const [item, list] of byItem) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.tx === b.tx) continue;
        if (a.type === "read" && b.type === "read") continue;
        const key = `${a.tx} ${b.tx} ${item}`;
        let edge = edgeMap.get(key);
        if (!edge) {
          edge = { from: a.tx, to: b.tx, item, witnesses: [] };
          edgeMap.set(key, edge);
        }
        edge.witnesses.push({ earlier: toRef(a), later: toRef(b) });
      }
    }
  }
  return [...edgeMap.values()].sort(
    (x, y) =>
      compareTx(x.from, y.from) || compareTx(x.to, y.to) || (x.item < y.item ? -1 : 1)
  );
}

interface Adj {
  nodes: string[];
  out: Map<string, ConflictEdge[]>;
  indeg: Map<string, number>;
}

function buildAdj(transactions: string[], edges: ConflictEdge[]): Adj {
  const nodes = [...transactions].sort(compareTx);
  const out = new Map<string, ConflictEdge[]>();
  const indeg = new Map<string, number>();
  for (const n of nodes) {
    out.set(n, []);
    indeg.set(n, 0);
  }
  for (const e of edges) {
    out.get(e.from)!.push(e);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  return { nodes, out, indeg };
}

/** Kahn 拓扑排序；零入度候选按固定事务编号选择，结果稳定。有环返回 null。 */
export function topoOrder(
  transactions: string[],
  edges: ConflictEdge[]
): string[] | null {
  const { nodes, out, indeg } = buildAdj(transactions, edges);
  const order: string[] = [];
  const remaining = new Set(nodes);
  const deg = new Map(indeg);
  while (remaining.size > 0) {
    const ready = [...remaining].filter((n) => deg.get(n) === 0).sort(compareTx);
    if (ready.length === 0) return null;
    const next = ready[0];
    remaining.delete(next);
    order.push(next);
    for (const e of out.get(next) ?? []) {
      deg.set(e.to, (deg.get(e.to) ?? 0) - 1);
    }
  }
  return order;
}

/** DFS 找一条闭合环，环上每条边附带实际冲突事件见证。无环返回 null。 */
export function findCycle(
  transactions: string[],
  edges: ConflictEdge[]
): CycleWitness | null {
  const { nodes, out } = buildAdj(transactions, edges);
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(nodes.map((n) => [n, WHITE]));
  const stack: string[] = [];
  const stackEdges: ConflictEdge[] = [];

  const dfs = (node: string): CycleWitness | null => {
    color.set(node, GRAY);
    stack.push(node);
    for (const edge of out.get(node) ?? []) {
      const next = edge.to;
      const c = color.get(next);
      if (c === GRAY) {
        const startIdx = stack.indexOf(next);
        const ringNodes = stack.slice(startIdx);
        const ringEdges = [...stackEdges.slice(startIdx), edge];
        const ring = [...ringNodes, next];
        return {
          ring,
          edges: ringEdges.map((e) => ({
            from: e.from,
            to: e.to,
            item: e.item,
            witnesses: e.witnesses,
          })),
        };
      }
      if (c === WHITE) {
        stackEdges.push(edge);
        const found = dfs(next);
        if (found) return found;
        stackEdges.pop();
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  };

  for (const n of nodes) {
    if (color.get(n) === WHITE) {
      const found = dfs(n);
      if (found) return found;
    }
  }
  return null;
}
