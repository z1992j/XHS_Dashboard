import { useState, useEffect, useCallback } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { AUTH_REQUIRED_EVENT, setToken, validateToken } from '../lib/api';

/**
 * 只有当后端开启了鉴权（设置了 API_TOKEN）并且本机没有有效令牌时，
 * 这个弹窗才会出现 —— 由 api.ts 在收到 401 时派发事件唤起。
 *
 * 之所以不用「收到 401 就 reload」：后端开了鉴权而浏览器没有令牌时，
 * 那样会无限刷新。
 */
export default function TokenGate() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onAuthRequired = () => { setOpen(true); setError(''); };
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
  }, []);

  const submit = useCallback(async () => {
    const token = value.trim();
    if (!token || checking) return;
    setChecking(true);
    setError('');
    try {
      if (await validateToken(token)) {
        setToken(token);
        setOpen(false);
        setValue('');
        window.location.reload();
      } else {
        setError('令牌无效，请向管理员确认后重试');
      }
    } catch {
      setError('无法连接服务器，请稍后重试');
    } finally {
      setChecking(false);
    }
  }, [value, checking]);

  if (!open) return null;

  return (
    <div className="token-gate-overlay" role="dialog" aria-modal="true" aria-labelledby="token-gate-title">
      <div className="token-gate-card">
        <div className="flex items-center gap-2.5 mb-1">
          <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: 'var(--primary-light)' }}>
            <KeyRound size={16} style={{ color: 'var(--primary)' }} />
          </div>
          <h2 id="token-gate-title" className="text-base font-bold" style={{ color: 'var(--text)' }}>
            需要访问令牌
          </h2>
        </div>
        <p className="text-xs mb-3" style={{ color: 'var(--text-3)' }}>
          服务端已开启鉴权。填入令牌后即可继续使用，浏览器会记住它。
        </p>
        <input
          type="password"
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="粘贴访问令牌"
          className="w-full px-3 py-2.5 rounded-xl text-sm input-glow"
          style={{ border: '1px solid var(--border)', background: 'var(--bg)' }}
        />
        {error && (
          <p className="text-xs mt-2" style={{ color: 'var(--danger)' }}>{error}</p>
        )}
        <button
          onClick={submit}
          disabled={!value.trim() || checking}
          className="btn-primary w-full flex items-center justify-center gap-2 h-10 rounded-xl text-sm mt-3"
        >
          {checking && <Loader2 size={15} className="animate-spin" />}
          {checking ? '校验中' : '确定'}
        </button>
      </div>
    </div>
  );
}
