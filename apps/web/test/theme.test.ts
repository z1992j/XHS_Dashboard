import { describe, it, expect, beforeEach } from 'vitest';
import { bootstrapTheme } from '../src/lib/theme';

// jsdom 环境下 matchMedia 需要手写 stub（vitest 默认不含）
function mockMatchMedia(matchesDark: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: matchesDark && query.includes('dark'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe('bootstrapTheme — 应用启动前主题引导', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('存储为 dark 时挂 .dark class', () => {
    mockMatchMedia(false);
    localStorage.setItem('xhs_theme', 'dark');
    bootstrapTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('存储为 light 时不挂 .dark class', () => {
    mockMatchMedia(true); // 即使系统深色，用户明确浅色应覆盖
    localStorage.setItem('xhs_theme', 'light');
    bootstrapTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('system + 系统深色 → 挂 .dark class', () => {
    mockMatchMedia(true);
    localStorage.setItem('xhs_theme', 'system');
    bootstrapTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('system + 系统浅色 → 不挂 .dark class', () => {
    mockMatchMedia(false);
    localStorage.setItem('xhs_theme', 'system');
    bootstrapTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('无存储值默认为 system', () => {
    mockMatchMedia(true);
    bootstrapTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
