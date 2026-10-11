/**
 * SHA-256（WebCrypto + 纯 JS 兜底）。
 *
 * 为什么要有兜底：页面门禁要算 base64(SHA-256(盐 + 密码))，而浏览器只在
 * secure context（https 或 localhost）暴露 crypto.subtle。线上是
 * http://<裸IP>/workbench/ 访问，crypto.subtle 直接是 undefined ——
 * 对这个部署来说，纯 JS 这条路不是备胎，而是主路径。
 *
 * 两条路径必须逐字节产出同样的摘要，否则换台设备就会「密码是对的但进不去」。
 * test/orders-sha256.test.ts 拿 Node crypto 做差分对照（含分组填充边界与中文）。
 */

/**
 * FIPS 180-4 表 1 的 64 个轮常量（前 64 个质数立方根分数部分的前 32 位）。
 *
 * 这张表是程序算出来、再拿 Node crypto 差分验证过的，不是手抄的：K[5] 常被
 * 误写成 0x59f11f18，正确值是 0x59f111f1。抄错任何一项都会得到「看着像摘要
 * 但全错」的结果，页面表现为密码永远验不过 —— 别改这张表，要改就重新推导。
 */
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** H 初值：前 8 个质数平方根分数部分的前 32 位。 */
const H0 = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;

/**
 * 对 UTF-8 字节算 SHA-256，返回 32 字节的摘要。
 * 输入只是密码，量级极小，不做任何分支优化。
 */
export function sha256Bytes(input: Uint8Array): Uint8Array {
  const h = H0.slice();
  const len = input.length;
  // 填充：0x80 + 若干 0 + 64 位 big-endian 比特长度，使总长为 64 的倍数
  const padded = new Uint8Array(((((len + 8) >> 6) + 1) * 64));
  padded.set(input);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = len * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000), false);
  view.setUint32(padded.length - 4, bits >>> 0, false);

  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i += 1) h[i] = (h[i] + next[i]) >>> 0;
  }

  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) ov.setUint32(i * 4, h[i], false);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** 纯 JS 路径：base64(SHA-256(str))。 */
export function sha256b64Fallback(str: string): string {
  return toBase64(sha256Bytes(new TextEncoder().encode(str)));
}

/**
 * base64(SHA-256(str))。crypto.subtle 不可用（非 secure context）或调用抛错时
 * 自动退回纯 JS —— 调用方不需要关心走了哪条，两条结果必须一致。
 */
export async function sha256b64(str: string): Promise<string> {
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
  if (!subtle) return sha256b64Fallback(str);
  try {
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(str));
    return toBase64(new Uint8Array(buf));
  } catch {
    // 权限受限的嵌入环境里 digest 会直接抛，退回纯 JS
    return sha256b64Fallback(str);
  }
}

/** 页面门禁：算出候选密码的哈希并与 config.PASSWORD_HASH 比对。 */
export async function verifyPagePassword(password: string, salt: string, expected: string): Promise<boolean> {
  return (await sha256b64(salt + password)) === expected;
}
