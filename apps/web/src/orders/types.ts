/**
 * 销售订单模块的共享类型。
 *
 * 字段以 Sales-order 旧版 app.js 的 toRow()/fromRow() 为准（Supabase 表 orders /
 * order_logs）：前端 camelCase，落库 snake_case，只在 client 层做一次映射。
 */

export interface Order {
  id: number;
  /** 客户姓名 */
  name: string;
  /** 手机号，入库前已剥掉空格/横线等分隔符 */
  phone: string;
  idCard: string;
  address: string;
  province: string;
  city: string;
  /** 运营商：联通 / 移动 / 电信 / 广电 */
  carrier: string;
  /** 带宽档位，如 300m / 1000m */
  package: string;
  /** 合约期文案，如 1年 / 2年 / 18个月 */
  duration: string;
  /** 安装费（元） */
  installFee: number;
  /** 套餐费（元） */
  packageFee: number;
  /** 佣金（元） */
  commission: number;
  /** 结佣比例，0~1 的小数；导出 CSV 时写成 "30%" */
  commissionRate: number;
  /** 办理日期 YYYY-MM-DD，本地时区语义 */
  applyDate: string;
  /** 结佣/回款日期，未结佣为空串 */
  paybackDate: string;
  salesPerson: string;
  createdAt: string;
  updatedAt: string;
}

/** 表里存的是 snake_case；写入时不含 id / created_at / updated_at。 */
export type OrderRow = Record<string, unknown>;

export interface OrderLog {
  id: number;
  orderId: number;
  /** create / update / delete / import */
  action: string;
  operator: string;
  field: string;
  oldValue: string;
  newValue: string;
  createdAt: string;
}

export type SortKey =
  | 'applyDate'
  | 'packageFee'
  | 'commission'
  | 'commissionRate'
  | 'name'
  | 'city'
  | 'payback';

export type ViewScope = 'mine' | 'all';

/**
 * 结佣筛选：paid=已有回款日期，unpaid=未结佣，
 * over30/over60 是「未结佣且账龄 ≥ 30/60 天」的进一步收窄。
 */
export type PaybackFilter = '' | 'paid' | 'unpaid' | 'over30' | 'over60';

export interface Filters {
  q: string;
  province: string;
  city: string;
  carrier: string;
  pkg: string;
  month: string;
  payback: PaybackFilter;
  view: ViewScope;
  sort: SortKey;
  desc: boolean;
}

export const EMPTY_FILTERS: Filters = {
  q: '',
  province: '',
  city: '',
  carrier: '',
  pkg: '',
  month: '',
  payback: '',
  view: 'mine',
  sort: 'applyDate',
  desc: true,
};

export interface Session {
  token: string;
  refresh: string;
  /** 毫秒时间戳 */
  expiresAt: number;
}

export type BootstrapState = 'loading' | 'ready' | 'needs-password' | 'error';

/**
 * 弹窗状态用可辨识联合表达：同一时刻只可能开一个，
 * 避免多个 boolean 组合出「同时开着编辑框和详情」这类非法态。
 */
export type OrdersModal =
  | null
  | { kind: 'form'; editingId: number | null; seed: Partial<Order> }
  | { kind: 'detail'; order: Order }
  | { kind: 'csv' }
  | { kind: 'logs'; order: Order }
  | { kind: 'smart' };

/** loadOrders() 的返回：总数被接口截断时 truncatedTotal 非 0，供 UI 明示。 */
export interface LoadResult {
  rows: Order[];
  truncatedTotal: number;
  /**
   * true 表示读不到服务端总数、且条数已达 COUNT_SUSPICIOUS_AT，
   * 无法证明数据取全了 —— 这种「查不了」也要说出来。
   */
  countUnverified: boolean;
  /** true 表示网络失败、用的是 localStorage 缓存 */
  usingCache: boolean;
  cachedAt: number;
}
