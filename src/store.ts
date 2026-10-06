import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { AnalysisResult, ScheduleInput } from "./types";
import { RULES_VERSION } from "./validate";

export const DATA_DIR = process.env.CS_DATA_DIR ?? path.join(process.cwd(), "data");
export const DB_PATH = process.env.CS_DB_PATH ?? path.join(DATA_DIR, "schedules.db");

export interface VersionRow {
  versionId: number;
  scheduleId: number;
  versionNo: number;
  schedule: ScheduleInput;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string = DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id INTEGER NOT NULL REFERENCES schedules(id),
        version_no INTEGER NOT NULL,
        transactions_json TEXT NOT NULL,
        events_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(schedule_id, version_no)
      );
      CREATE TABLE IF NOT EXISTS results (
        version_id INTEGER PRIMARY KEY REFERENCES versions(id),
        rules_version TEXT NOT NULL,
        serializable INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  createSchedule(name: string | null, schedule: ScheduleInput): VersionRow {
    const now = new Date().toISOString();
    const r = this.db
      .prepare("INSERT INTO schedules (name, created_at) VALUES (?, ?)")
      .run(name, now);
    const scheduleId = Number(r.lastInsertRowid);
    return this.addVersion(scheduleId, schedule);
  }

  addVersion(scheduleId: number, schedule: ScheduleInput): VersionRow {
    this.getScheduleOrThrow(scheduleId);
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version_no), 0) AS maxv FROM versions WHERE schedule_id = ?")
      .get(scheduleId) as { maxv: number };
    const versionNo = row.maxv + 1;
    const now = new Date().toISOString();
    const r = this.db
      .prepare(
        "INSERT INTO versions (schedule_id, version_no, transactions_json, events_json, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(
        scheduleId,
        versionNo,
        JSON.stringify(schedule.transactions),
        JSON.stringify(schedule.events),
        now
      );
    return {
      versionId: Number(r.lastInsertRowid),
      scheduleId,
      versionNo,
      schedule,
      createdAt: now,
    };
  }

  getScheduleOrThrow(scheduleId: number): { id: number; name: string | null } {
    const row = this.db
      .prepare("SELECT id, name FROM schedules WHERE id = ?")
      .get(scheduleId) as { id: number; name: string | null } | undefined;
    if (!row) throw Object.assign(new Error(`调度不存在: ${scheduleId}`), { code: "NOT_FOUND" });
    return row;
  }

  getVersion(versionId: number): VersionRow | null {
    const row = this.db
      .prepare(
        "SELECT id, schedule_id, version_no, transactions_json, events_json, created_at FROM versions WHERE id = ?"
      )
      .get(versionId) as
      | {
          id: number;
          schedule_id: number;
          version_no: number;
          transactions_json: string;
          events_json: string;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      versionId: row.id,
      scheduleId: row.schedule_id,
      versionNo: row.version_no,
      schedule: {
        transactions: JSON.parse(row.transactions_json),
        events: JSON.parse(row.events_json),
      },
      createdAt: row.created_at,
    };
  }

  listVersions(scheduleId: number): Array<{ versionId: number; versionNo: number; createdAt: string }> {
    const rows = this.db
      .prepare("SELECT id, version_no, created_at FROM versions WHERE schedule_id = ? ORDER BY version_no")
      .all(scheduleId) as Array<{ id: number; version_no: number; created_at: string }>;
    return rows.map((r) => ({ versionId: r.id, versionNo: r.version_no, createdAt: r.created_at }));
  }

  saveResult(versionId: number, result: AnalysisResult): void {
    this.db
      .prepare(
        `INSERT INTO results (version_id, rules_version, serializable, result_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(version_id) DO UPDATE SET
           rules_version = excluded.rules_version,
           serializable = excluded.serializable,
           result_json = excluded.result_json,
           created_at = excluded.created_at`
      )
      .run(
        versionId,
        RULES_VERSION,
        result.serializable ? 1 : 0,
        JSON.stringify(result),
        new Date().toISOString()
      );
  }

  getResult(versionId: number): AnalysisResult | null {
    const row = this.db
      .prepare("SELECT result_json FROM results WHERE version_id = ?")
      .get(versionId) as { result_json: string } | undefined;
    return row ? (JSON.parse(row.result_json) as AnalysisResult) : null;
  }

  close(): void {
    this.db.close();
  }
}
