/**
 * 智能录入的文本解析：销售在群里发的自由文本 → 结构化订单。
 * 语义逐条照抄旧版 app.js（约 1486~1672 行），包括几处「看起来像 bug 的旧行为」。
 */
import type { Order } from './types';
import { todayStr } from './date';
import { extractProvinceFromContext, CITY_PROVINCE_MAP } from './cityData';

/** 地级市 → 省份对照，处理不了的一律留给用户手填。 */
export { extractProvinceFromContext, CITY_PROVINCE_MAP };

/** 城市别名映射（含旧版漏掉的直辖县级行政区），给导入/解析兜底。 */
export const CITY_ALIAS: Record<string, string> = {
  '无锡市': '无锡',
};

/**
 * 从地址文本识别城市与省份。
 * 三段式：标准「XX市」→ 开头市名 → 对照表反查；都落空返回两个空串。
 */
export function extractCityFromAddress(addr: string): { city: string; province: string } {
  if (!addr) return { city: '', province: '' };
  const t = addr.replace(/\s+/g, '');
  const cityMatch = t.match(/(?:^|省|自治区)(.{2,3}(?:市|自治州|地区|盟))/);
  if (cityMatch) {
    const city = cityMatch[1].replace(/市$/, '');
    if (CITY_PROVINCE_MAP[city]) return { city, province: CITY_PROVINCE_MAP[city] };
    const aliasCity = CITY_ALIAS[cityMatch[1]];
    if (aliasCity) return { city: aliasCity, province: CITY_PROVINCE_MAP[aliasCity] };
  }
  const simpleMatch = t.match(/^(.{2,3}?)[市]/);
  if (simpleMatch) {
    const city = simpleMatch[1];
    if (CITY_PROVINCE_MAP[city]) return { city, province: CITY_PROVINCE_MAP[city] };
    const aliasCity = CITY_ALIAS[city + '市'];
    if (aliasCity) return { city: aliasCity, province: CITY_PROVINCE_MAP[aliasCity] };
  }
  for (const [c, p] of Object.entries(CITY_PROVINCE_MAP)) {
    if (t.includes(c)) return { city: c, province: p };
  }
  return { city: '', province: '' };
}

/**
 * 标签解析：真实模板里标签后面经常带括号备注、全角空格，或者干脆没有冒号，
 * 例如「办理地址（具体到房号） ：」。逐个写死正则维护不过来，统一用这个 helper。
 *
 * 注意括号备注只吃掉紧跟标签之后的那一个；「客户姓名：张三（备注）」的
 * 备注会留在值里 —— 这是旧行为，别"修正"。
 */
export function fieldValue(text: string, labels: string[]): string {
  const label = '(?:' + labels.join('|') + ')';
  const note = '\\s*(?:[（(][^）)]{0,30}[）)])?\\s*'; // 可选的括号备注
  // 优先按冒号切分；没有冒号时退回用空白分隔
  for (const sep of ['[：:]\\s*', '\\s+']) {
    const m = text.match(new RegExp(label + note + sep + '([^\\n]+)'));
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
}

const CN_DIGITS: Record<string, number> = {
  '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
};
const CN_NUM_CHARS = '0-9一二两三四五六七八九十';

/** 「一年」「两年」「十二个月」这类中文数字，销售发来的原文里很常见。 */
export function cnNumber(s: string): number {
  const t = (s || '').trim();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const m = t.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN_DIGITS[m[1]] : 1) * 10 + (m[2] ? CN_DIGITS[m[2]] : 0);
  if (t.length === 1 && CN_DIGITS[t]) return CN_DIGITS[t];
  return 0;
}

export interface ParsedOrder {
  /** 单条解析结果可直接交给 openForm 当新增 seed：字段名与 Order 对齐 */
  name: string;
  phone: string;
  idCard: string;
  address: string;
  province: string;
  city: string;
  carrier: string;
  package: string;
  duration: string;
  packageFee: number;
  installFee: number;
  commission: number;
  /** 智能录入按「今天办理」入库；单条回填表单时直接用 */
  applyDate: string;
}

/** 默认值：群发模板没写全时先给最常见的档位，用户核对后改。 */
const SMART_DEFAULTS = {
  carrier: '联通',
  package: '300m',
  duration: '1年',
} as const;

