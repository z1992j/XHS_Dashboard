/**
 * SHA-256 双路径（WebCrypto / 纯 JS 兜底）差分测试。
 *
 * 门禁理由：K 表手抄错一个常数、填充算错一位、UTF-8 编码漏掉代理对，
 * 结果都是「看着像摘要但全错」—— 线上表现为密码永远验不过。
 * 这里拿 Node 的官方实现当真值，覆盖填充分组的全部边界与多字节字符；
 * 两条 JS 路径还必须互相同意，否则换台设备就「对的密码进不去」。
 */
import { describe, it, expect } from 'vitest';
import {
  sha256b64Fallback, sha256b64, verifyPagePassword,
} from '../src/orders/sha256';
import { PASSWORD_SALT, PASSWORD_HASH } from '../src/orders/config';

// 仓库没装 @types/node（约束：不加依赖），node:crypto 运行时是有的，
// 这里给一个最小类型声明 —— 只为差分测试服务，不进 src。
// @ts-expect-error 运行时存在的内置模块，类型缺失是仓库没装 @types/node
const { createHash } = await import('node:crypto') as {
  createHash: (algo: string) => {
    update: (data: string, encoding: string) => { digest: (encoding: string) => string };
    digest: (encoding: string) => string;
  };
};

/** Node 真值：SHA-256(str) 的十六进制摘要，utf8 编码与浏览器 TextEncoder 对齐。 */
const nodeHex = (str: string): string =>
  (createHash('sha256').update(str, 'utf8').digest('hex') as string);

/** 自己的 base64 → 十六进制（走 WebCrypto），方便与 Node 真值对齐比较。 */
const b64ToHex = (b64: string): string => {
  const bin = atob(b64);
  let hex = '';
  for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
  return hex;
};

/** 同一输入重复 N 次拼成长串（填充分组边界用例的构造器）。 */
const repeat = (s: string, n: number): string => Array.from({ length: n }, () => s).join('');

describe('sha256Bytes 差分（Node crypto 当真值）', () => {
  const cases: Array<[string, string]> = [
    ['空串', ''],
    ['短串', 'abc'],
    ['占位', 'x'.repeat(54)],
    ['55 字节（填充后恰满一组）', 'x'.repeat(55)],
    ['56 字节（长度字段溢出到下一组）', 'x'.repeat(56)],
    ['63 字节', 'x'.repeat(63)],
    ['64 字节（整数组）', 'x'.repeat(64)],
    ['65 字节（整数组 + 1）', 'x'.repeat(65)],
    ['1000 字节（多组级联）', 'y'.repeat(1000)],
    ['CJK（utf8 三字节）', '密码闸门测试'],
    ['CJK + emoji（代理对 → 4 字节）', '密码🔒测试'],
    ['混合', 'salt-前缀 & 中文 123 —— mix'],
  ];

  for (const [name, input] of cases) {
    it(name + '（' + new TextEncoder().encode(input).length + ' 字节）', () => {
      const got = b64ToHex(sha256b64Fallback(input));
      expect(got).toBe(nodeHex(input));
    });
  }
});

describe('sha256b64Fallback 与 sha256b64（WebCrypto 路径）一致', () => {
  const inputs = ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), '中文密码', repeat('长', 500)];

  for (const input of inputs) {
    it(JSON.stringify(input.slice(0, 8)) + (input.length > 8 ? `…（${input.length} 字符）` : ''), async () => {
      expect(await sha256b64(input)).toBe(sha256b64Fallback(input));
      expect(b64ToHex(await sha256b64(input))).toBe(nodeHex(input));
    });
  }

  it('crypto.subtle 在 jsdom 里可用（确保 WebCrypto 路径真的被走到）', () => {
    expect(typeof crypto.subtle?.digest).toBe('function');
  });
});

describe('verifyPagePassword', () => {
  it('正确密码过闸（用 test1234 的哈希当期望值）', async () => {
    // node tools/hash-password.js test1234 的产物，仅作为测试期望，明文不进源码
    const test1234Hash = 'yc79tGOd2fkc2nZr+/7/gSKu+rumMxBsPnAv+oKWmro=';
    expect(await verifyPagePassword('test1234', PASSWORD_SALT, test1234Hash)).toBe(true);
  });

  it('错误密码、空密码、大小写敏感都拦下', async () => {
    const test1234Hash = 'yc79tGOd2fkc2nZr+/7/gSKu+rumMxBsPnAv+oKWmro=';
    expect(await verifyPagePassword('test12345', PASSWORD_SALT, test1234Hash)).toBe(false);
    expect(await verifyPagePassword('TEST1234', PASSWORD_SALT, test1234Hash)).toBe(false);
    expect(await verifyPagePassword('', PASSWORD_SALT, test1234Hash)).toBe(false);
  });

  it('盐不一致时拦下（换盐必须同步改两边）', async () => {
    const test1234Hash = 'yc79tGOd2fkc2nZr+/7/gSKu+rumMxBsPnAv+oKWmro=';
    expect(await verifyPagePassword('test1234', '别的盐', test1234Hash)).toBe(false);
  });
});

describe('config 默认值自洽', () => {
  // 不验证「默认哈希对应哪个明文」（那等于把密码写进仓库），
  // 只验证它是一个合法的 base64 SHA-256 摘要形状 —— 防 typo。
  it('PASSWORD_HASH 是 32 字节摘要的 base64', () => {
    expect(PASSWORD_HASH).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(b64ToHex(PASSWORD_HASH)).toMatch(/^[0-9a-f]{64}$/);
  });
});
