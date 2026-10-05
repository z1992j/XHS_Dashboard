/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 工作台部署在独立目录，与原来的 /writer/ 分开，两套前端可以并存灰度。
  base: '/dashboard/',
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
