import { ApiError, RawEvent, ScheduleInput } from "./types";

export const RULES_VERSION = "conflict-serializability-v1";
export const SCOPE_NOTE =
  "结论仅针对冲突可串行化（conflict serializability）；不代表可恢复性、业务正确性或读取值正确，也不覆盖视图可串行化。";

export const MAX_TRANSACTIONS = Number(process.env.CS_MAX_TRANSACTIONS ?? 64);
export const MAX_EVENTS = Number(process.env.CS_MAX_EVENTS ?? 10000);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** 校验调度输入；非法调度直接抛 ApiError，绝不进入分析流程 */
export function validateSchedule(input: unknown): ScheduleInput {
  if (typeof input !== "object" || input === null) {
    throw new ApiError("INVALID_BODY", "请求体必须是对象，包含 transactions 与 events");
  }
  const body = input as Record<string, unknown>;

  if (!Array.isArray(body.transactions)) {
    throw new ApiError("INVALID_TRANSACTIONS", "transactions 必须是事务编号数组");
  }
  const transactions = body.transactions as unknown[];
  if (transactions.length === 0) {
    throw new ApiError("INVALID_TRANSACTIONS", "transactions 不能为空");
  }
  if (transactions.length > MAX_TRANSACTIONS) {
    throw new ApiError("LIMIT_EXCEEDED", `事务数超过上限 ${MAX_TRANSACTIONS}`);
  }
  const txSet = new Set<string>();
  for (const t of transactions) {
    if (!isNonEmptyString(t)) {
      throw new ApiError("INVALID_TRANSACTIONS", "事务编号必须是非空字符串");
    }
    if (txSet.has(t)) {
      throw new ApiError("INVALID_TRANSACTIONS", `事务编号重复: ${t}`);
    }
    txSet.add(t);
  }

  if (!Array.isArray(body.events)) {
    throw new ApiError("INVALID_EVENT", "events 必须是事件数组，数组顺序即发生顺序");
  }
  const events = body.events as unknown[];
  if (events.length > MAX_EVENTS) {
    throw new ApiError("LIMIT_EXCEEDED", `事件数超过上限 ${MAX_EVENTS}`);
  }

  const committed = new Set<string>();
  const commitCount = new Map<string, number>();
  const opCount = new Map<string, number>();
  const parsed: RawEvent[] = [];

  events.forEach((raw, idx) => {
    if (typeof raw !== "object" || raw === null) {
      throw new ApiError("INVALID_EVENT", `事件 #${idx} 必须是对象`);
    }
    const e = raw as Record<string, unknown>;
    if (!isNonEmptyString(e.tx)) {
      throw new ApiError("INVALID_EVENT", `事件 #${idx} 缺少合法 tx 字段`);
    }
    if (!txSet.has(e.tx)) {
      throw new ApiError("UNKNOWN_TRANSACTION", `事件 #${idx} 引用未声明的事务: ${e.tx}`);
    }
    if (e.op !== "R" && e.op !== "W" && e.op !== "C") {
      throw new ApiError("INVALID_EVENT", `事件 #${idx} 的 op 必须是 R/W/C`);
    }
    if (committed.has(e.tx) && e.op !== "C") {
      throw new ApiError("EVENT_AFTER_COMMIT", `事务 ${e.tx} 提交后不能再有读写事件（事件 #${idx}）`);
    }
    if (e.op === "C") {
      if (e.item !== undefined) {
        throw new ApiError("INVALID_EVENT", `提交事件 #${idx} 不允许携带 item`);
      }
      commitCount.set(e.tx, (commitCount.get(e.tx) ?? 0) + 1);
      if (commitCount.get(e.tx)! > 1) {
        throw new ApiError("DUPLICATE_COMMIT", `事务 ${e.tx} 重复提交`);
      }
      committed.add(e.tx);
    } else {
      if (!isNonEmptyString(e.item)) {
        throw new ApiError("INVALID_EVENT", `事件 #${idx} 的 item 必须是非空字符串（区分大小写）`);
      }
      opCount.set(e.tx, (opCount.get(e.tx) ?? 0) + 1);
    }
    parsed.push({ tx: e.tx, op: e.op, item: e.item as string | undefined });
  });

  for (const tx of txSet) {
    if (!committed.has(tx)) {
      throw new ApiError("MISSING_COMMIT", `事务 ${tx} 缺少提交事件；只接受所有事务均已提交的完整调度`);
    }
    if (!opCount.get(tx)) {
      throw new ApiError("NO_OPERATIONS", `事务 ${tx} 至少需要一个读或写事件`);
    }
  }

  return { transactions: [...txSet].sort(), events: parsed };
}
