import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

interface LoginOverlayProps {
  needsPassword: boolean;
  error?: string;
  submitting?: boolean;
  onSubmit: (password: string, remember: boolean) => Promise<boolean>;
}

/**
 * 页面密码闸门：照抄旧版 loginOverlay 的结构（密码 + 记住我 + 错误行）。
 * 提交走 useOrders().login；提交中禁用按钮并显示「验证中…」防重复提交，
 * 成功（onSubmit 返回 true）后清空输入框。
 */
export default function LoginOverlay({ needsPassword, error, submitting = false, onSubmit }: LoginOverlayProps) {
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  // 弹出闸门时自动聚焦；失败后也把焦点放回去，方便直接重输
  useEffect(() => {
    if (needsPassword) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 50);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [needsPassword]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const pwd = password.trim();
    if (!pwd) return;
    const ok = await onSubmit(pwd, remember);
    if (ok) setPassword('');
  };

  if (!needsPassword) return null;

  return (
    <div className="orders-login-overlay">
      <form className="orders-login-card" onSubmit={handleSubmit}>
        <h2>销售订单登记</h2>
        <p className="sub">请输入访问密码</p>
        <label htmlFor="orders-login-password">密码</label>
        <input
          ref={inputRef}
          id="orders-login-password"
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          placeholder="••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <label className="orders-login-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          在本设备保持登录
        </label>
        <button type="submit" className="orders-btn orders-btn-primary" disabled={submitting || !password.trim()}>
          {submitting ? '验证中…' : '进入系统'}
        </button>
        <div className="orders-login-err" role="alert">{error || ''}</div>
        <p className="orders-login-hint">
          密码与数据库账号共用；数据保存在服务端，浏览器只保留登录令牌。
        </p>
      </form>
    </div>
  );
}
