import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AnalysisResult, NormEvent, RULE_VERSION, ScheduleError } from "./types";

export interface StoredSchedule {
  id: number;
  name: string;
  version: number;
  ruleVersion: string;
  createdAt: string;
  transactions: string[];
  events: NormEvent[];
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        rule_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        transactions_json TEXT NOT NULL,
        events_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS results (
        schedule_id INTEGER PRIMARY KEY REFERENCES schedules(id),
        serializable INTEGER NOT NULL,
        order_json TEXT,
        cycle_json TEXT,
        edges_json TEXT NOT NULL,
        analyzed_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  static hashContent(transactions: string[], events: NormEvent[]): string {
    const canonical = JSON.stringify({ transactions, events });
    return createHash("sha256").update(canonical).digest("hex");
  }

  /** 导入调度：内容相同返回已有记录；内容变化（如事件顺序调整）产生同一名字的新版本 */
  importSchedule(
    name: string,
    transactions: string[],
    events: NormEvent[]
  ): StoredSchedule {
    const hash = Store.hashContent(transactions, events);
    const existing = this.db
      .prepare("SELECT id FROM schedules WHERE content_hash = ?")
      .get(hash) as { id: number } | undefined;
    if (existing) return this.getSchedule(existing.id);

    const row = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schedules WHERE name = ?")
      .get(name) as { v: number };
    const version = row.v + 1;
    const info = this.db
      .prepare(
        `INSERT INTO schedules (name, version, content_hash, rule_version, created_at, transactions_json, events_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        name,
        version,
        hash,
        RULE_VERSION,
        new Date().toISOString(),
        JSON.stringify(transactions),
        JSON.stringify(events)
      );
    return this.getSchedule(Number(info.lastInsertRowid));
  }

  getSchedule(id: number): StoredSchedule {
    const row = this.db
      .prepare("SELECT * FROM schedules WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new ScheduleError("NOT_FOUND", `调度不存在: ${id}`);
    return {
      id: row.id as number,
      name: row.name as string,
      version: row.version as number,
      ruleVersion: row.rule_version as string,
      createdAt: row.created_at as string,
      transactions: JSON.parse(row.transactions_json as string),
      events: JSON.parse(row.events_json as string),
    };
  }

  listSchedules(): Omit<StoredSchedule, "transactions" | "events">[] {
    const rows = this.db
      .prepare(
        "SELECT id, name, version, rule_version, created_at FROM schedules ORDER BY name, version"
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      name: r.name as string,
      version: r.version as number,
      ruleVersion: r.rule_version as string,
      createdAt: r.created_at as string,
    }));
  }

  saveResult(scheduleId: number, result: AnalysisResult): void {
    this.db
      .prepare(
        `INSERT INTO results (schedule_id, serializable, order_json, cycle_json, edges_json, analyzed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(schedule_id) DO UPDATE SET
           serializable = excluded.serializable,
           order_json = excluded.order_json,
           cycle_json = excluded.cycle_json,
           edges_json = excluded.edges_json,
           analyzed_at = excluded.analyzed_at`
      )
      .run(
        scheduleId,
        result.serializable ? 1 : 0,
        result.order ? JSON.stringify(result.order) : null,
        result.cycle ? JSON.stringify(result.cycle) : null,
        JSON.stringify(result.edges),
        new Date().toISOString()
      );
  }

  getResult(scheduleId: number): AnalysisResult | null {
    const row = this.db
      .prepare("SELECT * FROM results WHERE schedule_id = ?")
      .get(scheduleId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const schedule = this.getSchedule(scheduleId);
    return {
      serializable: (row.serializable as number) === 1,
      order: row.order_json ? JSON.parse(row.order_json as string) : null,
      orderNote:
        (row.serializable as number) === 1
          ? "给出一个稳定拓扑顺序（零入度候选按固定事务编号选择）；可能还存在其他合法串行顺序。"
          : null,
      cycle: row.cycle_json ? JSON.parse(row.cycle_json as string) : null,
      edges: JSON.parse(row.edges_json as string),
      transactions: schedule.transactions,
      eventCount: schedule.events.length,
      ruleVersion: schedule.ruleVersion,
      scope:
        "结论仅声明冲突可串行化；不蕴含可恢复性、业务正确性或读取值正确，也不是视图可串行化分析。",
    };
  }
}
