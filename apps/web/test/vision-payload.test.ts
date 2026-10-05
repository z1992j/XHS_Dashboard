import { describe, it, expect } from 'vitest';
import { estimateVisionPayload, VISION_TOTAL_BUDGET, VISION_BODY_SAFE_LIMIT } from '../src/lib/image';

const dataUrl = (kb: number) => 'data:image/jpeg;base64,' + 'A'.repeat(Math.round(kb * 1024 * 4 / 3));

describe('读图请求体预算', () => {
  it('安全上限低于 nginx 默认的 1MB client_max_body_size', () => {
    // 超过就会被反向代理断连，前端只看到「网络连接失败」
    expect(VISION_BODY_SAFE_LIMIT).toBeLessThan(1024 * 1024);
  });

  it('压到预算上限的图，编码后（base64 膨胀）仍在安全上限之内', () => {
    // VISION_TOTAL_BUDGET 是解码后的字节数，真正发送的是 base64 —— 会再
    // 膨胀约 4/3。这两个数字必须留出这层膨胀的余量，否则"压缩成功"的图片
    // 依然会在发送时超过 nginx 的上限。
    const worstCase = estimateVisionPayload([dataUrl(VISION_TOTAL_BUDGET / 1024)]);
    expect(worstCase).toBeLessThan(VISION_BODY_SAFE_LIMIT);
  });

  it('服务器上的图几乎不占请求体 —— 后端自己从磁盘读', () => {
    const paths = ['/api/xhs/uploads/a.jpg', '/api/xhs/uploads/b.jpg', '/api/xhs/uploads/c.jpg'];
    expect(estimateVisionPayload(paths)).toBeLessThan(1024);
  });

  it('data URL 会按 base64 膨胀计入', () => {
    const one = estimateVisionPayload([dataUrl(100)]);
    expect(one).toBeGreaterThan(100 * 1024);
  });

  it('混合时只有 data URL 计入体积', () => {
    const mixed = estimateVisionPayload(['/api/xhs/uploads/a.jpg', dataUrl(100)]);
    const pure = estimateVisionPayload([dataUrl(100)]);
    expect(Math.abs(mixed - pure)).toBeLessThan(500);
  });

  it('旧行为（4 张 × 1.4MB）远超预算，这正是此前失败的原因', () => {
    const old = estimateVisionPayload([dataUrl(1400), dataUrl(1400), dataUrl(1400), dataUrl(1400)]);
    expect(old).toBeGreaterThan(5 * 1024 * 1024);
    expect(old).toBeGreaterThan(VISION_TOTAL_BUDGET * 6);
  });

  it('空列表也有个基线开销', () => {
    expect(estimateVisionPayload([])).toBeGreaterThan(0);
  });
});
