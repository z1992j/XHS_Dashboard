/**
 * 订单测试夹具：mkOrder 生成带自增 id 的完整 Order。
 * 自增 id 保证不同用例的数据互不干扰（React key / Map 聚合都不会撞）。
 */
import type { Order } from '../src/orders/types';

let seq = 1;

export function mkOrder(over: Partial<Order> = {}): Order {
  const id = over.id ?? seq++;
  if (over.id === undefined) seq++;
  else seq = Math.max(seq, over.id + 1);
  return {
    id,
    name: '张三',
    phone: '17365306527',
    idCard: '',
    address: '广东省广州市天河区某街道1号',
    province: '广东',
    city: '广州',
    carrier: '联通',
    package: '300m',
    duration: '1年',
    installFee: 0,
    packageFee: 600,
    commission: 300,
    commissionRate: 0.5,
    applyDate: '2026-09-01',
    paybackDate: '',
    salesPerson: '大卫',
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}
