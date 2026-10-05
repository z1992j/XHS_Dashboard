export interface CopyableNote {
  title: string;
  content: string;
  tags?: string[];
}

export function noteToPlainText(note: CopyableNote): string {
  const tagLine = (note.tags || []).map((t) => '#' + t).join(' ');
  return `${note.title}\n\n${note.content}\n\n${tagLine}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Copy a note to the clipboard as both rich HTML (for XHS editor) and plain
 * text, with graceful degradation across browsers.
 */
export async function copyNote(note: CopyableNote): Promise<void> {
  const plainText = noteToPlainText(note);
  const lines = note.content.split('\n');
  const htmlContent =
    `<div><b>${escapeHtml(note.title)}</b></div>` +
    `<div><br></div>` +
    lines.map((line) => `<div>${escapeHtml(line) || '<br>'}</div>`).join('') +
    `<div><br></div>` +
    // 粘贴到别人的编辑器里，读不到本项目的 CSS 变量，只能写死品牌蓝
    `<div style="color:#17306e">${escapeHtml((note.tags || []).map((t) => `#${t}`).join('  '))}</div>`;

  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
          'text/html': new Blob([htmlContent], { type: 'text/html' }),
        }),
      ]);
      return;
    }
  } catch { /* fall through */ }

  try {
    await navigator.clipboard.writeText(plainText);
    return;
  } catch { /* fall through */ }

  const ta = document.createElement('textarea');
  ta.value = plainText;
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}
