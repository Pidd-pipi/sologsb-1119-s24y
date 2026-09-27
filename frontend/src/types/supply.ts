/** 工具材料种类 */
export type SupplyKind = '工具' | '磨料' | '胶种' | '耗材';

export const SUPPLY_KINDS: SupplyKind[] = ['工具', '磨料', '胶种', '耗材'];

/** 复检结论：合格放行 / 不合格拦截 */
export type InspectionConclusion = 'pass' | 'fail';

/** 开封后的复检放行登记 */
export interface SupplyInspection {
  id: string;
  /** 复检人 */
  inspector: string;
  /** 复检结论 */
  conclusion: InspectionConclusion;
  /** 复检日期 */
  inspectedAt: number;
  /** 放行有效期截止日（当日 24:00 前有效）；不合格时为空 */
  validUntil?: number;
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
  /** 复检放行记录，最新一条在数组首位；为空表示尚未复检（待检） */
  inspections: SupplyInspection[];
  /** 领用记录（只追加，历史记录不因复检结论变化而删除） */
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

/** 取最近一次复检登记（无记录返回 null，即待检） */
export function latestInspection(lot: SupplyLot): SupplyInspection | null {
  return lot.inspections && lot.inspections.length > 0 ? lot.inspections[0] : null;
}

/** 放行闸门状态 */
export type LotGateStatus = 'released' | 'pending' | 'rejected' | 'expired';

export interface LotGate {
  ok: boolean;
  status: LotGateStatus;
  /** 拦截原因（ok 时为空） */
  reason: string;
  /** 状态短标签 */
  label: string;
  latest: SupplyInspection | null;
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * 材料出库放行判定：
 * - 无复检记录（含档案升级后的旧批次、新登记批次）→ 待检，拦截；
 * - 最近一次复检不合格 → 拦截，重新放行前不可领用；
 * - 复检放行已过有效期 → 按复检过期拦截；
 * - 保质期已过 → 拦截。
 * 已存在的领用记录不受影响，只决定后续能否继续领用。
 */
export function evaluateLotGate(lot: SupplyLot, now = Date.now()): LotGate {
  const latest = latestInspection(lot);
  if (!latest) {
    return {
      ok: false,
      status: 'pending',
      reason: '该批次开封后尚未复检，须登记复检人、结论与有效期后方可领用',
      label: '待检',
      latest: null,
    };
  }
  if (latest.conclusion === 'fail') {
    return {
      ok: false,
      status: 'rejected',
      reason: `最近一次复检结论为不合格（复检人：${latest.inspector}），已停止领用，须重新复检合格放行后恢复`,
      label: '复检不合格',
      latest,
    };
  }
  const validUntil = latest.validUntil ?? 0;
  if (validUntil <= now) {
    return {
      ok: false,
      status: 'expired',
      reason: '复检放行有效期已过，须重新复检合格后方可领用',
      label: '复检已过期',
      latest,
    };
  }
  const shelfLeft = shelfLifeLeftDays(lot, now);
  if (shelfLeft < 0) {
    return {
      ok: false,
      status: 'expired',
      reason: `保质期已过期 ${-shelfLeft} 天，不得领用`,
      label: '已过期',
      latest,
    };
  }
  return { ok: true, status: 'released', reason: '', label: '复检放行', latest };
}

/** 日期字符串（YYYY-MM-DD）转当日 0 点时间戳 */
export function dateInputToTime(value: string): number {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getTime();
}

/** 时间戳转 YYYY-MM-DD（本地时区），供日期输入框回显 */
export function timeToDateInput(ts: number): string {
  const dt = new Date(ts);
  const m = `${dt.getMonth() + 1}`.padStart(2, '0');
  const d = `${dt.getDate()}`.padStart(2, '0');
  return `${dt.getFullYear()}-${m}-${d}`;
}

/** 某日期加上若干月后，那天所在月的月末 24:00（次月 1 日 0 点），作为放行有效期截止 */
export function addMonthsEndOfDay(baseTs: number, months: number): number {
  const base = new Date(baseTs);
  const target = new Date(base.getFullYear(), base.getMonth() + months, 1);
  return new Date(target.getFullYear(), target.getMonth() + 1, 1, 0, 0, 0, 0).getTime();
}

/** 有效期截止时间戳的显示日期（YYYY-MM-DD） */
export function formatValidUntil(ts: number): string {
  return timeToDateInput(ts - DAY_MS);
}
