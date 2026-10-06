import { buildConflictEdges, compareTx } from "./graph";
import { ConflictEdge, NormEvent, ScheduleError } from "./types";

export interface VerifyOrderResult {
  valid: boolean;
  errors: string[];
}

/** 验证外部串行顺序：每个事务恰好一次，且尊重所有冲突边方向 */
export function verifySerialOrder(
  transactions: string[],
  events: NormEvent[],
  order: unknown
): VerifyOrderResult {
  const errors: string[] = [];
  if (!Array.isArray(order)) {
    throw new ScheduleError("INVALID_INPUT", "order 必须是事务编号数组");
  }
  const seen = new Set<string>();
  for (const t of order) {
    if (typeof t !== "string" || !transactions.includes(t)) {
      errors.push(`未知事务: ${JSON.stringify(t)}`);
      continue;
    }
    if (seen.has(t)) errors.push(`事务重复出现: ${t}`);
    seen.add(t);
  }
  for (const t of transactions) {
    if (!seen.has(t)) errors.push(`缺少事务: ${t}`);
  }
  if (errors.length > 0) return { valid: false, errors };

  const rank = new Map<string, number>(order.map((t, i) => [t as string, i]));
  const edges = buildConflictEdges(events);
  for (const e of edges) {
    if ((rank.get(e.from) ?? 0) >= (rank.get(e.to) ?? 0)) {
      errors.push(`冲突边 ${e.from} -> ${e.to} (项 ${e.item}) 未被尊重`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export interface VerifyCycleResult {
  valid: boolean;
  errors: string[];
  /** 核验通过时返回每段环边对应的支持冲突边 */
  supportedEdges?: ConflictEdge[];
}

/** 验证外部环见证：首尾相接，且每段边确实由原事件支持 */
export function verifyCycle(
  transactions: string[],
  events: NormEvent[],
  ring: unknown
): VerifyCycleResult {
  const errors: string[] = [];
  if (!Array.isArray(ring) || ring.length < 2) {
    throw new ScheduleError(
      "INVALID_INPUT",
      "cycle 必须是至少含 2 个元素的事务编号数组（首尾相同表示闭合）"
    );
  }
  const nodes = ring as unknown[];
  for (const n of nodes) {
    if (typeof n !== "string" || !transactions.includes(n)) {
      errors.push(`环中包含未知事务: ${JSON.stringify(n)}`);
    }
  }
  if (errors.length > 0) return { valid: false, errors };
  const txRing = nodes as string[];
  if (txRing[0] !== txRing[txRing.length - 1]) {
    errors.push("环未闭合：首尾事务必须相同");
  }
  const inner = txRing.slice(0, -1);
  if (new Set(inner).size !== inner.length) {
    errors.push("环中事务重复（简单环要求除首尾外不重复）");
  }
  if (errors.length > 0) return { valid: false, errors };

  const edges = buildConflictEdges(events);
  const supported: ConflictEdge[] = [];
  for (let i = 0; i < txRing.length - 1; i++) {
    const from = txRing[i];
    const to = txRing[i + 1];
    const matches = edges.filter((e) => e.from === from && e.to === to);
    if (matches.length === 0) {
      errors.push(`环边 ${from} -> ${to} 没有任何原始冲突事件支持`);
    } else {
      supported.push(...matches);
    }
  }
  if (errors.length > 0) return { valid: false, errors };
  supported.sort((x, y) => compareTx(x.from, y.from) || compareTx(x.to, y.to));
  return { valid: true, errors: [], supportedEdges: supported };
}
