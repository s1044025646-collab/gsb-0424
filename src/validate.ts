import { NormEvent, ScheduleError, ScheduleEvent, ScheduleInput } from "./types";

export const MAX_TRANSACTIONS = 64;
export const MAX_EVENTS = 10000;

const TX_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ITEM_PATTERN = /^.{1,128}$/;

function fail(code: string, message: string, details?: unknown): never {
  throw new ScheduleError(code, message, details);
}

export function validateSchedule(input: unknown): {
  name: string;
  transactions: string[];
  events: NormEvent[];
} {
  if (typeof input !== "object" || input === null) {
    fail("INVALID_INPUT", "请求体必须是对象");
  }
  const body = input as Partial<ScheduleInput>;
  const name =
    typeof body.name === "string" && body.name.trim().length > 0
      ? body.name.trim()
      : "schedule";
  if (name.length > 128) fail("INVALID_INPUT", "调度名称过长");

  if (!Array.isArray(body.transactions) || body.transactions.length === 0) {
    fail("INVALID_INPUT", "transactions 必须是非空数组");
  }
  const transactions = body.transactions as unknown[];
  if (transactions.length > MAX_TRANSACTIONS) {
    fail("LIMIT_EXCEEDED", `事务数超过上限 ${MAX_TRANSACTIONS}`);
  }
  const txSet = new Set<string>();
  for (const t of transactions) {
    if (typeof t !== "string" || !TX_PATTERN.test(t)) {
      fail("INVALID_TRANSACTION", `非法事务编号: ${JSON.stringify(t)}`);
    }
    if (txSet.has(t)) fail("INVALID_TRANSACTION", `重复事务编号: ${t}`);
    txSet.add(t);
  }

  if (!Array.isArray(body.events) || body.events.length === 0) {
    fail("INVALID_INPUT", "events 必须是非空数组");
  }
  const rawEvents = body.events as unknown[];
  if (rawEvents.length > MAX_EVENTS) {
    fail("LIMIT_EXCEEDED", `事件数超过上限 ${MAX_EVENTS}`);
  }

  const seenIds = new Set<number>();
  const events: NormEvent[] = rawEvents.map((raw, pos) => {
    if (typeof raw !== "object" || raw === null) {
      fail("INVALID_EVENT", `事件 #${pos} 必须是对象`);
    }
    const e = raw as ScheduleEvent;
    let id: number | null = null;
    if (e.id !== undefined) {
      if (!Number.isInteger(e.id) || (e.id as number) < 0) {
        fail("INVALID_EVENT", `事件 #${pos} 的 id 必须是非负整数`);
      }
      if (seenIds.has(e.id)) {
        fail("INVALID_EVENT", `事件编号重复: ${e.id}`);
      }
      seenIds.add(e.id);
      id = e.id;
    }
    if (typeof e.tx !== "string" || !txSet.has(e.tx)) {
      fail("UNKNOWN_TRANSACTION", `事件 #${pos} 引用未知事务: ${JSON.stringify(e.tx)}`);
    }
    if (e.type !== "read" && e.type !== "write" && e.type !== "commit") {
      fail("INVALID_EVENT", `事件 #${pos} 类型非法: ${JSON.stringify(e.type)}`);
    }
    if (e.type === "commit") {
      if (e.item !== undefined) {
        fail("INVALID_EVENT", `事件 #${pos} commit 不允许携带数据项`);
      }
      return { pos, id, tx: e.tx, type: e.type, item: null };
    }
    if (typeof e.item !== "string" || !ITEM_PATTERN.test(e.item)) {
      fail("INVALID_ITEM", `事件 #${pos} 数据项非法`);
    }
    return { pos, id, tx: e.tx, type: e.type, item: e.item };
  });

  // 每个事务：恰好一次提交、至少一次读写、提交后无读写
  for (const tx of txSet) {
    const mine = events.filter((e) => e.tx === tx);
    const commits = mine.filter((e) => e.type === "commit");
    if (commits.length === 0) {
      fail("MISSING_COMMIT", `事务 ${tx} 缺少提交事件`);
    }
    if (commits.length > 1) {
      fail("DUPLICATE_COMMIT", `事务 ${tx} 重复提交`, {
        positions: commits.map((c) => c.pos),
      });
    }
    const ops = mine.filter((e) => e.type !== "commit");
    if (ops.length === 0) {
      fail("NO_OPERATIONS", `事务 ${tx} 没有任何读写操作`);
    }
    const commitPos = commits[0].pos;
    const after = ops.filter((e) => e.pos > commitPos);
    if (after.length > 0) {
      fail("EVENT_AFTER_COMMIT", `事务 ${tx} 提交后仍有读写事件`, {
        positions: after.map((e) => e.pos),
      });
    }
  }

  return { name, transactions: [...txSet], events };
}
