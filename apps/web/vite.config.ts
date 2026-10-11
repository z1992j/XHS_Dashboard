/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 相对 base + HashRouter = 一份 dist 可以放到任何静态路径下直接跑
  // （/workbench/、/dashboard/ 都行），换路径不需要重新构建。
  // 改成绝对路径会把部署绑死在一个子目录上，CI 里有检查卡住这一点。
  base: './',
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        // 默认仍指向本地后端；要把 dev server 直接打到线上 API，
        // 用 VITE_API_PROXY_TARGET=http://47.252.19.222 npx vite 启动。
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['test/**/*.test.{ts,tsx}'],
    css: false,
  },
});
