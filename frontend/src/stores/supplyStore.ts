import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { evaluateLotGate } from '../types/supply';
import type { InspectionConclusion, SupplyInspection, SupplyIssue, SupplyLot, SupplyLotDraft } from '../types/supply';

export interface RegisterInspectionInput {
  inspector: string;
  conclusion: InspectionConclusion;
  inspectedAt: number;
  /** 合格放行时必填：放行有效期截止时间戳 */
  validUntil?: number;
}

/** 领用被放行闸门拦截时抛出，message 即拦截原因 */
export class LotBlockedError extends Error {
  status: string;
  constructor(message: string, status: string) {
    super(message);
    this.name = 'LotBlockedError';
    this.status = status;
  }
}

interface SupplyState {
  items: SupplyLot[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: SupplyLotDraft) => Promise<SupplyLot>;
  issue: (id: string, payload: Omit<SupplyIssue, 'id' | 'issuedAt'>) => Promise<void>;
  registerInspection: (id: string, input: RegisterInspectionInput) => Promise<void>;
  trace: (lotNo: string) => SupplyLot[];
}

export const useSupplyStore = create<SupplyState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const items = await db.supplies.toArray();
    items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    set({ items, loaded: true });
  },
  async add(draft) {
    // 新批次先待检：复检合格登记前没有任何放行记录
    const record: SupplyLot = { ...draft, id: newId('sup'), inspections: [], issues: [] };
    await db.supplies.put(record);
    set({ items: [...get().items, record] });
    return record;
  },
  async issue(id, payload) {
    // 以数据库中的最新批次状态判定，复检结论变化后立即生效
    const target = await db.supplies.get(id);
    if (!target) return;
    const gate = evaluateLotGate(target);
    if (!gate.ok) {
      throw new LotBlockedError(gate.reason, gate.status);
    }
    if (payload.qty <= 0 || payload.qty > target.qty) {
      throw new Error(`领用数量需在 1 ~ ${target.qty} ${target.unit} 之间`);
    }
    const issue: SupplyIssue = { ...payload, id: newId('iss'), issuedAt: Date.now() };
    const next: SupplyLot = {
      ...target,
      qty: Math.max(0, target.qty - payload.qty),
      issues: [issue, ...target.issues],
    };
    await db.supplies.put(next);
    set({ items: get().items.map((it) => (it.id === id ? next : it)) });
  },
  async registerInspection(id, input) {
    const target = await db.supplies.get(id);
    if (!target) return;
    const record: SupplyInspection = {
      id: newId('insp'),
      inspector: input.inspector.trim(),
      conclusion: input.conclusion,
      inspectedAt: input.inspectedAt,
      validUntil: input.conclusion === 'pass' ? input.validUntil : undefined,
    };
    // 历史复检记录保留，最新一条置于首位；领用记录原样保留
    const next: SupplyLot = {
      ...target,
      inspections: [record, ...(target.inspections ?? [])],
    };
    await db.supplies.put(next);
    set({ items: get().items.map((it) => (it.id === id ? next : it)) });
  },
  trace(lotNo) {
    if (!lotNo) return get().items;
    return get().items.filter((it) => it.lotNo.includes(lotNo) || it.name.includes(lotNo));
  },
}));
