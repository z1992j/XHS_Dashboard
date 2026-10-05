/**
 * 图片工具。
 *
 * /api/xhs/uploads/* 是公开静态目录（浏览器 <img> 无法携带 Authorization 头），
 * 所以 data: / blob: / 相对路径三类值都能直接放进 src，不需要任何解析层。
 */
const COMPRESS_MAX_DIM = 1600;

/**
 * 数据 URL 的字节预算。后端 body 上限是 2MB，base64 会把体积放大 4/3，
 * 所以这里留出余量：1.4MB 的 data URL 加上 JSON 里的标题正文标签，
 * 距离上限仍有空间。
 */
const MAX_DATA_URL_BYTES = 1.4 * 1024 * 1024;

/** 逐级降质，直到编码结果落进预算内。 */
const QUALITY_STEPS = [0.85, 0.7, 0.55, 0.4];

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('图片解析失败'));
    el.src = src;
  });
}

/** data URL 的近似字节数（base64 段每 4 个字符表示 3 字节）。 */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return dataUrl.length;
  const b64 = dataUrl.length - comma - 1;
  const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(b64 * 0.75) - padding);
}

/**
 * 把图片文件读成 data URL，必要时缩放到 1600px 并重编码为 JPEG，
 * 保证结果一定小于后端 body 上限 —— 否则一张手机原图会稳定触发 413。
 *
 * 只有在原图已经足够小的时候才原样返回，其余情况一律重新编码，
 * 并在仍然超标时继续降质。
 */
export async function compressImage(file: File): Promise<string> {
  const dataUrl = await readAsDataUrl(file);
  if (dataUrlBytes(dataUrl) <= MAX_DATA_URL_BYTES) return dataUrl;

  const img = await loadImage(dataUrl);
  const { width, height } = img;
  if (!width || !height) return dataUrl;

  let scale = Math.min(1, COMPRESS_MAX_DIM / Math.max(width, height));

  // 最多两轮：先按尺寸和质量压一遍，还不够就再缩一半尺寸。
  for (let round = 0; round < 2; round++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    for (const quality of QUALITY_STEPS) {
      const encoded = canvas.toDataURL('image/jpeg', quality);
      if (dataUrlBytes(encoded) <= MAX_DATA_URL_BYTES) return encoded;
    }
    scale *= 0.6;
  }

  throw new Error('图片过大，请换一张或先自行压缩');
}

/**
 * 发给读图接口、压缩前的解码字节预算。
 *
 * nginx 的 client_max_body_size 默认只有 1MB，而我们原来一张图就允许 1.4MB、
 * 一次最多 4 张 —— 请求体能到 5.6MB，nginx 直接拒绝并断连，浏览器只看到
 * 一个 fetch 异常，于是界面显示「网络连接失败」。
 *
 * 这里的数字是解码后的字节数，实际发送的是 base64，会再膨胀约 4/3。
 * 800KB 解码后 ≈ 1.07MB 编码后，单独就已经超过 1MB 的上限——留量必须算在
 * 编码后的体积上，不能算在解码前，所以压到 600KB（编码后 ≈ 820KB），
 * 与下面 VISION_BODY_SAFE_LIMIT 留出安全边际。
 */
export const VISION_TOTAL_BUDGET = 600 * 1024;

/**
 * 请求体（编码后，即真正上线的字节数）的安全上限，读图发送前的预检和
 * apiFetch 判断"是不是体积太大被反代拒绝"用的是同一个数字——两处各判各的、
 * 数字还不一致的话，预检放过了、真正发送时又被拦，用户看到的报错就会前后
 * 矛盾。略低于 nginx 默认的 1MB，留出 JSON 结构本身的开销。
 */
export const VISION_BODY_SAFE_LIMIT = 900 * 1024;

/**
 * 读图用的尺寸上限。
 *
 * 用户反馈过读图会把图里的小红书号这类水印文字也提取出来——这反过来说明
 * 1280px 的分辨率绰绰有余：水印字通常比资费表里的价格数字还小，模型却能
 * 连它都读出来。降到 1024px（像素数少 36%，多模态模型处理更快）之后，
 * 资费表本身该有的大字号数字仍然清晰，水印这类小字反而更容易变得模糊，
 * 算是速度和"少读一点无关信息"两头都讨好。
 */
const VISION_MAX_DIM = 1024;
const VISION_QUALITY_STEPS = [0.75, 0.6, 0.45, 0.3];

/**
 * 把要送去读图的图片压进总预算。
 *
 * 已经在服务器上的图（/api/xhs/uploads/ 路径）只占几十字节，原样带过去 ——
 * 后端会自己从磁盘读，根本不用走网络传图片内容。
 * 只有本地上传的 data URL 才需要重新编码。
 */
export async function shrinkForVision(images: string[]): Promise<string[]> {
  const dataUrls = images.filter(src => src.startsWith('data:'));
  if (!dataUrls.length) return images;

  // 预算按需要重新编码的张数均分
  const perImage = Math.floor(VISION_TOTAL_BUDGET / dataUrls.length);

  return Promise.all(images.map(async (src) => {
    if (!src.startsWith('data:')) return src;
    if (dataUrlBytes(src) <= perImage) return src;

    let img: HTMLImageElement;
    try {
      img = await loadImage(src);
    } catch {
      return src;
    }
    const { width, height } = img;
    if (!width || !height) return src;

    let scale = Math.min(1, VISION_MAX_DIM / Math.max(width, height));
    for (let round = 0; round < 3; round++) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return src;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const q of VISION_QUALITY_STEPS) {
        const encoded = canvas.toDataURL('image/jpeg', q);
        if (dataUrlBytes(encoded) <= perImage) return encoded;
      }
      scale *= 0.65;
    }
    // 实在压不下去也把最小的那版发出去，让后端给出明确报错，
    // 好过在这里静默失败
    return src;
  }));
}

/** 估算这批图作为 JSON 请求体的大致字节数。 */
export function estimateVisionPayload(images: string[]): number {
  return images.reduce((sum, src) => sum + (src.startsWith('data:') ? dataUrlBytes(src) * 1.37 : src.length), 200);
}
