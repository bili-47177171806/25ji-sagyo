/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * SPDX-FileCopyrightText: 2025-2026 The 25-ji-code-de Team
 */

/**
 * 本仓的四份 `escapeHtml` 必须语义一致。
 *
 * ── 由来 ────────────────────────────────────────────────────────
 *
 * 同一个概念在本仓有四份实现，而它们**不一样**：
 *
 *   js/utils/helpers.js       显式五字符（有人早就改过，并写明了理由）
 *   js/utils/user-profile.js  显式五字符
 *   js/utils/format.js        `div.textContent → innerHTML` —— **不转引号**
 *   js/components/todo-list.js 同上
 *
 * `innerHTML` 序列化文本节点时只转 `& < >`；引号只在序列化**属性值**时才转。
 * 所以后两份的产物一旦插进 `value="…"` / `data-x="…"`，引号会闭合属性。
 *
 * `music-list-ui.js` 的调用点曾为此手工补过一次 `.replace(/"/g,'&quot;')` ——
 * 那说明作者知道这个坑，但也说明**安全性依赖「每个属性用法都记得补」**。
 *
 * 四份已统一。这批测试钉住「它们对同一输入给同一答案」——
 * 这正是当初发现问题的办法：同一个概念有多个实现时，让它们各跑一遍比对。
 *
 * ── 方法 ────────────────────────────────────────────────────────
 *
 * 不手抄任何一份：从源文件里原样抠出函数体求值。手抄的话，测的只是我抄得对。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 从源文件里抠出 escapeHtml 并求值。 */
function extract(rel) {
  const src = readFileSync(join(root, rel), 'utf8');
  const patterns = [
    /export function escapeHtml\([\s\S]*?\n\}/,
    /^\s*function escapeHtml\([\s\S]*?\n\s*\}/m,
    /^\s{2}escapeHtml\([\s\S]*?\n\s{2}\}/m, // 类方法
  ];
  for (const re of patterns) {
    const m = re.exec(src);
    if (!m) continue;
    let body = m[0].replace(/^\s*export\s+/, '').trim();
    if (!/^function\b/.test(body)) body = `function ${body}`;
    try {
      return new Function(`${body}\nreturn escapeHtml;`)();
    } catch {
      /* 换下一个模式 */
    }
  }
  return null;
}

const FILES = [
  'js/utils/helpers.js',
  'js/utils/user-profile.js',
  'js/utils/format.js',
  'js/components/todo-list.js',
];

const impls = FILES.map((rel) => ({ rel, fn: extract(rel) }));

describe('四份实现都抠得出来', () => {
  for (const { rel, fn } of impls) {
    test(rel, () => {
      assert.equal(typeof fn, 'function', `抠不出 ${rel} 的 escapeHtml —— 写法变了，这批测试要跟着改`);
    });
  }
});

describe('对同一输入给同一答案', () => {
  const CASES = [
    ['与号', '&'],
    ['小于号', '<'],
    ['大于号', '>'],
    ['双引号', '"'],
    ['单引号', "'"],
    ['XSS 载荷', '"><img src=x onerror=alert(1)>'],
    ['属性逃逸（单引号）', "' onmouseover='alert(1)"],
    ['已经是实体', '&lt;'],
    ['正常文本', 'ナギ 25時、コードで。'],
    ['空串', ''],
    ['null', null],
    ['undefined', undefined],
    ['数字', 42],
    ['布尔', false],
  ];

  for (const [label, input] of CASES) {
    test(label, () => {
      const outs = impls.map(({ rel, fn }) => ({
        rel,
        out: fn ? String(fn(input)) : '(抠不出来)',
      }));
      const uniq = [...new Set(outs.map((o) => o.out))];
      assert.equal(
        uniq.length,
        1,
        `四份实现给出不同答案：\n  ` +
          outs.map((o) => `${o.rel} → ${JSON.stringify(o.out)}`).join('\n  '),
      );
    });
  }
});

describe('五个字符一个都不能少', () => {
  /*
   * 「一致」不等于「正确」—— 四份一起漏掉引号也是一致的。
   * 所以另外钉住实际覆盖的字符集。
   */
  const MUST = [
    ['&', '&amp;'],
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['"', '&quot;'],
    ["'", '&#39;'],
  ];

  for (const { rel, fn } of impls) {
    test(rel, () => {
      assert.ok(fn, `抠不出 ${rel}`);
      for (const [ch, ent] of MUST) {
        assert.equal(fn(ch), ent, `${rel} 没有把 ${ch} 转成 ${ent}`);
      }
    });
  }

  test('& 最先替换 —— 实体不会被二次转义', () => {
    for (const { rel, fn } of impls) {
      assert.equal(fn('&lt;'), '&amp;lt;', `${rel} 的替换顺序不对`);
    }
  });
});

describe('属性上下文的调用点不再需要手工补引号', () => {
  test('music-list-ui.js 里没有多余的 .replace(/"/g, ...)', () => {
    /*
     * 那次手工补是对当时 format.js 不转引号的正确补救。统一之后它是冗余的，
     * 而冗余的防护会让人以为「这里特殊」，下一个属性用法反而可能照抄它
     * 而不是依赖 escapeHtml。
     */
    const src = readFileSync(join(root, 'js/cd-player/music-list-ui.js'), 'utf8');
    assert.doesNotMatch(
      src,
      /escapedTitle\.replace\(\/"\/g/,
      '还留着手工补引号的写法',
    );
    assert.match(src, /data-full-text="\$\{escapedTitle\}"/, '属性里应当直接用已转义的值');
  });
});