export function parseOrderText(text: string): ParsedOrder {
  const result: ParsedOrder = {
    name: '', phone: '', idCard: '', address: '',
    carrier: SMART_DEFAULTS.carrier, package: SMART_DEFAULTS.package, duration: SMART_DEFAULTS.duration,
    packageFee: 0, installFee: 0, commission: 0,
    province: '', city: '',
    applyDate: todayStr(),
  };

  // 姓名后面可能跟着别的内容，只取第一段
  const nameRaw = fieldValue(text, ['客户姓名', '姓\\s*名', '客户']);
  if (nameRaw) result.name = nameRaw.split(/[,，、\s]/)[0].trim();

  // 号码可能写成 173-6530-6527 或带空格，先取标签值再抽数字；
  // 标签没匹配上时退回全文找一个手机号
  const phoneRaw = fieldValue(text, ['联系方式', '联系电话', '手机号码', '手机号', '手机', '电话']);
  const phoneHit = phoneRaw.replace(/[\s\-]/g, '').match(/1[3-9]\d{9}/) ||
                   text.replace(/[\s\-]/g, '').match(/1[3-9]\d{9}/);
  if (phoneHit) result.phone = phoneHit[0];

  const idRaw = fieldValue(text, ['身份证号码', '身份证号', '身份证', '证件号码', '证件号', '证件']);
  const idHit = idRaw.match(/\d{17}[\dXx]/) || text.match(/\d{17}[\dXx]/);
  if (idHit) result.idCard = idHit[0].toUpperCase();

  const addr = fieldValue(text, ['办理地址', '安装地址', '装机地址', '详细地址', '收货地址', '地址']);
  if (addr) {
    result.address = addr;
    const loc = extractCityFromAddress(addr);
    result.city = loc.city;
    result.province = loc.province;
  }
  if (!result.province) result.province = extractProvinceFromContext(text);
  // 地址里带了省份但城市不在对照表中时，至少把省份留下
  if (!result.province && result.address) {
    result.province = extractProvinceFromContext(result.address);
  }

  const pkg = fieldValue(text, ['办理套餐', '宽带套餐', '套餐内容', '套餐']);
  if (pkg) {
    const carrierMatch = pkg.match(/(联通|移动|电信|广电)/);
    if (carrierMatch) result.carrier = carrierMatch[1];

    // 带宽写法：1000M / 1000m / 1000兆 / 千兆
    if (/千兆/.test(pkg)) {
      result.package = '1000M';
    } else {
      const speedMatch = pkg.match(/(\d+)\s*(?:兆|[Mm][Bb]?)/);
      if (speedMatch) result.package = speedMatch[1] + 'M';
    }

    const feeMatch = pkg.match(/(\d+(?:\.\d+)?)\s*元/);
    if (feeMatch) result.packageFee = Math.round(parseFloat(feeMatch[1]));

    // 时限：支持「一年」「两年」「18个月」「半年」
    if (/半年/.test(pkg)) {
      result.duration = '6个月';
    } else {
      const yr = pkg.match(new RegExp('([' + CN_NUM_CHARS + ']+)\\s*年'));
      const mo = pkg.match(new RegExp('([' + CN_NUM_CHARS + ']+)\\s*个?月'));
      if (yr && cnNumber(yr[1])) result.duration = cnNumber(yr[1]) + '年';
      else if (mo && cnNumber(mo[1])) result.duration = cnNumber(mo[1]) + '个月';
    }

    // 「包安装」「免安装费」= 不另收安装费
    if (/包安装|免安装|送安装/.test(pkg)) result.installFee = 0;
  }

  const carrierLine = text.match(/运营商[：:\s]*(联通|移动|电信|广电)/);
  if (carrierLine) result.carrier = carrierLine[1];

  const installFee = text.match(/安装费[：:\s]*(\d+)/);
  if (installFee) result.installFee = parseInt(installFee[1], 10);

  const comMatch = text.match(/佣金[：:\s]*(\d+)/);
  if (comMatch) result.commission = parseInt(comMatch[1], 10);

  return result;
}

// 客资常常是群里一次发好几条。每条以「姓名」标签开头就按它切；
// 第一个「姓名」之前的文字（如「新增以下广西宽带」）当作抬头，拼到每一条前面
const NAME_LINE = /^\s*(?:客户姓名|姓\s*名|客户)\s*(?:[（(][^）)]{0,30}[）)])?\s*[：:\s]/;

export function splitOrderText(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const starts = lines.map((l, i) => (NAME_LINE.test(l) ? i : -1)).filter((i) => i >= 0);
  if (starts.length >= 2) {
    const header = lines.slice(0, starts[0]).join('\n').trim();
    return starts.map((s, k) => {
      const body = lines.slice(s, k + 1 < starts.length ? starts[k + 1] : lines.length).join('\n').trim();
      return header ? header + '\n' + body : body;
    });
  }
  // 没有「姓名」可切时，退而按空行切，前提是每一段各有一个手机号
  // —— 否则宁可当成一条，也不乱切。
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length >= 2 && blocks.every((b) => /1[3-9]\d{9}/.test(b.replace(/[\s-]/g, '')))) {
    return blocks;
  }
  return [text];
}

/**
 * 与单条保存用同一套校验：错误挡住保存，提醒只是提示。
 * 第三个参数是全库订单（判重要查全库，含隐藏的非本人归属记录）。
 */
export function checkParsed(
  p: ParsedOrder,
  seenPhones: Set<string>,
  allOrders: Order[] = [],
): { errors: string[]; warns: string[] } {
  const errors: string[] = [];
  const warns: string[] = [];
  if (!p.name) errors.push('缺姓名');
  if (!p.phone) errors.push('缺手机号');
  else if (!/^1[3-9]\d{9}$/.test(p.phone)) errors.push('手机号格式不对');
  if (!p.packageFee) errors.push('缺套餐费');
  if (p.idCard && !/^\d{17}[\dX]$/.test(p.idCard)) errors.push('身份证号格式不对');
  if (p.phone && allOrders.some((o) => o.phone === p.phone)) warns.push('手机号已存在');
  if (p.phone && seenPhones.has(p.phone)) warns.push('本批重复');
  if (p.phone) seenPhones.add(p.phone);
  return { errors, warns };
}
