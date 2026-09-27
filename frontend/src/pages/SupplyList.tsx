import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
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
  addMonthsEndOfDay,
  dateInputToTime,
  evaluateLotGate,
  formatValidUntil,
  isLowStock,
  latestInspection,
  shelfLifeLeftDays,
  timeToDateInput,
  type InspectionConclusion,
  type LotGate,
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

const DAY_MS = 24 * 3600 * 1000;

/** 放行状态徽标 */
function GateChip({ gate }: { gate: LotGate }) {
  if (gate.status === 'released') {
    return <Chip size="small" color="success" variant="outlined" label="复检放行" data-testid="gate-chip-released" />;
  }
  if (gate.status === 'pending') {
    return <Chip size="small" color="warning" label="待检" data-testid="gate-chip-pending" />;
  }
  if (gate.status === 'rejected') {
    return <Chip size="small" color="error" label="复检不合格" data-testid="gate-chip-rejected" />;
  }
  return <Chip size="small" color="error" label={gate.label} data-testid="gate-chip-expired" />;
}

/** /supplies 工具材料台账：复检放行、按种类分组、批号追溯、低量行高亮 */
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
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  // 复检登记对话框
  const [inspectTarget, setInspectTarget] = useState<SupplyLot | null>(null);
  const [inspectInspector, setInspectInspector] = useState('');
  const [inspectConclusion, setInspectConclusion] = useState<InspectionConclusion>('pass');
  const [inspectDate, setInspectDate] = useState(timeToDateInput(Date.now()));
  const [inspectValidUntil, setInspectValidUntil] = useState(
    timeToDateInput(addMonthsEndOfDay(Date.now(), 6) - DAY_MS),
  );

  const gates = useMemo(() => {
    const map = new Map<string, LotGate>();
    lots.forEach((lot) => map.set(lot.id, evaluateLotGate(lot)));
    return map;
  }, [lots]);

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

  const blockedCount = lots.filter((lot) => !gates.get(lot.id)?.ok).length;
  const pendingCount = lots.filter((lot) => gates.get(lot.id)?.status === 'pending').length;

  const submitLot = async () => {
    if (!draft.name.trim() || !draft.lotNo.trim()) {
      setError('名称与批号必填');
      return;
    }
    await addLot({ ...draft, name: draft.name.trim(), lotNo: draft.lotNo.trim() });
    setCreateOpen(false);
    setDraft(EMPTY_DRAFT);
    setError('');
    setToast('已登记材料批次，新批次默认待检，复检合格后才能领用');
  };

  const submitIssue = async () => {
    if (!issueTarget) return;
    const gate = gates.get(issueTarget.id);
    if (gate && !gate.ok) {
      setError(gate.reason);
      return;
    }
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
      // 复检状态在打开对话框后发生变化（如被登记为不合格）时，以 store 的最新判定为准
      setError(e instanceof Error ? e.message : '该批次当前不可领用');
      return;
    }
    setIssueTarget(null);
    setIssueQty(1);
    setIssueOperator('');
    setIssueSpecimen('');
    setError('');
    setToast('领用已登记');
  };

  const openInspect = (lot: SupplyLot) => {
    setInspectTarget(lot);
    setInspectInspector(latestInspection(lot)?.inspector ?? '');
    setInspectConclusion('pass');
    setInspectDate(timeToDateInput(Date.now()));
    setInspectValidUntil(timeToDateInput(addMonthsEndOfDay(Date.now(), 6) - DAY_MS));
    setError('');
  };

  const submitInspection = async () => {
    if (!inspectTarget) return;
    if (!inspectInspector.trim()) {
      setError('复检人必填');
      return;
    }
    if (!inspectDate) {
      setError('复检日期必填');
      return;
    }
    const inspectedAt = dateInputToTime(inspectDate);
    let validUntil: number | undefined;
    if (inspectConclusion === 'pass') {
      if (!inspectValidUntil) {
        setError('放行结论必须填写复检有效期');
        return;
      }
      validUntil = dateInputToTime(inspectValidUntil) + DAY_MS;
      if (validUntil <= Date.now()) {
        setError('复检有效期不能早于今天，放行后须仍在有效期内');
        return;
      }
      if (validUntil <= inspectedAt) {
        setError('复检有效期须晚于复检日期');
        return;
      }
    }
    await registerInspection(inspectTarget.id, {
      inspector: inspectInspector,
      conclusion: inspectConclusion,
      inspectedAt,
      validUntil,
    });
    setInspectTarget(null);
    setError('');
    setToast(inspectConclusion === 'pass' ? '复检合格，批次已放行可领用' : '已登记复检不合格，该批次已停止领用');
  };

  const lowCount = lots.filter(isLowStock).length;
  const issueGate = issueTarget ? gates.get(issueTarget.id) ?? evaluateLotGate(issueTarget) : null;

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
        <Typography variant="h5" fontWeight={700}>
          工具材料台账
        </Typography>
        <Chip size="small" label={`共 ${lots.length} 个批次`} />
        <Chip size="small" color={lowCount > 0 ? 'warning' : 'default'} label={`低量 ${lowCount} 项`} />
        <Chip
          size="small"
          color={pendingCount > 0 ? 'warning' : 'default'}
          label={`待检 ${pendingCount} 项`}
          data-testid="pending-count"
        />
        <Chip
          size="small"
          color={blockedCount > 0 ? 'error' : 'success'}
          label={`不可领用 ${blockedCount} 项`}
          data-testid="blocked-count"
        />
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
                  const gate = gates.get(lot.id) ?? evaluateLotGate(lot);
                  const latest = gate.latest;
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
                      <TableCell data-testid={`gate-cell-${lot.lotNo}`}>
                        <Stack spacing={0.5}>
                          <GateChip gate={gate} />
                          {latest ? (
                            <Typography variant="caption" color="text.secondary" component="div">
                              复检人 {latest.inspector} · {timeToDateInput(latest.inspectedAt)}
                              {latest.conclusion === 'pass' && latest.validUntil
                                ? ` · 有效期至 ${formatValidUntil(latest.validUntil)}`
                                : null}
                            </Typography>
                          ) : (
                            <Typography variant="caption" color="warning.main" component="div">
                              开封后未复检
                            </Typography>
                          )}
                          {!gate.ok ? (
                            <Typography
                              variant="caption"
                              color="error.main"
                              component="div"
                              data-testid={`block-reason-${lot.lotNo}`}
                            >
                              {gate.reason}
                            </Typography>
                          ) : null}
                        </Stack>
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
                            onClick={() => openInspect(lot)}
                            data-testid={`inspect-btn-${lot.lotNo}`}
                          >
                            复检
                          </Button>
                          <Button
                            size="small"
                            variant={gate.ok ? 'outlined' : 'text'}
                            disabled={lot.qty <= 0 || !gate.ok}
                            title={gate.ok ? '' : gate.reason}
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
        </Paper>
      ))}

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>登记材料批次</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            {error ? <Alert severity="error">{error}</Alert> : null}
            <Alert severity="info">新批次登记后为「待检」状态，须在复检登记中填写复检人、结论与有效期，合格放行后才能领用。</Alert>
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

      <Dialog
        open={!!inspectTarget}
        onClose={() => setInspectTarget(null)}
        fullWidth
        maxWidth="sm"
        data-testid="inspect-dialog"
      >
        <DialogTitle>
          复检放行登记{inspectTarget ? ` · ${inspectTarget.name}（批号 ${inspectTarget.lotNo}）` : ''}
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            {error ? <Alert severity="error" data-testid="inspect-error">{error}</Alert> : null}
            {inspectTarget && latestInspection(inspectTarget) ? (
              <Alert severity="info" data-testid="inspect-history">
                最近一次复检：{latestInspection(inspectTarget)?.inspector} 于{' '}
                {timeToDateInput(latestInspection(inspectTarget)?.inspectedAt ?? Date.now())}
                {latestInspection(inspectTarget)?.conclusion === 'pass' ? ' 判定合格' : ' 判定不合格'}。
                本次登记将作为最新结论，历史记录与已领出记录均保留。
              </Alert>
            ) : (
              <Alert severity="warning">该批次开封后尚未复检，登记合格结论与有效期后即可放行领用。</Alert>
            )}
            <TextField
              size="small"
              label="复检人"
              required
              value={inspectInspector}
              onChange={(e) => setInspectInspector(e.target.value)}
              data-testid="inspect-inspector"
            />
            <TextField
              select
              size="small"
              label="复检结论"
              required
              value={inspectConclusion}
              onChange={(e) => setInspectConclusion(e.target.value as InspectionConclusion)}
              data-testid="inspect-conclusion"
            >
              <MenuItem value="pass">合格（放行领用）</MenuItem>
              <MenuItem value="fail">不合格（停止领用）</MenuItem>
            </TextField>
            <TextField
              size="small"
              type="date"
              fullWidth
              label="复检日期"
              required
              InputLabelProps={{ shrink: true }}
              value={inspectDate}
              onChange={(e) => setInspectDate(e.target.value)}
              data-testid="inspect-date"
            />
            <TextField
              size="small"
              type="date"
              fullWidth
              label="复检放行有效期至"
              required={inspectConclusion === 'pass'}
              disabled={inspectConclusion === 'fail'}
              InputLabelProps={{ shrink: true }}
              helperText={
                inspectConclusion === 'pass'
                  ? '有效期截止日（含当日），到期后批次自动按复检过期拦截'
                  : '不合格结论无需填写有效期；重新复检合格后可恢复领用'
              }
              value={inspectValidUntil}
              onChange={(e) => setInspectValidUntil(e.target.value)}
              data-testid="inspect-valid-until"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setInspectTarget(null)}>取消</Button>
          <Button variant="contained" onClick={submitInspection} data-testid="inspect-submit">
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
            {error ? <Alert severity="error" data-testid="issue-error">{error}</Alert> : null}
            {issueTarget && issueGate && !issueGate.ok ? (
              <Alert severity="error" data-testid="issue-blocked-alert">
                该批次不可领用：{issueGate.reason}
              </Alert>
            ) : null}
            {issueTarget && issueGate?.ok ? (
              <Alert severity="success" data-testid="issue-released-alert">
                复检合格放行（复检人 {issueGate.latest?.inspector}，有效期至{' '}
                {issueGate.latest?.validUntil ? formatValidUntil(issueGate.latest.validUntil) : '—'}）。
              </Alert>
            ) : null}
            {issueTarget ? (
              <Typography variant="body2" color="text.secondary">
                批号 {issueTarget.lotNo} · 现存 {issueTarget.qty} {issueTarget.unit}
              </Typography>
            ) : null}
            <MeasureField
              label="领用数量"
              unit={issueTarget?.unit ?? '件'}
              min={1}
              max={issueTarget?.qty ?? 1}
              step={1}
              value={issueQty}
              onChange={setIssueQty}
            />
            <TextField
              size="small"
              label="领用人"
              required
              value={issueOperator}
              onChange={(e) => setIssueOperator(e.target.value)}
            />
            <TextField
              select
              size="small"
              label="用于标本"
              value={issueSpecimen}
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
          <Button
            variant="contained"
            disabled={!issueGate?.ok}
            onClick={submitIssue}
            data-testid="issue-submit"
          >
            确认领用
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!toast} autoHideDuration={2400} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}
