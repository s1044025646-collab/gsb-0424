import { analyze } from "./analyze";
import { StoredSchedule } from "./store";

export interface CompareResult {
  a: { id: number; name: string; version: number; serializable: boolean };
  b: { id: number; name: string; version: number; serializable: boolean };
  edgesOnlyInA: { from: string; to: string; item: string }[];
  edgesOnlyInB: { from: string; to: string; item: string }[];
  sharedEdges: { from: string; to: string; item: string }[];
  verdictChanged: boolean;
}

export function compareSchedules(a: StoredSchedule, b: StoredSchedule): CompareResult {
  const ra = analyze(a.transactions, a.events);
  const rb = analyze(b.transactions, b.events);
  const key = (e: { from: string; to: string; item: string }) =>
    `${e.from} ${e.to} ${e.item}`;
  const setA = new Map(ra.edges.map((e) => [key(e), e]));
  const setB = new Map(rb.edges.map((e) => [key(e), e]));
  const strip = (e: { from: string; to: string; item: string }) => ({
    from: e.from,
    to: e.to,
    item: e.item,
  });
  return {
    a: { id: a.id, name: a.name, version: a.version, serializable: ra.serializable },
    b: { id: b.id, name: b.name, version: b.version, serializable: rb.serializable },
    edgesOnlyInA: ra.edges.filter((e) => !setB.has(key(e))).map(strip),
    edgesOnlyInB: rb.edges.filter((e) => !setA.has(key(e))).map(strip),
    sharedEdges: ra.edges.filter((e) => setB.has(key(e))).map(strip),
    verdictChanged: ra.serializable !== rb.serializable,
  };
}
