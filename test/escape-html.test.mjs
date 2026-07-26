/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * SPDX-FileCopyrightText: 2025-2026 The 25-ji-code-de Team
 *
 * escapeHtml 与「第三方 API 数据进 innerHTML」路径的测试。
 *
 * settings-panel 的版本弹窗会把 GitHub API 返回的 commit 数据
 * （含提交信息）插进 insertAdjacentHTML。提交信息由能往 main 推送的人控制，
 * 不是外部攻击者可直接投毒的输入，但「第三方响应当 HTML 渲染」这个形态
 * 本身就该堵住。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** helpers.js 是 IIFE，挂到 window.AppHelpers 上。 */
function loadHelpers() {
  const sandbox = { window: {}, document: undefined, console };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(root, 'js/utils/helpers.js'), 'utf8'), context, {
    filename: 'helpers.js',
  });
  return sandbox.window.AppHelpers;
}

const helpers = loadHelpers();
const { escapeHtml } = helpers;

describe('escapeHtml', () => {
  test('转义全部五个危险字符', () => {
    assert.equal(escapeHtml('&'), '&amp;');
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('>'), '&gt;');
    assert.equal(escapeHtml('"'), '&quot;');
    assert.equal(escapeHtml("'"), '&#39;');
  });

  test('引号也要转义 —— 原实现用 textContent 只覆盖 < > &', () => {
    // 旧写法：div.textContent = text; return div.innerHTML
    // 那样 " 和 ' 会原样输出，插进 value="…" / onclick="…" 就能闭合属性
    const out = escapeHtml('" onmouseover="alert(1)');
    assert.ok(!out.includes('"'), '不得残留原始双引号');
    assert.ok(out.includes('&quot;'));
  });

  test('& 最先替换 —— 不能二次转义', () => {
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  });

  test('元素注入 payload 被中和', () => {
    assert.equal(
      escapeHtml('<img src=x onerror=alert(1)>'),
      '&lt;img src=x onerror=alert(1)&gt;',
    );
  });

  test('不依赖 document —— 可在无 DOM 环境使用', () => {
    // 原实现调 document.createElement，这里的 sandbox 里 document 是 undefined
    assert.doesNotThrow(() => escapeHtml('<b>x</b>'));
  });

  test('null / undefined 转成空串', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });

  test('正常文本原样保留', () => {
    assert.equal(escapeHtml('25時、Nightcord で。'), '25時、Nightcord で。');
    assert.equal(escapeHtml(0), '0');
  });
});

describe('版本弹窗的转义覆盖率（静态扫描）', () => {
  const source = readFileSync(join(root, 'js/components/settings-panel.js'), 'utf8');

  /**
   * 只扫 modalHtml 这个模板字面量的内部。
   *
   * 不能直接在整个文件里找 latestCommitInfo.xxx —— 有些是纯比较
   * （`APP_VERSION.fullSha === latestCommitInfo.sha`），那些不进 HTML，不需要转义。
   * 也不能用 `\$\{[^}]*\}` 去匹配插值 —— 模板里有多行三元和嵌套模板。
   */
  function modalTemplate() {
    const start = source.indexOf('const modalHtml = `');
    assert.ok(start >= 0, '没找到 modalHtml');
    const from = start + 'const modalHtml = `'.length;
    const end = source.indexOf('`;', from);
    assert.ok(end > from, '没找到模板结尾');
    return source.slice(from, end);
  }

  test('模板里全部 latestCommitInfo 字段访问都过了 esc()', () => {
    const template = modalTemplate();
    const accesses = [...template.matchAll(/(esc\(\s*)?latestCommitInfo\.(\w+)/g)];
    assert.ok(accesses.length > 0, '确认字段访问仍然存在');

    const unescaped = [
      ...new Set(accesses.filter((m) => !m[1]).map((m) => `latestCommitInfo.${m[2]}`)),
    ];
    assert.deepEqual(unescaped, [], `以下 GitHub API 字段未转义：${unescaped.join(', ')}`);
  });

  test('esc 绑定到共享的 AppHelpers.escapeHtml', () => {
    assert.match(source, /const esc = window\.AppHelpers\.escapeHtml/);
  });

  test('commit message 是最关键的一处，必须转义', () => {
    assert.match(source, /\$\{esc\(latestCommitInfo\.message\)\}/);
  });
});
