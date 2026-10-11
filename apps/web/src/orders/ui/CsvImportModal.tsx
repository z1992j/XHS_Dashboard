import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import Modal from '../Modal';
import { parseCSV, buildCSV, buildImportPlan } from '../csv';
import type { ImportPlan } from '../csv';
import type { Order } from '../types';
import { todayStr } from '../date';
import { toast } from '../toast';
import { appConfirm } from '../confirm';

export interface CsvImportModalProps {
  /** 当前口径下的订单，给「导出 CSV」用 */
  exportRows: Order[];
  /** 全库订单：导入判重要查全库（含隐藏的非本人归属记录） */
  allOrders: Order[];
  onClose: () => void;
  importCsv: (rows: ImportPlan['rows']) => Promise<{ ok: number; skipped: number }>;
}

/** 预览最多 5 行 —— 跟旧版一致，多了滚不过来也没人看 */
const PREVIEW_MAX = 5;

/**
 * CSV 批量导入：选择文件 / 粘贴文本 → parseCSV → buildImportPlan → 预览。
 * 解析失败在 .orders-csv-error 里给出错误行，而不是 toast 一闪而过。
 */
export default function CsvImportModal({ exportRows, allOrders, onClose, importCsv }: CsvImportModalProps) {
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [error, setError] = useState('');
  const [paste, setPaste] = useState('');
  const [fileName, setFileName] = useState('');
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const runPlan = (text: string) => {
    setError('');
    try {
      const p = buildImportPlan(parseCSV(text.replace(/^\uFEFF/, '')), allOrders);
      if ('error' in p && p.error) {
        setPlan(null);
        setError(p.error);
        return;
      }
      setPlan(p);
    } catch (e) {
      setPlan(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => runPlan(String(reader.result || ''));
    reader.onerror = () => toast('读取文件失败，请重试', { type: 'error' });
    reader.readAsText(file, 'utf-8');
  };

  // 导出走 buildCSV + Blob，含 \uFEFF BOM：Excel 打开才不会把中文读成乱码
  const exportCsv = () => {
    const csv = buildCSV(exportRows);
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `销售订单_${todayStr()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const confirmImport = async () => {
    if (!plan || plan.rows.length === 0 || importing) return;
    const ok = await appConfirm(`确认导入 ${plan.rows.length} 条订单？重复判定依据：手机号 + 办理日期。`);
    if (!ok) return;
    setImporting(true);
    const res = await importCsv(plan.rows);
    setImporting(false);
    toast(`导入完成：成功 ${res.ok} 条` + (res.skipped ? `，跳过重复 ${res.skipped} 条` : ''), {
      type: 'success',
    });
    onClose();
  };

  const canImport = Boolean(plan && plan.rows.length > 0) && !importing;

  return (
    <Modal title="CSV 批量导入" onClose={onClose}>
      <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={handleFile} />
      <div className="orders-csv-actions">
        <button type="button" className="orders-btn orders-btn-ghost" onClick={() => fileRef.current?.click()}>
          选择文件
        </button>
        {fileName && <span className="orders-csv-filename">{fileName}</span>}
        <button type="button" className="orders-btn orders-btn-ghost" onClick={exportCsv}>
          导出 CSV（当前口径）
        </button>
      </div>

      <textarea
        className="orders-paste-area"
        style={{ minHeight: 110 }}
        value={paste}
        placeholder="或直接粘贴 CSV 文本（首行为表头）"
        onChange={(e) => setPaste(e.target.value)}
      />
      <div className="orders-csv-actions">
        <button type="button" className="orders-btn orders-btn-ghost" onClick={() => runPlan(paste)} disabled={!paste.trim()}>
          解析文本
        </button>
      </div>

      {error && <div className="orders-csv-error" role="alert">{error}</div>}

      {plan && (
        <>
          <p className="orders-csv-info">
            将导入 <strong>{plan.rows.length}</strong> 条
            {plan.skipped > 0 && <>，跳过 {plan.skipped} 条重复</>}
            {plan.invalid > 0 && <>，{plan.invalid} 行无效</>}
            {plan.unmapped.length > 0 && <>；未映射列：{plan.unmapped.join('、')}</>}
          </p>
          {plan.rows.length > 0 ? (
            <div className="orders-batch-scroll">
              <table className="orders-csv-preview-table">
                <thead>
                  <tr>
                    <th>姓名</th><th>手机号</th><th>办理日期</th><th>运营商</th><th>套餐</th><th>佣金</th><th>销售员</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.preview.slice(0, PREVIEW_MAX).map((row, i) => (
                    <tr key={i}>
                      {row.map((c, k) => <td key={k}>{String(c)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
              {plan.rows.length > PREVIEW_MAX && (
                <p className="orders-csv-more">… 还有 {plan.rows.length - PREVIEW_MAX} 条未显示</p>
              )}
            </div>
          ) : (
            <p className="orders-csv-none">没有可导入的新记录。</p>
          )}
          <p className="orders-csv-remark">重复判定依据：手机号 + 办理日期</p>
        </>
      )}

      <div className="orders-modal-actions">
        <button type="button" className="orders-btn orders-btn-cancel" onClick={onClose}>取消</button>
        <button type="button" className="orders-btn orders-btn-primary" onClick={confirmImport} disabled={!canImport}>
          {importing ? '导入中…' : '确认导入'}
        </button>
      </div>
    </Modal>
  );
}
