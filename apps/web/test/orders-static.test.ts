// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * 平移完整性检查。
 *
 * 销售订单模块是从 Sales-order 仓库逐字拷进来的静态代码，没有构建步骤，
 * 也就没有任何环节会发现「少拷了一个文件」或「路径前缀没改对」——
 * 这类问题只会在线上以白屏的形式暴露。这里补最低限度的一道门禁。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORDERS_DIR = path.resolve(HERE, '../public/orders');
const read = (f: string) => fs.readFileSync(path.join(ORDERS_DIR, f), 'utf8');

describe('销售订单模块平移完整性', () => {
  it('五个入口文件与图标都在', () => {
    for (const f of ['index.html', 'app.css', 'app.js', 'sw.js', 'manifest.webmanifest']) {
      expect(fs.existsSync(path.join(ORDERS_DIR, f)), f).toBe(true);
    }
    for (const f of ['icons/icon-192.png', 'icons/icon-512.png']) {
      expect(fs.existsSync(path.join(ORDERS_DIR, f)), f).toBe(true);
    }
  });

  it('全部用相对路径 —— 绝对路径会指到 /writer/ 或站点根，嵌进 /dashboard/orders/ 后必裂', () => {
    const offenders: string[] = [];
    for (const f of ['index.html', 'app.js', 'sw.js', 'manifest.webmanifest']) {
      const src = read(f);
      // href="/x" src="/x" register('/x') start_url: "/x" 这类根绝对路径
      const hits = [...src.matchAll(/(?:href|src)="\//g), ...src.matchAll(/register\('\//g)];
      if (hits.length) offenders.push(`${f}: ${hits.map((h) => h[0]).join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('app.js 能被解析（语法门禁 —— 少个括号就是一整页白屏）', () => {
    expect(() => new Function(read('app.js'))).not.toThrow();
  });

  it('manifest 与 SW 的清单指向的文件都存在', () => {
    const manifest = JSON.parse(read('manifest.webmanifest'));
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    for (const icon of manifest.icons) {
      expect(fs.existsSync(path.join(ORDERS_DIR, icon.src)), icon.src).toBe(true);
    }
    const shell = [...read('sw.js').matchAll(/'\.\/([\w./-]+)'/g)].map((m) => m[1]);
    expect(shell.length).toBeGreaterThan(0);
    for (const f of shell) {
      expect(fs.existsSync(path.join(ORDERS_DIR, f)), f).toBe(true);
    }
  });
});

describe('非安全上下文下的登录回落（http://IP 部署时 crypto.subtle 不存在）', () => {
  it('纯 JS SHA-256 与 Node crypto 逐字节一致', () => {
    const src = read('app.js');
    const body = src.match(/function sha256Sync[\s\S]*?\n}\n/);
    expect(body, '找不到 sha256Sync').not.toBeNull();
    // eslint-disable-next-line no-new-func
    const sha256Sync = new Function(`${body[0]}; return sha256Sync;`)();

    const salt = src.match(/const PASSWORD_SALT = '([^']+)'/)?.[1];
    const stored = src.match(/const PASSWORD_HASH = '([^']+)'/)?.[1];
    expect(salt && stored, 'PASSWORD_SALT / PASSWORD_HASH 应该还在').toBeTruthy();

    const cases = ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), '中文密码123', 'x'.repeat(1000)];
    for (const c of cases) {
      const bytes = new TextEncoder().encode(c);
      const mine = Buffer.from(sha256Sync(bytes)).toString('base64');
      const ref = crypto.createHash('sha256').update(c, 'utf8').digest('base64');
      expect(mine, `长度 ${c.length}`).toBe(ref);
    }

    // 真实登录路径的形态：salt + 明文 → base64，必须能对上仓库里那个哈希的形状
    const probe = Buffer.from(sha256Sync(new TextEncoder().encode(salt + 'probe'))).toString('base64');
    expect(probe).toBe(crypto.createHash('sha256').update(salt + 'probe', 'utf8').digest('base64'));
    expect(stored).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });
});
