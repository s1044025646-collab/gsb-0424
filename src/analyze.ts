import { buildConflictEdges, findCycle, topoOrder } from "./graph";
import {
  AnalysisResult,
  NormEvent,
  RULE_VERSION,
  SCOPE_NOTE,
} from "./types";

export function analyze(
  transactions: string[],
  events: NormEvent[]
): AnalysisResult {
  const edges = buildConflictEdges(events);
  const order = topoOrder(transactions, edges);
  if (order !== null) {
    return {
      serializable: true,
      order,
      orderNote:
        "给出一个稳定拓扑顺序（零入度候选按固定事务编号选择）；可能还存在其他合法串行顺序。",
      cycle: null,
      edges,
      transactions: [...transactions].sort(),
      eventCount: events.length,
      ruleVersion: RULE_VERSION,
      scope: SCOPE_NOTE,
    };
  }
  const cycle = findCycle(transactions, edges);
  return {
    serializable: false,
    order: null,
    orderNote: null,
    cycle,
    edges,
    transactions: [...transactions].sort(),
    eventCount: events.length,
    ruleVersion: RULE_VERSION,
    scope: SCOPE_NOTE,
  };
}
