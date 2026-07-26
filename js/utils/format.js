// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2025-2026 The 25-ji-code-de Team

/**
 * Format Utilities Module
 */

/**
 * Format seconds to MM:SS
 * @param {number} seconds
 * @returns {string}
 */
export function formatTime(seconds) {
  if (!isFinite(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Escape HTML special characters
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
  /*
   * 原本是 `div.textContent → div.innerHTML` 的写法。那条路只转义
   * `& < >` —— **引号不转**，因为 innerHTML 序列化文本节点时本来就不转引号
   * （引号只在序列化属性值时才转）。
   *
   * 元素上下文够用，插进 `value="…"` / `data-x="…"` 这类属性时会被闭合。
   *
   * `js/utils/helpers.js` 里同名函数早就因为这个原因改成显式五字符了，
   * 这里一直没跟上 —— 于是同一个仓里两个 `escapeHtml` 语义不同，
   * 而调用方看不出区别。
   *
   * 调用点 `music-list-ui.js` 曾为此手工补了一次 `.replace(/"/g,'&quot;')`；
   * 那说明作者知道这个坑，但也说明安全性依赖「每个属性用法都记得补」。
   * 统一之后不再需要。
   */
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
