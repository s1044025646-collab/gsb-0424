import { buildConflictEdges } from "./graph";
import { NormEvent } from "./types";

export const BRUTE_FORCE_MAX_TX = 8;

/**
 * 独立穷举所有串行排列，检查是否存在一个排列保持所有冲突先后。
 * 用于小规模事务数下交叉核对图算法结论。
 */
export function bruteForceSerializable(
  transactions: string[],
  events: NormEvent[]
): { serializable: boolean; exampleOrder: string[] | null } {
  if (transactions.length > BRUTE_FORCE_MAX_TX) {
    throw new Error(`事务数超过穷举上限 ${BRUTE_FORCE_MAX_TX}`);
  }
  const edges = buildConflictEdges(events);
  const perm = [...transactions];
  const result = permuteAndFind(perm, 0, edges);
  return { serializable: result !== null, exampleOrder: result };
}

function permuteAndFind(
  perm: string[],
  start: number,
  edges: { from: string; to: string }[]
): string[] | null {
  if (start === perm.length) {
    const rank = new Map(perm.map((t, i) => [t, i]));
    for (const e of edges) {
      if ((rank.get(e.from) ?? 0) >= (rank.get(e.to) ?? 0)) return null;
    }
    return [...perm];
  }
  for (let i = start; i < perm.length; i++) {
    [perm[start], perm[i]] = [perm[i], perm[start]];
    const found = permuteAndFind(perm, start + 1, edges);
    if (found) return found;
    [perm[start], perm[i]] = [perm[i], perm[start]];
  }
  return null;
}
