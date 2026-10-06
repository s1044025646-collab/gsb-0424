/** 事件操作类型：读 / 写 / 提交 */
export type OpType = "R" | "W" | "C";

/** 客户端提交的原始事件（数组顺序即发生顺序，不使用任何时间戳） */
export interface RawEvent {
  tx: string;
  op: OpType;
  /** R/W 必填；C 不允许携带 */
  item?: string;
}

/** 调度输入 */
export interface ScheduleInput {
  transactions: string[];
  events: RawEvent[];
}

/** 冲突边的一对来源事件见证 */
export interface EdgeWitness {
  item: string;
  /** 较早事件在输入数组中的下标（0 起） */
  earlierSeq: number;
  earlierOp: Exclude<OpType, "C">;
  /** 较晚事件下标 */
  laterSeq: number;
  laterOp: Exclude<OpType, "C">;
}

/** 一条依赖边 from -> to（from 必须排在 to 之前） */
export interface ConflictEdge {
  from: string;
  to: string;
  witnesses: EdgeWitness[];
}

/** 环上一条边的具体冲突说明 */
export interface CycleEdgeDetail {
  from: string;
  to: string;
  witness: EdgeWitness;
}

export interface AnalysisResult {
  rulesVersion: string;
  serializable: boolean;
  /** 无环时给出一个稳定拓扑顺序；可能还存在其他合法顺序 */
  serialOrder: string[] | null;
  /** 是否可能存在其他合法串行顺序 */
  multipleOrdersPossible: boolean;
  /** 有环时给出闭合事务环（首尾相同，如 ["T1","T2","T1"]） */
  cycle: string[] | null;
  cycleEdges: CycleEdgeDetail[] | null;
  edges: ConflictEdge[];
  /** 结论仅针对冲突可串行化，见 README 范围说明 */
  scopeNote: string;
}

export type ErrorCode =
  | "INVALID_BODY"
  | "INVALID_TRANSACTIONS"
  | "INVALID_EVENT"
  | "UNKNOWN_TRANSACTION"
  | "MISSING_COMMIT"
  | "DUPLICATE_COMMIT"
  | "EVENT_AFTER_COMMIT"
  | "NO_OPERATIONS"
  | "LIMIT_EXCEEDED"
  | "NOT_FOUND"
  | "WITNESS_INVALID"
  | "BAD_REQUEST";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}
