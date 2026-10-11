/**
 * 应用内确认（替代旧版 window.confirm）。
 *
 * confirm.ts 只负责存「当前的确认实现」，ConfirmHost 挂载时把自己注入进来；
 * 这样非组件代码（OrderForm 的手机号判重、CsvImportModal 的导入确认）和
 * 测试（换成同步桩）都能用同一个入口。
 */

export interface ConfirmOptions {
  title?: string;
}

export type ConfirmFn = (message: string, opts?: ConfirmOptions) => Promise<boolean>;

/** 默认实现：没有 ConfirmHost 时降级为「取消」，宁可不做也不误删。 */
let impl: ConfirmFn = async () => false;

/** 测试或特殊场景换实现用；返回旧实现以便还原。 */
export function setConfirmImpl(fn: ConfirmFn): ConfirmFn {
  const old = impl;
  impl = fn;
  return old;
}

/** 暴露给 ConfirmHost 的注入点。 */
export function getConfirmImpl(): ConfirmFn {
  return impl;
}

/** 应用内确认：返回 Promise<boolean>，true = 确认。 */
export function appConfirm(message: string, opts?: ConfirmOptions): Promise<boolean> {
  return impl(message, opts);
}
