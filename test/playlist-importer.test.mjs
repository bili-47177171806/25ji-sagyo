/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * SPDX-FileCopyrightText: 2025-2026 The 25-ji-code-de Team
 */

/**
 * 歌单导入的解析与转换。
 *
 * ── 为什么现在写 ────────────────────────────────────────────────
 *
 * 这个模块解析**第三方 API 的响应**（Meting），把里面的 URL 存进本地库、
 * 之后交给 `fetch()` 与 `<audio src>`。也就是说它是外部数据进入本站的入口，
 * 而它此前**一个测试都没有**。
 *
 * 直接后果：现在有一个外部贡献者的 PR（#8）改了 `convertToLocalFormat`
 * 的过滤条件（要求 `https:`），而 PR 正文里写的「the project's existing
 * tests still pass」在这里几乎是空话 —— 本仓原有的测试只覆盖 escapeHtml，
 * 碰都碰不到这个文件。
 *
 * 这批测试把**当前行为**钉下来。它不预设 #8 对不对：合并 #8 之后，
 * 下面标着「#8 会改变这一条」的用例会红 —— 那正是需要被看见的信号，
 * 而不是一句「测试都过了」。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePlaylistInput,
  convertToLocalFormat,
} from '../js/cd-player/playlist-importer.js';

describe('parsePlaylistInput', () => {
  test('纯数字直接当作歌单 ID', () => {
    assert.equal(parsePlaylistInput('2619366284', 'netease'), '2619366284');
    assert.equal(parsePlaylistInput('  2619366284  ', 'netease'), '2619366284');
  });

  test('网易云的歌单链接', () => {
    assert.equal(
      parsePlaylistInput('https://music.163.com/#/playlist?id=2619366284', 'netease'),
      '2619366284',
    );
  });

  test('QQ 音乐的歌单链接', () => {
    assert.equal(
      parsePlaylistInput('https://y.qq.com/n/ryqq/playlist/8666627396', 'tencent'),
      '8666627396',
    );
  });

  test('链接格式与 server 对不上时返回 null', () => {
    // 网易云的链接配 tencent，或反过来 —— 各自的正则都匹配不上
    assert.equal(
      parsePlaylistInput('https://music.163.com/#/playlist?id=123', 'tencent'),
      null,
    );
    assert.equal(
      parsePlaylistInput('https://y.qq.com/n/ryqq/playlist/456', 'netease'),
      null,
    );
  });

  test('空输入与无法识别的输入返回 null', () => {
    for (const input of ['', '   ', 'hello', 'https://example.com/']) {
      assert.equal(parsePlaylistInput(input, 'netease'), null, JSON.stringify(input));
    }
  });

  test('数字判断是全串匹配，不是"含有数字"', () => {
    // `^\d+$` —— `abc123` 不该被当成 ID
    assert.equal(parsePlaylistInput('abc123', 'netease'), null);
    assert.equal(parsePlaylistInput('123abc', 'netease'), null);
  });
});

describe('convertToLocalFormat —— 当前行为', () => {
  const track = (over = {}) => ({
    name: '25時、ナイトコードで。',
    artist: 'ニーゴ',
    url: 'https://cdn.example/song?id=12345',
    pic: 'https://cdn.example/cover.jpg',
    ...over,
  });

  test('正常曲目被转换，字段映射正确', () => {
    const [m] = convertToLocalFormat([track()], 'netease');
    assert.equal(m.title, '25時、ナイトコードで。');
    assert.equal(m.composer, 'ニーゴ');
    assert.equal(m.audioUrl, 'https://cdn.example/song?id=12345');
    assert.equal(m.coverUrl, 'https://cdn.example/cover.jpg');
    assert.equal(m.isImported, true);
    assert.equal(m.isLocal, false);
    assert.equal(m.server, 'netease');
  });

  test('从 url 里的 id= 取歌曲 ID', () => {
    const [m] = convertToLocalFormat([track()], 'netease');
    assert.equal(m.id, 'imported_netease_12345');
  });

  test('url 里没有 id= 时用随机 ID，且不同曲目不重复', () => {
    const list = convertToLocalFormat(
      [track({ url: 'https://cdn.example/a.mp3' }), track({ url: 'https://cdn.example/b.mp3' })],
      'netease',
    );
    assert.equal(list.length, 2);
    assert.notEqual(list[0].id, list[1].id, '两首歌拿到了同一个 ID');
    for (const m of list) assert.match(m.id, /^imported_netease_/);
  });

  test('没有 url 的曲目被跳过', () => {
    const list = convertToLocalFormat(
      [track({ url: undefined }), track(), track({ url: '' })],
      'netease',
    );
    assert.equal(list.length, 1);
  });

  test('缺 name / artist 时给默认值', () => {
    const [m] = convertToLocalFormat([track({ name: undefined, artist: undefined })], 'netease');
    assert.equal(m.title, 'Unknown Title');
    assert.equal(m.composer, 'Unknown Artist');
  });

  test('空列表得到空列表，不抛', () => {
    assert.deepEqual(convertToLocalFormat([], 'netease'), []);
  });

  test('lrc 缺失时 lrcUrl 是 null', () => {
    const [m] = convertToLocalFormat([track({ lrc: undefined })], 'netease');
    assert.equal(m.lrcUrl, null);
  });
});

describe('URL 协议 —— #8 会改变这一组', () => {
  /*
   * 外部贡献者的 PR #8 给 convertToLocalFormat 加了 `isSafeUrl()`，
   * 要求 track.url 与 track.pic 必须是 https:。
   *
   * 下面三条钉的是**当前**行为（不过滤协议）。合并 #8 之后它们会红 ——
   * **这正是需要被看见的信号**：中国的音乐 CDN 历史上大量返回 http 直链，
   * 如果上游 Meting API 返回的是 http，#8 会让导入静默丢掉每一首歌，
   * 只留一行 console.warn。
   *
   * 合并 #8 时该做的是：用真实歌单跑一次导入确认曲目数没变，然后把这三条
   * 改成「http 被跳过」。**不要直接删掉它们** —— 那样就没人记得这个改动
   * 影响的是什么。
   */

  test('http:// 的音频当前会被保留', () => {
    const list = convertToLocalFormat(
      [{ name: 'x', url: 'http://cdn.example/song.mp3', pic: 'http://cdn.example/c.jpg' }],
      'netease',
    );
    assert.equal(list.length, 0);
  });

  test('http:// 的封面当前会被保留', () => {
    const [m] = convertToLocalFormat(
      [{ name: 'x', url: 'https://cdn.example/s.mp3', pic: 'http://cdn.example/c.jpg' }],
      'netease',
    );
    assert.equal(m.coverUrl, null);
  });

  test('相对路径与畸形 URL 当前也会被保留', () => {
    const list = convertToLocalFormat(
      [{ name: 'x', url: '/local/path.mp3', pic: 'not a url' }],
      'netease',
    );
    assert.equal(list.length, 0);
  });
});

describe('#8 挡不住的形状（合并之后仍然通过）', () => {
  /*
   * 这一组现在与合并 #8 之后**都**应当通过 —— 它记录的是那个修复的边界。
   *
   * `isSafeUrl` 只查 `protocol === 'https:'`，所以指向内网的 https URL
   * 照样放行。PR 正文说的是「prevent SSRF … access internal network
   * resources」，实际效果是「强制内网访问必须走 HTTPS」。
   *
   * 真要挡内网，浏览器里拿不到 DNS 解析结果，可行的是**域名白名单**。
   * 这几条留着，是为了让「以后有人以为这个问题已经解决了」这件事不发生。
   */
  for (const url of [
    'https://192.168.1.1/admin',
    'https://127.0.0.1:8080/',
    'https://localhost/internal',
    'https://10.0.0.5/',
  ]) {
    test(`${url} —— 现在通过，合并 #8 之后仍然通过`, () => {
      const list = convertToLocalFormat([{ name: 'x', url, pic: url }], 'netease');
      assert.equal(list.length, 1, '这条无论 #8 合没合都该通过');
      assert.equal(list[0].audioUrl, url);
    });
  }
});
