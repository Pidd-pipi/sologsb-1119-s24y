import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import AddIcon from '@mui/icons-material/Add';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import { useSupplyStore } from '../stores/supplyStore';
import { useSpecimenStore } from '../stores/specimenStore';
import { MeasureField } from '../components/common/MeasureField';
import {
  SUPPLY_KINDS,
  inspectLotGate,
  issueBlockReason,
  formatDate,
  parseDate,
  isLowStock,
  shelfLifeLeftDays,
  type InspectionVerdict,
  type LotGateState,
  type SupplyKind,
  type SupplyLot,
  type SupplyLotDraft,
} from '../types/supply';

const EMPTY_DRAFT: SupplyLotDraft = {
  name: '',
  kind: '胶种',
  spec: '',
  lotNo: '',
  qty: 1,
  unit: '瓶',
  openedAt: Date.now(),
  shelfLifeMonths: 24,
  lowThreshold: 2,
};

/** 放行状态 → 标签配色 */
const GATE_CHIP: Record<LotGateState, { label: string; color: 'success' | 'warning' | 'error' | 'default' }> = {
  released: { label: '已放行', color: 'success' },
  pending: { label: '待检', color: 'warning' },
  rejected: { label: '不合格', color: 'error' },
  expired: { label: '复检过期', color: 'error' },
};

function defaultValidUntil(dateValue: string): string {
  const base = parseDate(dateValue);
  const ts = Number.isFinite(base) ? base : Date.now();
  // 复检有效期默认 6 个月（按 30 天/月，与保质期口径一致）
  return formatDate(ts + 180 * 24 * 3600 * 1000);
}

