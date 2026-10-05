export interface Template {
  id: string;
  name: string;
  icon: string;
  description: string;
  systemPrompt: string;
  isCustom?: boolean;
}

export const PRESET_TEMPLATES: Template[] = [
  {
    id: 'default',
    name: '通用仿写',
    icon: '✏️',
    description: '保留原文信息，改写表达方式',
    systemPrompt: '你是一个小红书爆款文案仿写专家。你的核心能力是：接收一篇原始小红书帖子，在保留所有关键事实信息（运营商名称、带宽规格、费用金额、套餐内容、优惠条件等）的前提下，改写文字表达方式，增加emoji提升可读性，确保内容不被平台识别为抄袭或重复。你必须精准识别并保留原文中的所有话题标签（#开头的标签）。',
  },
];

import { templatesApi } from './api';

const STORAGE_KEY = 'xhs_custom_templates';

/**
 * 模板存储：localStorage 是渲染缓存（同步、即时），服务端是持久副本。
 *
 * 这样分工的原因：getAllTemplates() 在渲染路径上被同步调用，改成异步会牵动
 * Writer 和 Settings 的整个渲染流程；而模板本身是用户攒下来的资产，
 * 只存 localStorage 的话清一次站点数据就全没了。
 *
 * 所以：读永远走本地缓存，写立即落本地并后台推服务端，
 * 启动时做一次合并同步。服务端没建表时退化为纯本地，功能不受影响。
 */

function writeCache(templates: Template[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
  } catch { /* 私密模式下存不下，本次会话内仍可用 */ }
}

export function getCustomTemplates(): Template[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function push(t: Template) {
  templatesApi.upsert({
    id: t.id,
    name: t.name,
    icon: t.icon,
    description: t.description,
    systemPrompt: t.systemPrompt,
  }).catch(() => { /* 同步失败不影响本地可用，下次启动会重试 */ });
}

export function saveCustomTemplate(template: Omit<Template, 'id' | 'isCustom'>): Template {
  const templates = getCustomTemplates();
  const newTemplate: Template = {
    ...template,
    id: `custom_${Date.now()}`,
    isCustom: true,
  };
  templates.push(newTemplate);
  writeCache(templates);
  push(newTemplate);
  return newTemplate;
}

export function updateCustomTemplate(id: string, updates: Partial<Template>): void {
  const templates = getCustomTemplates();
  const idx = templates.findIndex(t => t.id === id);
  if (idx !== -1) {
    templates[idx] = { ...templates[idx], ...updates };
    writeCache(templates);
    push(templates[idx]);
  }
}

export function deleteCustomTemplate(id: string): void {
  writeCache(getCustomTemplates().filter(t => t.id !== id));
  templatesApi.remove(id).catch(() => { /* 本地已删，服务端下次同步会再试 */ });
}

/**
 * 启动时的一次合并同步。
 *
 * 合并策略：以 id 为准取并集。两边都有的以服务端为准（换设备时才有意义），
 * 只有本地有的推上去（第一次启用云端同步时把历史模板迁移过去）。
 * 只有服务端有的拉下来。
 *
 * 故意不做删除传播：本地缓存里没有某个 id，可能是这台设备从没同步过，
 * 而不是用户删了它。删除只在用户显式点删除时发生。
 */
export async function syncTemplates(): Promise<{ synced: boolean; count: number }> {
  let remote: Template[] = [];
  try {
    const res = await templatesApi.list();
    if (!res.available) return { synced: false, count: getCustomTemplates().length };
    remote = res.data.map(r => ({
      id: r.id, name: r.name, icon: r.icon,
      description: r.description, systemPrompt: r.systemPrompt, isCustom: true as const,
    }));
  } catch {
    return { synced: false, count: getCustomTemplates().length };
  }

  const local = getCustomTemplates();
  const remoteIds = new Set(remote.map(t => t.id));
  const localOnly = local.filter(t => !remoteIds.has(t.id));

  for (const t of localOnly) push(t);

  const merged = [...remote, ...localOnly];
  writeCache(merged);
  return { synced: true, count: merged.length };
}

export function getAllTemplates(): Template[] {
  return [...PRESET_TEMPLATES, ...getCustomTemplates()];
}
