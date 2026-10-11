/**
 * CSV 导出与导入。导出端逐字照抄旧版 exportCSV（约 1475 行）；
 * 导入端照抄 buildImportPlan（约 2138 行），并加上「可导入行数 / 拒收原因 /
 * 未映射列名」这些 UI 需要的计数。列按表头别名匹配，列顺序变化、多余列、
 * 缺列都不会导致数据错位。
 */
import type { Order, OrderRow } from './types';

/** 导出端固定 16 列，顺序与旧版逐字一致：改列就会破坏老用户的导回。 */
const CSV_HEADER =
  '序号,办理日期,结佣日期,姓名,手机号,省份,城市,运营商,套餐,时限,安装费,套餐费,佣金,佣金率,身份证号,地址';

const cell = (v: unknown): string => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';

/**
 * 导出当前口径的订单。前置 \uFEFF 由下载端负责（Blob 里拼），
 * 佣金率写成整数百分比，Excel 里直接能看。
 */
export function buildCSV(list: Order[]): string {
  const rows = list
    .map((o, i) =>
      [
        i + 1, o.applyDate, o.paybackDate, o.name, o.phone, o.province, o.city,
        o.carrier, o.package, o.duration, o.installFee, o.packageFee, o.commission,
        Math.round((Number(o.commissionRate) || 0) * 100) + '%', o.idCard, o.address,
      ].map(cell).join(','))
    .join('\n');
  return CSV_HEADER + (rows ? '\n' + rows : '');
}

/**
 * 手写解析，支持引号包裹、引号内换行、"" 转义、CRLF；空行（全列空白）跳过。
 * BOM 在调用方剥（与 UI 的 text.replace(/^\uFEFF/, '') 分工一致）。
 */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      row.push(cur); cur = '';
    } else if (c === '\n') {
      row.push(cur); rows.push(row); row = []; cur = '';
    } else if (c !== '\r') {
      cur += c;
    }
  }
  row.push(cur);
  rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * 导入日期兼容多种写法：2026/9/1、2026-9-1、2026.9.1、带时分秒、8 位数字。
 * 只认月日 1~2 位的宽松格式；认不出返回 ''（导入时留空，之后人工补）。
 */
export function normalizeDate(s: string): string {
  const v = (s || '').trim();
  if (!v) return '';
  let m = v.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  return '';
}

/**
 * 佣金率归一到 0~1 的小数：'30'/'30%' → 0.3，'0.3' → 0.3。
 * 大于等于 1 视为百分数，小于 1 视为小数；非法值一律 0。
 */
export function normalizeRate(s: string): number {
  const v = String(s == null ? '' : s).replace('%', '').trim();
  if (!v) return 0;
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return 0;
  return n >= 1 ? Math.round(n) / 100 : Math.round(n * 10000) / 10000;
}

/** 表头别名 → 内部字段。旧表头「回款日期/回款」保留兼容。 */
export const CSV_HEADER_ALIASES: Record<string, string> = {
  '办理日期': 'applyDate', '下单日期': 'applyDate', '日期': 'applyDate',
  '结佣日期': 'paybackDate', '结佣': 'paybackDate',
  '回款日期': 'paybackDate', '回款': 'paybackDate', // 旧表头，保留兼容
  '姓名': 'name', '客户': 'name', '客户姓名': 'name',
  '手机号': 'phone', '手机': 'phone', '电话': 'phone', '联系方式': 'phone',
  '省份': 'province', '省': 'province',
  '城市': 'city', '市': 'city',
  '运营商': 'carrier',
  '套餐': 'package', '套餐名称': 'package',
  '时限': 'duration', '期限': 'duration',
  '安装费': 'installFee',
  '套餐费': 'packageFee', '金额': 'packageFee',
  '佣金': 'commission',
  '佣金率': 'commissionRate',
  '身份证号': 'idCard', '身份证': 'idCard',
  '地址': 'address', '办理地址': 'address', '安装地址': 'address',
  '销售员': 'salesPerson', '业务员': 'salesPerson',
};

