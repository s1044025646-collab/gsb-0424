export type EventType = "read" | "write" | "commit";

export interface ScheduleEvent {
  /** 可选客户端事件编号；必须唯一。事件先后以数组下标为准。 */
  id?: number;
  tx: string;
  type: EventType;
  /** read/write 必填，commit 不允许携带 */
  item?: string;
}

export interface ScheduleInput {
  name?: string;
  transactions: string[];
  events: ScheduleEvent[];
}

/** 归一化后的内部事件，pos 为数组下标（0 起） */
export interface NormEvent {
  pos: number;
  id: number | null;
  tx: string;
  type: EventType;
  item: string | null;
}

export interface EventRef {
  pos: number;
  id: number | null;
  tx: string;
  type: EventType;
  item: string;
}

export interface ConflictPair {
  earlier: EventRef;
  later: EventRef;
}

export interface ConflictEdge {
  from: string;
  to: string;
  item: string;
  /** 去重后的边仍保留全部来源事件对，至少一对 */
  witnesses: ConflictPair[];
}

export interface CycleWitnessEdge {
  from: string;
  to: string;
  item: string;
  witnesses: ConflictPair[];
}

export interface CycleWitness {
  /** 闭合事务环，首尾相同，如 ["1","2","1"] */
  ring: string[];
  edges: CycleWitnessEdge[];
}

export interface AnalysisResult {
  serializable: boolean;
  /** 无环时给出一个稳定拓扑顺序；可能还存在其他合法顺序 */
  order: string[] | null;
  orderNote: string | null;
  /** 有环时给出闭合环见证 */
  cycle: CycleWitness | null;
  edges: ConflictEdge[];
  transactions: string[];
  eventCount: number;
  ruleVersion: string;
  /** 结论仅针对冲突可串行化 */
  scope: string;
}

export class ScheduleError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export const RULE_VERSION = "conflict-serializable-v1";
export const SCOPE_NOTE =
  "结论仅声明冲突可串行化；不蕴含可恢复性、业务正确性或读取值正确，也不是视图可串行化分析。";
