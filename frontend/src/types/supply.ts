/** 工具材料种类 */
export type SupplyKind = '工具' | '磨料' | '胶种' | '耗材';

export const SUPPLY_KINDS: SupplyKind[] = ['工具', '磨料', '胶种', '耗材'];

/** 复检结论 */
export type InspectionVerdict = '合格' | '不合格';

/** 复检（开封后复检放行）记录 */
export interface SupplyInspection {
  id: string;
  /** 复检人 */
  inspector: string;
  /** 复检结论 */
  verdict: InspectionVerdict;
  /** 复检时间 */
  inspectedAt: number;
  /** 复检有效期至（结论合格时的放行截止时间） */
  validUntil: number;
}

/** 工具材料批次 */
export interface SupplyLot {
  id: string;
  name: string;
  kind: SupplyKind;
  /** 规格 */
  spec: string;
  /** 批号 */
  lotNo: string;
  /** 在库数量 */
  qty: number;
  unit: string;
  /** 开封时间 */
  openedAt: number;
  /** 保质期（月） */
  shelfLifeMonths: number;
  /** 低量阈值 */
  lowThreshold: number;
  /** 复检记录，最新一次在数组首位；无记录视为待检 */
  inspections: SupplyInspection[];
  /** 最近一次领用记录 */
  issues: SupplyIssue[];
}

/** 领用登记 */
export interface SupplyIssue {
  id: string;
  qty: number;
  operator: string;
  specimenNo: string;
  issuedAt: number;
}

export type SupplyLotDraft = Omit<SupplyLot, 'id' | 'issues' | 'inspections'>;

/** 是否低量 */
export function isLowStock(lot: SupplyLot): boolean {
  return lot.qty <= lot.lowThreshold;
}

/** 剩余保质期天数（负数表示已过期） */
export function shelfLifeLeftDays(lot: SupplyLot, now = Date.now()): number {
  const expireAt = lot.openedAt + lot.shelfLifeMonths * 30 * 24 * 3600 * 1000;
  return Math.floor((expireAt - now) / (24 * 3600 * 1000));
}

/** 复检放行状态：以最近一次复检结论为准 */
export type LotGateState = 'released' | 'pending' | 'rejected' | 'expired';

export interface LotGate {
  state: LotGateState;
  /** 不可领用的原因；放行时为 null */
  reason: string | null;
  /** 最近一次复检（可能不存在） */
  latest: SupplyInspection | null;
}

/**
 * 复检放行判定：
 * - 无复检记录 → 待检
 * - 最近一次复检不合格 → 不合格（复检合格后自动恢复放行）
 * - 最近一次复检合格但已过有效期 → 过期（有效期至当天仍算有效，次日起拦截）
 * - 最近一次复检合格且在有效期内 → 放行
 */
export function inspectLotGate(lot: SupplyLot, now = Date.now()): LotGate {
  const latest = lot.inspections?.[0] ?? null;
  if (!latest) {
    return { state: 'pending', reason: '该批次尚未复检，登记复检合格结论后方可领用', latest };
  }
  if (latest.verdict === '不合格') {
    return { state: 'rejected', reason: `最近一次复检（${formatDate(latest.inspectedAt)} ${latest.inspector}）结论为不合格，禁止领用`, latest };
  }
  // 有效期按日粒度比较：有效期至当天结束前均可领用
  const todayStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime();
  if (latest.validUntil < todayStart) {
    return { state: 'expired', reason: `复检放行已于 ${formatDate(latest.validUntil)} 到期，请重新复检合格后领用`, latest };
  }
  return { state: 'released', reason: null, latest };
}

/** 领用拦截原因（含库存校验）；可领用时返回 null */
export function issueBlockReason(lot: SupplyLot, now = Date.now()): string | null {
  const gate = inspectLotGate(lot, now);
  if (gate.reason) return gate.reason;
  if (lot.qty <= 0) return '库存为 0，无法领用';
  return null;
}

/** 格式化为 yyyy-mm-dd（本地时区，配合 <input type="date">） */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 解析 yyyy-mm-dd 为当日 0 点时间戳；非法输入返回 NaN */
export function parseDate(value: string): number {
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return NaN;
  return new Date(y, m - 1, d).getTime();
}