/** /supplies 工具材料台账：按种类分组、批号追溯、低量行高亮、复检放行后领用 */
export default function SupplyList() {
  const lots = useSupplyStore((s) => s.items);
  const addLot = useSupplyStore((s) => s.add);
  const issue = useSupplyStore((s) => s.issue);
  const registerInspection = useSupplyStore((s) => s.registerInspection);
  const specimens = useSpecimenStore((s) => s.items);

  const [trace, setTrace] = useState('');
  const [kindFilter, setKindFilter] = useState<SupplyKind | 'all'>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<SupplyLotDraft>(EMPTY_DRAFT);
  const [issueTarget, setIssueTarget] = useState<SupplyLot | null>(null);
  const [issueQty, setIssueQty] = useState(1);
  const [issueOperator, setIssueOperator] = useState('');
  const [issueSpecimen, setIssueSpecimen] = useState('');
  const [inspectTarget, setInspectTarget] = useState<SupplyLot | null>(null);
  const [inspectInspector, setInspectInspector] = useState('');
  const [inspectVerdict, setInspectVerdict] = useState<InspectionVerdict>('合格');
  const [inspectDate, setInspectDate] = useState(formatDate(Date.now()));
  const [inspectValidUntil, setInspectValidUntil] = useState(defaultValidUntil(formatDate(Date.now())));
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  const filtered = useMemo(() => {
    const kw = trace.trim();
    return lots.filter((lot) => {
      if (kindFilter !== 'all' && lot.kind !== kindFilter) return false;
      if (kw && !lot.lotNo.includes(kw) && !lot.name.includes(kw) && !lot.spec.includes(kw)) return false;
      return true;
    });
  }, [lots, trace, kindFilter]);

  const grouped = useMemo(() => {
    return SUPPLY_KINDS.map((kind) => ({ kind, rows: filtered.filter((lot) => lot.kind === kind) })).filter(
      (g) => kindFilter === 'all' || g.kind === kindFilter,
    );
  }, [filtered, kindFilter]);

  const submitLot = async () => {
    if (!draft.name.trim() || !draft.lotNo.trim()) {
      setError('名称与批号必填');
      return;
    }
    await addLot({ ...draft, name: draft.name.trim(), lotNo: draft.lotNo.trim() });
    setCreateOpen(false);
    setDraft(EMPTY_DRAFT);
    setError('');
    setToast('已登记材料批次，新批次需复检合格放行后才能领用');
  };

  const submitIssue = async () => {
    if (!issueTarget) return;
    if (issueQty <= 0 || issueQty > issueTarget.qty) {
      setError(`领用数量需在 1 ~ ${issueTarget.qty} ${issueTarget.unit} 之间`);
      return;
    }
    if (!issueOperator.trim()) {
      setError('领用人必填');
      return;
    }
    try {
      await issue(issueTarget.id, {
        qty: issueQty,
        operator: issueOperator.trim(),
        specimenNo: issueSpecimen || '未关联标本',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '领用被拦截');
      return;
    }
    setIssueTarget(null);
    setIssueQty(1);
    setIssueOperator('');
    setIssueSpecimen('');
    setError('');
    setToast('领用已登记');
  };

  const openInspection = (lot: SupplyLot) => {
    setInspectTarget(lot);
    setInspectInspector('');
    setInspectVerdict('合格');
    const today = formatDate(Date.now());
    setInspectDate(today);
    setInspectValidUntil(defaultValidUntil(today));
    setError('');
  };

  const submitInspection = async () => {
    if (!inspectTarget) return;
    if (!inspectInspector.trim()) {
      setError('复检人必填');
      return;
    }
    const inspectedAt = parseDate(inspectDate);
    const validUntil = parseDate(inspectValidUntil);
    if (!Number.isFinite(inspectedAt) || !Number.isFinite(validUntil)) {
      setError('请填写复检日期与有效期');
      return;
    }
    if (validUntil < inspectedAt) {
      setError('复检有效期不能早于复检日期');
      return;
    }
    await registerInspection(inspectTarget.id, {
      inspector: inspectInspector.trim(),
      verdict: inspectVerdict,
      inspectedAt,
      validUntil,
    });
    setInspectTarget(null);
    setError('');
    setToast(inspectVerdict === '合格' ? '复检合格，批次已放行可领用' : '复检不合格已登记，该批次已被拦下');
  };

  const lowCount = lots.filter(isLowStock).length;
  const pendingCount = lots.filter((lot) => inspectLotGate(lot).state === 'pending').length;
  const blockedCount = lots.filter((lot) => issueBlockReason(lot) !== null).length;

  // 领用对话框展示的批次可能已因最新复检结论变化而被拦下，需实时判定
  const issueGate = issueTarget ? inspectLotGate(issueTarget) : null;
  const issueBlocked = issueTarget ? issueBlockReason(issueTarget) : null;

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
        <Typography variant="h5" fontWeight={700}>
          工具材料台账
        </Typography>
        <Chip size="small" label={`共 ${lots.length} 个批次`} />
        <Chip size="small" color={lowCount > 0 ? 'warning' : 'default'} label={`低量 ${lowCount} 项`} />
        <Chip size="small" color={pendingCount > 0 ? 'warning' : 'default'} label={`待检 ${pendingCount} 项`} />
        <Chip size="small" color={blockedCount > 0 ? 'error' : 'default'} label={`禁止领用 ${blockedCount} 项`} />
        <Box sx={{ flex: 1 }} />
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => { setCreateOpen(true); setError(''); }}>
          登记批次
        </Button>
      </Stack>

      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} useFlexGap>
          <TextField
            size="small"
            label="批号 / 名称追溯"
            value={trace}
            onChange={(e) => setTrace(e.target.value)}
            sx={{ minWidth: 240 }}
            helperText="输入批号片段可定位该批次的全部领用记录"
          />
          <TextField
            select
            size="small"
            label="种类"
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as SupplyKind | 'all')}
            sx={{ minWidth: 140 }}
          >
            <MenuItem value="all">全部</MenuItem>
            {SUPPLY_KINDS.map((k) => (
              <MenuItem key={k} value={k}>
                {k}
              </MenuItem>
            ))}
          </TextField>
          <Button onClick={() => { setTrace(''); setKindFilter('all'); }}>重置</Button>
        </Stack>
      </Paper>

      {grouped.map((group) => (
        <Paper key={group.kind} variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
            <Typography variant="subtitle1" fontWeight={700}>
              {group.kind}
            </Typography>
            <Chip size="small" label={`${group.rows.length} 个批次`} />
          </Stack>
          {group.rows.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              该种类下暂无批次。
            </Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>名称</TableCell>
                  <TableCell>规格</TableCell>
                  <TableCell>批号</TableCell>
                  <TableCell align="right">在库</TableCell>
                  <TableCell align="right">低量阈值</TableCell>
                  <TableCell align="right">剩余保质期</TableCell>
                  <TableCell>复检放行</TableCell>
                  <TableCell>最近领用</TableCell>
                  <TableCell align="right">操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {group.rows.map((lot) => {
                  const low = isLowStock(lot);
                  const left = shelfLifeLeftDays(lot);
                  const gate = inspectLotGate(lot);
                  const chip = GATE_CHIP[gate.state];
                  const blockReason = issueBlockReason(lot);
                  const gateTip =
                    gate.state === 'released'
                      ? gate.latest
                        ? `${gate.latest.inspector} 复检合格，有效期至 ${formatDate(gate.latest.validUntil)}`
                        : ''
                      : blockReason ?? '';
                  return (
                    <TableRow
                      key={lot.id}
                      hover
                      data-testid={`supply-row-${lot.lotNo}`}
                      sx={low ? { bgcolor: 'warning.light' } : undefined}
                    >
                      <TableCell>
                        {lot.name}
                        {low ? <Chip size="small" color="warning" label="低量" sx={{ ml: 1 }} /> : null}
                      </TableCell>
                      <TableCell>{lot.spec}</TableCell>
                      <TableCell>{lot.lotNo}</TableCell>
                      <TableCell align="right">
                        {lot.qty} {lot.unit}
                      </TableCell>
                      <TableCell align="right">{lot.lowThreshold}</TableCell>
                      <TableCell align="right">
                        {left < 0 ? <Chip size="small" color="error" label={`已过期 ${-left} 天`} /> : `${left} 天`}
                      </TableCell>
                      <TableCell>
                        <Tooltip title={gateTip} placement="top" arrow disableFocusListener={!gateTip} disableHoverListener={!gateTip} disableTouchListener={!gateTip}>
                          <Chip
                            size="small"
                            color={chip.color}
                            label={
                              gate.state === 'released' && gate.latest
                                ? `${chip.label} · 至 ${formatDate(gate.latest.validUntil)}`
                                : chip.label
                            }
                            data-testid={`gate-chip-${lot.lotNo}`}
                          />
                        </Tooltip>
                      </TableCell>
                      <TableCell>
                        {lot.issues.length === 0
                          ? '—'
                          : `${lot.issues[0].operator} 领 ${lot.issues[0].qty} ${lot.unit}（${lot.issues[0].specimenNo}）`}
                      </TableCell>
                      <TableCell align="right">
                        <Stack direction="row" spacing={1} justifyContent="flex-end">
                          <Button
                            size="small"
                            startIcon={<FactCheckIcon />}
                            onClick={() => openInspection(lot)}
                            data-testid={`inspect-btn-${lot.lotNo}`}
                          >
                            复检登记
                          </Button>
                          <Tooltip title={blockReason ?? '可领用'} placement="top" arrow>
                            <span>
                              <Button
                                size="small"
                                variant="outlined"
                                disabled={blockReason !== null}
                                onClick={() => {
                                  setIssueTarget(lot);
                                  setIssueQty(1);
                                  setIssueOperator('');
                                  setIssueSpecimen('');
                                  setError('');
                                }}
                                data-testid={`issue-btn-${lot.lotNo}`}
                              >
                                领用
                              </Button>
                            </span>
                          </Tooltip>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {group.rows.some((r) => r.issues.length > 1) ? (
            <Stack spacing={0.5} sx={{ mt: 1 }}>
              {group.rows
                .filter((r) => r.issues.length > 1)
                .map((r) => (
                  <Typography key={r.id} variant="caption" color="text.secondary">
                    批号 {r.lotNo} 的领用明细：
                    {r.issues.map((i) => `${i.operator} ${i.qty}${r.unit}→${i.specimenNo}`).join('；')}
                  </Typography>
                ))}
            </Stack>
          ) : null}
          {group.rows.some((r) => r.inspections?.length > 0) ? (
            <Stack spacing={0.5} sx={{ mt: 1 }}>
              {group.rows
                .filter((r) => r.inspections?.length > 0)
                .map((r) => (
                  <Typography key={r.id} variant="caption" color="text.secondary" data-testid={`inspection-history-${r.lotNo}`}>
                    批号 {r.lotNo} 的复检记录：
                    {r.inspections.map(
                      (c) =>
                        `${formatDate(c.inspectedAt)} ${c.inspector} 判定${c.verdict}（有效期至 ${formatDate(c.validUntil)}）`,
                    ).join('；')}
                  </Typography>
                ))}
            </Stack>
          ) : null}
        </Paper>
      ))}

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>登记材料批次</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            {error ? <Alert severity="error">{error}</Alert> : null}
            <Alert severity="info">新批次登记后为「待检」状态，需在复检登记中记录复检人、结论与有效期，合格放行后方可领用。</Alert>
            <TextField
              size="small"
              label="名称"
              required
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <Stack direction="row" spacing={1.5}>
              <TextField
                select
                size="small"
                fullWidth
                label="种类"
                value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value as SupplyKind })}
              >
                {SUPPLY_KINDS.map((k) => (
                  <MenuItem key={k} value={k}>
                    {k}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                size="small"
                fullWidth
                label="规格"
                value={draft.spec}
                onChange={(e) => setDraft({ ...draft, spec: e.target.value })}
              />
            </Stack>
            <Stack direction="row" spacing={1.5}>
              <TextField
                size="small"
                fullWidth
                label="批号"
                required
                value={draft.lotNo}
                onChange={(e) => setDraft({ ...draft, lotNo: e.target.value })}
              />
              <TextField
                size="small"
                fullWidth
                label="单位"
                value={draft.unit}
                onChange={(e) => setDraft({ ...draft, unit: e.target.value })}
              />
            </Stack>
            <Stack direction="row" spacing={1.5}>
              <Box sx={{ flex: 1 }}>
                <MeasureField
                  label="在库数量"
                  unit={draft.unit}
                  min={0}
                  max={100000}
                  step={1}
                  value={draft.qty}
                  onChange={(v) => setDraft({ ...draft, qty: v })}
                />
              </Box>
              <Box sx={{ flex: 1 }}>
                <MeasureField
                  label="低量阈值"
                  unit={draft.unit}
                  min={0}
                  max={1000}
                  step={1}
                  value={draft.lowThreshold}
                  onChange={(v) => setDraft({ ...draft, lowThreshold: v })}
                />
              </Box>
              <Box sx={{ flex: 1 }}>
                <MeasureField
                  label="保质期"
                  unit="月"
                  min={1}
                  max={240}
                  step={1}
                  value={draft.shelfLifeMonths}
                  onChange={(v) => setDraft({ ...draft, shelfLifeMonths: v })}
                />
              </Box>
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>取消</Button>
          <Button variant="contained" onClick={submitLot}>
            保存
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!inspectTarget} onClose={() => setInspectTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>
          复检放行登记{inspectTarget ? ` · ${inspectTarget.name}` : ''}
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            {error ? <Alert severity="error">{error}</Alert> : null}
            {inspectTarget ? (
              <Typography variant="body2" color="text.secondary">
                批号 {inspectTarget.lotNo} · 当前状态：{GATE_CHIP[inspectLotGate(inspectTarget).state].label}
              </Typography>
            ) : null}
            {inspectTarget?.inspections?.[0] ? (
              <Alert severity="info">
                上次复检：{formatDate(inspectTarget.inspections[0].inspectedAt)} {inspectTarget.inspections[0].inspector}{' '}
                判定{inspectTarget.inspections[0].verdict}，有效期至 {formatDate(inspectTarget.inspections[0].validUntil)}。
                本次登记将覆盖放行状态。
              </Alert>
            ) : null}
            <TextField
              size="small"
              label="复检人"
              required
              value={inspectInspector}
              onChange={(e) => setInspectInspector(e.target.value)}
              inputProps={{ 'data-testid': 'inspection-inspector' }}
            />
            <TextField
              select
              size="small"
              label="复检结论"
              required
              value={inspectVerdict}
              onChange={(e) => setInspectVerdict(e.target.value as InspectionVerdict)}
              inputProps={{ 'data-testid': 'inspection-verdict' }}
            >
              <MenuItem value="合格">合格（放行）</MenuItem>
              <MenuItem value="不合格">不合格（拦下，禁止领用）</MenuItem>
            </TextField>
            <TextField
              size="small"
              label="复检日期"
              type="date"
              required
              value={inspectDate}
              onChange={(e) => {
                setInspectDate(e.target.value);
                setInspectValidUntil(defaultValidUntil(e.target.value));
              }}
              InputLabelProps={{ shrink: true }}
              inputProps={{ 'data-testid': 'inspection-date' }}
            />
            <TextField
              size="small"
              label="复检有效期至"
              type="date"
              required
              value={inspectValidUntil}
              onChange={(e) => setInspectValidUntil(e.target.value)}
              InputLabelProps={{ shrink: true }}
              helperText="合格批次在该日期前可领用；到期后按复检过期拦下，需重新复检"
              inputProps={{ 'data-testid': 'inspection-valid-until' }}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setInspectTarget(null)}>取消</Button>
          <Button variant="contained" onClick={submitInspection} data-testid="inspection-submit">
            保存复检结论
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!issueTarget} onClose={() => setIssueTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>
          领用登记{issueTarget ? ` · ${issueTarget.name}` : ''}
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            {error ? <Alert severity="error">{error}</Alert> : null}
            {issueTarget && issueGate ? (
              <>
                <Typography variant="body2" color="text.secondary">
                  批号 {issueTarget.lotNo} · 现存 {issueTarget.qty} {issueTarget.unit}
                </Typography>
                {issueBlocked ? (
                  <Alert severity="error" data-testid="issue-blocked-alert">
                    {issueBlocked}
                  </Alert>
                ) : (
                  <Alert severity="success">
                    已复检放行：{issueGate.latest?.inspector} 于 {issueGate.latest ? formatDate(issueGate.latest.inspectedAt) : ''}{' '}
                    判定合格，有效期至 {issueGate.latest ? formatDate(issueGate.latest.validUntil) : ''}
                  </Alert>
                )}
              </>
            ) : null}
            <MeasureField
              label="领用数量"
              unit={issueTarget?.unit ?? '件'}
              min={1}
              max={issueTarget?.qty ?? 1}
              step={1}
              value={issueQty}
              onChange={setIssueQty}
              disabled={issueBlocked !== null}
            />
            <TextField
              size="small"
              label="领用人"
              required
              disabled={issueBlocked !== null}
              value={issueOperator}
              onChange={(e) => setIssueOperator(e.target.value)}
            />
            <TextField
              select
              size="small"
              label="用于标本"
              value={issueSpecimen}
              disabled={issueBlocked !== null}
              onChange={(e) => setIssueSpecimen(e.target.value)}
            >
              <MenuItem value="">未关联标本</MenuItem>
              {specimens.map((s) => (
                <MenuItem key={s.id} value={s.specimenNo}>
                  {s.specimenNo}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIssueTarget(null)}>取消</Button>
          <Button variant="contained" disabled={issueBlocked !== null} onClick={submitIssue}>
            确认领用
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!toast} autoHideDuration={2400} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}
