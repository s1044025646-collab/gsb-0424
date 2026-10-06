import { analyze } from "./graph";
import { Store } from "./store";
import { AnalysisResult, ApiError } from "./types";
import { validateSchedule } from "./validate";
import { verifyCycle, verifySerialOrder } from "./verify";

/** 业务层：导入、分析、查询、见证核验、版本比较、导出 */
export class Service {
  constructor(public store: Store = new Store()) {}

  private getVersionOrThrow(versionId: number) {
    const v = this.store.getVersion(versionId);
    if (!v) throw new ApiError("NOT_FOUND", `版本不存在: ${versionId}`);
    return v;
  }

  /** 导入新调度（创建 schedule + version 1），并立即分析 */
  importSchedule(body: unknown, name?: string) {
    const schedule = validateSchedule(body);
    const version = this.store.createSchedule(name ?? null, schedule);
    const result = analyze(schedule);
    this.store.saveResult(version.versionId, result);
    return { ...version, result };
  }

  /** 为既有调度追加新版本（修改事件顺序即产生新版本），并分析 */
  addVersion(scheduleId: number, body: unknown) {
    const schedule = validateSchedule(body);
    const version = this.store.addVersion(scheduleId, schedule);
    const result = analyze(schedule);
    this.store.saveResult(version.versionId, result);
    return { ...version, result };
  }

  /** 重新分析指定版本（幂等，结果落库） */
  analyzeVersion(versionId: number): AnalysisResult {
    const v = this.getVersionOrThrow(versionId);
    const result = analyze(v.schedule);
    this.store.saveResult(versionId, result);
    return result;
  }

  /** 取已存结果；不存在则现算并落库（保证重启后可复核同一见证） */
  getResult(versionId: number): AnalysisResult {
    this.getVersionOrThrow(versionId);
    return this.store.getResult(versionId) ?? this.analyzeVersion(versionId);
  }

  getEdges(versionId: number) {
    return this.getResult(versionId).edges;
  }

  /** 查询一对事务的依赖依据 */
  getDependency(versionId: number, from: string, to: string) {
    const edges = this.getResult(versionId).edges;
    const edge = edges.find((e) => e.from === from && e.to === to);
    if (!edge) {
      throw new ApiError("NOT_FOUND", `不存在依赖边 ${from} -> ${to}`);
    }
    return edge;
  }

  verifyOrder(versionId: number, order: unknown) {
    const v = this.getVersionOrThrow(versionId);
    return verifySerialOrder(v.schedule, order);
  }

  verifyCycle(versionId: number, cycle: unknown) {
    const v = this.getVersionOrThrow(versionId);
    return verifyCycle(v.schedule, cycle);
  }

  /** 比较同一调度的两个版本：结论变化、边的新增/消失 */
  compare(versionIdA: number, versionIdB: number) {
    const a = this.getVersionOrThrow(versionIdA);
    const b = this.getVersionOrThrow(versionIdB);
    if (a.scheduleId !== b.scheduleId) {
      throw new ApiError("BAD_REQUEST", "只能比较同一调度下的两个版本");
    }
    const ra = this.getResult(versionIdA);
    const rb = this.getResult(versionIdB);
    const key = (e: { from: string; to: string }) => `${e.from}→${e.to}`;
    const setA = new Set(ra.edges.map(key));
    const setB = new Set(rb.edges.map(key));
    return {
      versionA: { versionId: a.versionId, versionNo: a.versionNo, serializable: ra.serializable },
      versionB: { versionId: b.versionId, versionNo: b.versionNo, serializable: rb.serializable },
      conclusionChanged: ra.serializable !== rb.serializable,
      edgesOnlyInA: ra.edges.filter((e) => !setB.has(key(e))),
      edgesOnlyInB: rb.edges.filter((e) => !setA.has(key(e))),
      resultA: ra,
      resultB: rb,
    };
  }

  /** 导出版本全部信息（原始事件、规则版本、分析结果） */
  exportVersion(versionId: number) {
    const v = this.getVersionOrThrow(versionId);
    return {
      scheduleId: v.scheduleId,
      versionId: v.versionId,
      versionNo: v.versionNo,
      createdAt: v.createdAt,
      transactions: v.schedule.transactions,
      events: v.schedule.events,
      result: this.getResult(versionId),
    };
  }
}
