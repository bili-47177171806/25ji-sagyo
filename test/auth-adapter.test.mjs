/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * SPDX-FileCopyrightText: 2025-2026 The 25-ji-code-de Team
 *
 * 25ji 认证适配层的契约测试。
 *
 * 钉住迁移不能破坏的两件事：
 *   1. storage key 与迁移前**逐字一致** —— 变了就会把所有已登录用户登出
 *   2. window.SekaiAuth 上 9 个调用点用到的方法名与语义不变，
 *      特别是 hub 没有、25ji 独有的 getDisplayName / getAvatarUrl / getBio
 *
 * 全部脚本是经典 <script>，这里手工搭最小 window 环境后按加载顺序求值。
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

const local = new MemoryStorage();
const session = new MemoryStorage();
let redirectedTo = '';
let reloaded = 0;
let fetchQueue = [];
let fetchCalls = [];

const sandbox = {
  console,
  crypto,
  TextEncoder,
  URLSearchParams,
  URL,
  btoa,
  Date,
  Number,
  Math,
  JSON,
  Promise,
  Error,
  Array,
  Object,
  String,
  Uint8Array,
  setTimeout,
  localStorage: local,
  sessionStorage: session,
  async fetch(url, init) {
    fetchCalls.push({ url: String(url), init });
    const next = fetchQueue.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return {
      ok: next.status === undefined || (next.status >= 200 && next.status < 300),
      status: next.status ?? 200,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    };
  },
  location: {
    origin: 'https://25ji.nightcord.de5.net',
    search: '',
    get href() {
      return redirectedTo;
    },
    set href(v) {
      redirectedTo = v;
    },
    reload() {
      reloaded += 1;
    },
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const context = vm.createContext(sandbox);

// 按 index.html 里的顺序求值
for (const file of [
  'js/utils/config.js',
  'js/vendor/sekai-auth.global.js',
  'js/utils/auth.js',
]) {
  vm.runInContext(readFileSync(join(root, file), 'utf8'), context, { filename: file });
}

const Auth = sandbox.window.SekaiAuth;

function stubFetch(queue) {
  fetchQueue = queue;
  fetchCalls = [];
  return fetchCalls;
}

beforeEach(() => {
  local.clear();
  session.clear();
  redirectedTo = '';
  reloaded = 0;
  fetchQueue = [];
  fetchCalls = [];
});

describe('加载顺序与全局导出', () => {
  test('vendor bundle 暴露 SekaiAuthSDK', () => {
    assert.equal(typeof sandbox.window.SekaiAuthSDK, 'object');
    assert.equal(typeof sandbox.window.SekaiAuthSDK.SekaiAuth, 'function');
  });

  test('适配层覆盖出 window.SekaiAuth', () => {
    assert.equal(typeof Auth, 'object');
  });
});

describe('storage key 与迁移前逐字一致', () => {
  test('token 相关的三个 key', () => {
    assert.equal(Auth.sdk.keys.accessToken, 'sekai_access_token');
    assert.equal(Auth.sdk.keys.refreshToken, 'sekai_refresh_token');
    assert.equal(Auth.sdk.keys.expiresAt, 'sekai_token_expires_at');
  });

  test('PKCE 的两个 session key', () => {
    assert.equal(Auth.sdk.keys.codeVerifier, 'sekai_code_verifier');
    assert.equal(Auth.sdk.keys.state, 'sekai_auth_state');
  });

  test('真的能读到迁移前写下的 token', async () => {
    local.setItem('sekai_access_token', 'OLD');
    local.setItem('sekai_refresh_token', 'OLD_R');
    local.setItem('sekai_token_expires_at', String(Date.now() + 60 * 60 * 1000));
    assert.equal(Auth.isAuthenticated(), true);
    assert.equal(await Auth.getValidAccessToken(), 'OLD');
  });
});

describe('CONFIG 映射', () => {
  test('clientId / redirectUri 来自 config.js', () => {
    assert.equal(Auth.sdk.clientId, '25ji_client');
    // 注意 25ji 的回调是 /callback.html 而不是 hub 的 /callback
    assert.equal(Auth.sdk.redirectUri, 'https://25ji.nightcord.de5.net/callback.html');
  });
});

describe('profile helper（25ji 独有，hub 没有）', () => {
  const full = {
    sub: 'u1',
    display_name: 'なこ',
    name: 'Nako',
    preferred_username: 'nako',
    username: 'nako_login',
    avatar_url: 'https://cdn.example/a.png',
    bio: '  签名  ',
  };

  test('getDisplayName 优先 display_name', () => {
    assert.equal(Auth.getDisplayName(full), 'なこ');
  });

  test('getDisplayName 回退到 OIDC name', () => {
    assert.equal(Auth.getDisplayName({ name: 'Asagi' }), 'Asagi');
  });

  test('getDisplayName 在无可用字段时返回 fallback', () => {
    assert.equal(Auth.getDisplayName({}), 'User');
    assert.equal(Auth.getDisplayName(null), 'User');
    assert.equal(Auth.getDisplayName(null, '访客'), '访客');
  });

  test('getUsername 取登录名而不是昵称', () => {
    assert.equal(Auth.getUsername(full), 'nako');
    assert.equal(Auth.getUsername({}), '');
    assert.equal(Auth.getUsername(null, 'anon'), 'anon');
  });

  test('getAvatarUrl 只接受 https', () => {
    assert.equal(Auth.getAvatarUrl(full), 'https://cdn.example/a.png');
    assert.equal(Auth.getAvatarUrl({ picture: 'http://cdn/x.png' }), null);
    assert.equal(Auth.getAvatarUrl({ picture: 'javascript:alert(1)' }), null);
    assert.equal(Auth.getAvatarUrl(null), null);
  });

  test('getBio 去空白', () => {
    assert.equal(Auth.getBio(full), '签名');
    assert.equal(Auth.getBio({}), '');
    assert.equal(Auth.getBio(null), '');
  });

  test('normalizeProfile 对 null 返回 null', () => {
    assert.equal(Auth.normalizeProfile(null), null);
    assert.equal(Auth.normalizeProfile(full).username, 'nako');
  });
});

describe('调用点依赖的方法', () => {
  test('9 个调用点用到的方法都在', () => {
    for (const name of [
      'login',
      'logout',
      'handleCallback',
      'getUserInfo',
      'getValidAccessToken',
      'isAuthenticated',
      'getDisplayName',
      'getUsername',
      'getAvatarUrl',
      'getBio',
      'normalizeProfile',
    ]) {
      assert.equal(typeof Auth[name], 'function', name);
    }
  });

  test('callback.html 的 handleCallback(code, state)', async () => {
    session.setItem('sekai_auth_state', 'S1');
    session.setItem('sekai_code_verifier', 'V1');
    const calls = stubFetch([{ body: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 } }]);

    await Auth.handleCallback('CODE', 'S1');

    assert.equal(local.getItem('sekai_access_token'), 'AT');
    assert.equal(calls[0].init.body.get('code_verifier'), 'V1');
  });

  test('getUserInfo 未登录时返回 null 而不抛', async () => {
    stubFetch([]);
    assert.equal(await Auth.getUserInfo(), null);
  });
});

describe('login 与 logout', () => {
  test('login 构造 S256 授权 URL，PKCE 机密落 sessionStorage', async () => {
    await Auth.login();
    const url = new URL(redirectedTo);
    assert.equal(url.searchParams.get('client_id'), '25ji_client');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(session.getItem('sekai_code_verifier'));
    assert.equal(local.getItem('sekai_code_verifier'), null);
  });

  test('logout 清空后 reload（迁移前就是 reload，不是跳首页）', async () => {
    local.setItem('sekai_access_token', 'AT');
    stubFetch([{ body: {} }]);

    await Auth.logout();

    assert.equal(local.getItem('sekai_access_token'), null);
    assert.equal(reloaded, 1);
    assert.equal(redirectedTo, '', '不应跳转，hub 才跳首页');
  });
});
