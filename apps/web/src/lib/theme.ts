import { useEffect, useState, useCallback } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'xhs_theme';

function readStored(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

function applyTheme(mode: ThemeMode) {
  if (typeof document === 'undefined') return;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = mode === 'dark' || (mode === 'system' && prefersDark);
  document.documentElement.classList.toggle('dark', isDark);
}

/**
 * 双主题控制 hook。返回当前 mode、切换函数与实际生效主题。
 * - mode: 'light' | 'dark' | 'system'
 * - resolved: 实际渲染的主题（system 已解析）
 */
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => readStored());

  useEffect(() => {
    applyTheme(mode);
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  const toggle = useCallback(() => {
    setMode((prev) => {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const currentIsDark = prev === 'dark' || (prev === 'system' && prefersDark);
      return currentIsDark ? 'light' : 'dark';
    });
  }, []);

  const resolved: 'light' | 'dark' =
    mode === 'dark'
      ? 'dark'
      : mode === 'light'
        ? 'light'
        : typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';

  return { mode, setMode, toggle, resolved };
}

/** 在应用启动前尽早应用主题，避免闪烁。可在 main.tsx 顶层调用一次。 */
export function bootstrapTheme() {
  applyTheme(readStored());
}