export interface ImportPlan {
  /** 可导入的行（不含 id / created_at / updated_at，直接可 POST） */
  rows: OrderRow[];
  /** 手机号 + 办理日期与库里（或本文件前文）重复而被跳过的行数 */
  skipped: number;
  /** 缺姓名或手机号被拒的行数 */
  invalid: number;
  /** 表头里没映射到任何字段的列名 */
  unmapped: string[];
  /** 预览行：姓名/手机号/办理日期/运营商/套餐/佣金/销售员（UI 直接展示） */
  preview: unknown[][];
  /** 表头缺「姓名」「手机号」等致命问题时给出原因 */
  error?: string;
}

/**
 * 把解析好的 CSV 表格转成待导入计划。
 * 第二个参数是全库订单：判重要查全库（含隐藏的非本人归属记录），
 * 只查当前视图的话隐藏记录会被重复导入。
 */
export function buildImportPlan(table: string[][], existingOrders: Order[]): ImportPlan {
  if (table.length < 2) {
    return {
      rows: [], preview: [], skipped: 0, invalid: 0, unmapped: [],
      error: 'CSV 文件为空或没有数据行',
    };
  }

  const header = table[0].map((h) => h.trim());
  const fieldOf = header.map((h) => CSV_HEADER_ALIASES[h] || '');
  if (!fieldOf.includes('name') || !fieldOf.includes('phone')) {
    return {
      rows: [], preview: [], skipped: 0, invalid: 0, unmapped: [],
      error: '未能识别表头：CSV 必须包含「姓名」和「手机号」两列。\n可先用「导出 CSV」得到标准模板再填写。',
    };
  }

  const existingKeys = new Set(
    existingOrders
      .filter((o) => o.phone && o.applyDate)
      .map((o) => o.phone + '|' + o.applyDate),
  );
  const rows: OrderRow[] = [];
  const preview: unknown[][] = [];
  let skipped = 0;
  let invalid = 0;

  for (const cells of table.slice(1)) {
    const rec: Record<string, string> = {};
    fieldOf.forEach((f, i) => { if (f) rec[f] = (cells[i] || '').trim(); });
    // 手机号先剥分隔符再只留数字：粘进来常带空格/横线
    const phone = (rec.phone || '').replace(/\D/g, '');
    if (!rec.name || !phone) { invalid++; continue; }
    const applyDate = normalizeDate(rec.applyDate);
    // 同手机号不同办理日期是两笔业务，按 手机号+日期 判重而不是只按手机号
    const key = phone + '|' + (applyDate || '');
    if (applyDate && existingKeys.has(key)) { skipped++; continue; }
    if (applyDate) existingKeys.add(key);

    const salesPerson = rec.salesPerson || '';
    rows.push({
      apply_date: applyDate,
      payback_date: normalizeDate(rec.paybackDate),
      name: rec.name,
      phone,
      province: rec.province || '',
      city: rec.city || '',
      carrier: rec.carrier || '',
      package: rec.package || '',
      duration: rec.duration || '',
      install_fee: Number(rec.installFee) || 0,
      package_fee: Number(rec.packageFee) || 0,
      commission: Number(rec.commission) || 0,
      commission_rate: normalizeRate(rec.commissionRate),
      id_card: (rec.idCard || '').toUpperCase(),
      address: rec.address || '',
      sales_person: salesPerson,
    });
    if (preview.length < 5) {
      preview.push([rec.name, phone, applyDate || '—', rec.carrier || '—',
        rec.package || '—', rec.commission || '0', salesPerson]);
    }
  }

  return {
    rows,
    preview,
    skipped,
    invalid,
    // 表头里有、但别名表不认识（如导出文件的「序号」）的列名，报告给 UI
    unmapped: header.filter((_, i) => !fieldOf[i]),
  };
}
