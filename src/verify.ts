import { ApiError, ScheduleInput } from "./types";
import { buildConflictGraph } from "./graph";

export interface VerifyOrderResult {
  valid: boolean;
  errors: string[];
}

/**
 * 核验外部串行顺序：必须包含每个事务恰好一次，且尊重所有冲突边方向。
 */
export function verifySerialOrder(
  schedule: ScheduleInput,
  order: unknown
): VerifyOrderResult {
  const errors: string[] = [];
  if (!Array.isArray(order) || order.some((t) => typeof t !== "string")) {
    throw new ApiError("INVALID_BODY", "order 必须是事务编号字符串数组");
  }
  const txs = schedule.transactions;
  const seen = new Set<string>();
  for (const t of order as string[]) {
    if (!txs.includes(t)) {
      errors.push(`顺序中包含未声明的事务: ${t}`);
    } else if (seen.has(t)) {
      errors.push(`事务在顺序中出现多次: ${t}`);
    }
    seen.add(t);
  }
  for (const t of txs) {
    if (!seen.has(t)) errors.push(`顺序缺少事务: ${t}`);
  }
  if (errors.length > 0) return { valid: false, errors };

  const pos = new Map<string, number>((order as string[]).map((t, i) => [t, i]));
  const edges = buildConflictGraph(schedule);
  for (const e of edges) {
    if (pos.get(e.from)! >= pos.get(e.to)!) {
      const w = e.witnesses[0];
      errors.push(
        `违反依赖 ${e.from} -> ${e.to}（数据项 ${w.item}：事件#${w.earlierSeq} ${w.earlierOp} 早于 事件#${w.laterSeq} ${w.laterOp}）`
      );
    }
  }
  return { valid: errors.length === 0, errors };
}

export interface VerifyCycleResult {
  valid: boolean;
  errors: string[];
  /** 核验通过时，环上每条边对应的具体冲突事件 */
  edgeWitnesses?: Array<{ from: string; to: string; witness: unknown }>;
}

/**
 * 核验外部依赖环见证：环首尾相接，且每条边确实由原事件支持。
 * 输入形如 ["T1","T2","T1"]（首尾相同）或 ["T1","T2"]（自动闭合）。
 */
export function verifyCycle(schedule: ScheduleInput, cycle: unknown): VerifyCycleResult {
  const errors: string[] = [];
  if (!Array.isArray(cycle) || cycle.length < 1 || cycle.some((t) => typeof t !== "string")) {
    throw new ApiError("INVALID_BODY", "cycle 必须是事务编号字符串数组");
  }
  let nodes = cycle as string[];
  if (nodes.length === 1) nodes = [...nodes, nodes[0]];
  else if (nodes[0] !== nodes[nodes.length - 1]) nodes = [...nodes, nodes[0]];

  const inner = nodes.slice(0, -1);
  if (new Set(inner).size !== inner.length) {
    errors.push("环中事务重复出现（除首尾闭合外）");
  }
  for (const t of inner) {
    if (!schedule.transactions.includes(t)) {
      errors.push(`环中包含未声明的事务: ${t}`);
    }
  }
  if (errors.length > 0) return { valid: false, errors };

  const edges = buildConflictGraph(schedule);
  const witnesses: Array<{ from: string; to: string; witness: unknown }> = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const from = nodes[i];
    const to = nodes[i + 1];
    const edge = edges.find((e) => e.from === from && e.to === to);
    if (!edge) {
      errors.push(`环上的边 ${from} -> ${to} 没有任何原始冲突事件支持`);
    } else {
      witnesses.push({ from, to, witness: edge.witnesses[0] });
    }
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, errors: [], edgeWitnesses: witnesses };
}
