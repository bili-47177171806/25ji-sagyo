// @sekai-vendor @25-ji-code-de/sekai-auth@v0.1.2 dist/sekai-auth.global.js
//
// 从上游仓库原样复制，请勿手工编辑。
// 25ji 没有构建步骤且全部脚本以经典 <script> 同步加载，所以用 IIFE 产物。
// CI 会校验本文件与上游 tag 逐字一致。
// 上游：https://github.com/25-ji-code-de/sekai-auth

(function (global) {
'use strict';
/*
 * Copyright 2026 The 25-ji-code-de Team
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @25-ji-code-de/sekai-auth — SEKAI Pass 浏览器端 OAuth 2.1 + PKCE 客户端。
 *
 * 取代 hub / 25ji-sagyo / nightcord / stickers-maker 中四份各自漂移的实现。
 * 零依赖，只用 WebCrypto + fetch。
 */

/** 提前多久刷新 access token（生态约定：5 分钟）。 */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** expires_in 缺省时按 1 小时处理（生态约定）。 */
const DEFAULT_EXPIRES_IN_S = 3600;

/**
 * 从 `byteLength` 个随机字节生成 hex 串。
 * 注意返回长度是 `2 * byteLength` 个字符。
 * @param {number} byteLength
 * @returns {string}
 */
function randomHex(byteLength) {
  const array = new Uint8Array(byteLength);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Base64URL 编码。分块处理以避开 `String.fromCharCode.apply` 的参数上限。
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {string}
 */
function base64UrlEncode(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 由 code_verifier 计算 S256 code_challenge。
 * @param {string} verifier
 * @returns {Promise<string>}
 */
async function computeCodeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
}

/**
 * 把 SEKAI Pass userinfo / OIDC ID Token claim 归一成稳定的 profile 对象。
 *
 * SEKAI Pass 的 userinfo 用 `display_name` / `username` / `avatar_url`；
 * 标准 OIDC 用 `name` / `preferred_username` / `picture`。两边都认。
 *
 * @param {object|null} userInfo
 * @returns {{sub: string|null, displayName: string, username: string, avatarUrl: string|null, bio: string}|null}
 */
function normalizeProfile(userInfo) {
  if (!userInfo) return null;
  const firstString = (...candidates) => {
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };
  const avatar = firstString(userInfo.picture, userInfo.avatar_url);
  return {
    sub: userInfo.sub || userInfo.id || null,
    displayName: firstString(
      userInfo.display_name,
      userInfo.name,
      userInfo.preferred_username,
      userInfo.username,
      userInfo.email,
    ),
    username: firstString(userInfo.preferred_username, userInfo.username),
    // 只接受 https，避免 userinfo 被污染时注入 javascript: / data:
    avatarUrl: /^https:\/\//i.test(avatar) ? avatar : null,
    bio: firstString(userInfo.bio),
  };
}

/** OAuth / 网络错误的统一异常类型。 */
class SekaiAuthError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, status?: number, cause?: unknown}} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'SekaiAuthError';
    this.code = options.code || 'auth_error';
    this.status = options.status;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

const DEFAULT_KEY_SUFFIXES = {
  accessToken: 'access_token',
  refreshToken: 'refresh_token',
  expiresAt: 'expires_at',
  user: 'user',
  codeVerifier: 'code_verifier',
  state: 'state',
};

/**
 * SEKAI Pass OAuth 2.1 + PKCE 客户端。
 *
 * 端点有两种给法，二选一：
 *  - `endpoints`：显式给出 authorize / token / userinfo（可选 revoke）
 *  - `issuer`：走 OIDC discovery（`/.well-known/openid-configuration`），结果会缓存
 */
class SekaiAuth {
  /**
   * @param {object} options
   * @param {string} options.clientId
   * @param {string} [options.redirectUri] 默认 `${location.origin}/callback`
   * @param {string} [options.scope] 默认 `openid profile email`
   * @param {{authorize: string, token: string, userinfo: string, revoke?: string}} [options.endpoints]
   * @param {string} [options.issuer] 走 OIDC discovery 时的 issuer
   * @param {string} [options.storagePrefix] 默认 `sekai_`
   * @param {Partial<typeof DEFAULT_KEY_SUFFIXES>} [options.keys]
   *        逐个覆盖 storage key 后缀。用于对齐既有部署、避免升级后把用户登出。
   * @param {() => void} [options.onAuthExpired] refresh token 失效时触发
   * @param {Storage} [options.localStorage]
   * @param {Storage} [options.sessionStorage]
   */
  constructor(options = {}) {
    if (!options.clientId) {
      throw new SekaiAuthError('clientId is required', { code: 'invalid_config' });
    }
    if (!options.endpoints && !options.issuer) {
      throw new SekaiAuthError('either `endpoints` or `issuer` is required', {
        code: 'invalid_config',
      });
    }

    this.clientId = options.clientId;
    this.redirectUri = options.redirectUri || `${globalThis.location?.origin ?? ''}/callback`;
    this.scope = options.scope || 'openid profile email';
    this.issuer = options.issuer;
    this.onAuthExpired = options.onAuthExpired;

    this._endpoints = options.endpoints ? { ...options.endpoints } : null;
    this._discoveryPromise = null;

    const prefix = options.storagePrefix ?? 'sekai_';
    /** @type {Record<keyof typeof DEFAULT_KEY_SUFFIXES, string>} */
    this.keys = {};
    for (const [name, suffix] of Object.entries(DEFAULT_KEY_SUFFIXES)) {
      this.keys[name] = options.keys?.[name] ?? `${prefix}${suffix}`;
    }

    this._local = options.localStorage ?? globalThis.localStorage;
    this._session = options.sessionStorage ?? globalThis.sessionStorage;

    /** @type {Promise<string|null>|null} single-flight refresh */
    this._refreshPromise = null;
  }

  // ---------------------------------------------------------------- endpoints

  /**
   * 解析端点。给了 `endpoints` 就直接用；否则做一次 OIDC discovery 并缓存。
   * @returns {Promise<{authorize: string, token: string, userinfo: string, revoke?: string}>}
   */
  async getEndpoints() {
    if (this._endpoints) return this._endpoints;
    if (!this._discoveryPromise) {
      this._discoveryPromise = this._discover().catch((err) => {
        // 失败不缓存，下次调用可以重试
        this._discoveryPromise = null;
        throw err;
      });
    }
    return this._discoveryPromise;
  }

  async _discover() {
    const url = `${this.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    let doc;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new SekaiAuthError(`OIDC discovery failed: HTTP ${response.status}`, {
          code: 'discovery_failed',
          status: response.status,
        });
      }
      doc = await response.json();
    } catch (err) {
      if (err instanceof SekaiAuthError) throw err;
      throw new SekaiAuthError(`OIDC discovery failed: ${err?.message ?? err}`, {
        code: 'discovery_failed',
        cause: err,
      });
    }

    if (!doc.authorization_endpoint || !doc.token_endpoint) {
      throw new SekaiAuthError('OIDC discovery document is missing required endpoints', {
        code: 'discovery_failed',
      });
    }

    this._endpoints = {
      authorize: doc.authorization_endpoint,
      token: doc.token_endpoint,
      userinfo: doc.userinfo_endpoint,
      revoke: doc.revocation_endpoint,
    };
    return this._endpoints;
  }

  /**
   * revoke 端点：优先用 discovery / 显式配置给的，否则从 token 端点推。
   * @param {{token: string, revoke?: string}} endpoints
   * @returns {string}
   */
  _revokeUrl(endpoints) {
    return endpoints.revoke || endpoints.token.replace(/\/token$/, '/revoke');
  }

  // -------------------------------------------------------------------- login

  /**
   * 发起授权：生成 PKCE 参数、存进 sessionStorage（标签页作用域）、跳转到授权端点。
   * @returns {Promise<void>}
   */
  async login() {
    const endpoints = await this.getEndpoints();

    // 64 字节 → 128 hex 字符，正好是 RFC 7636 允许的 code_verifier 上限
    const codeVerifier = randomHex(64);
    const state = randomHex(16);

    this._session.setItem(this.keys.codeVerifier, codeVerifier);
    this._session.setItem(this.keys.state, state);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: this.scope,
      state,
      code_challenge: await computeCodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });

    globalThis.location.href = `${endpoints.authorize}?${params.toString()}`;
  }

  /**
   * 处理授权回调，用 code 换 token。
   *
   * 不传参时从 `location.search` 读取 code / state / error。
   *
   * @param {string} [code]
   * @param {string} [state]
   * @returns {Promise<object>} token 端点返回的原始响应体
   */
  async handleCallback(code, state) {
    if (code === undefined || state === undefined) {
      const search = new URLSearchParams(globalThis.location?.search ?? '');
      const error = search.get('error');
      if (error) {
        this._clearPkce();
        throw new SekaiAuthError(search.get('error_description') || error, { code: error });
      }
      code = code ?? search.get('code');
      state = state ?? search.get('state');
    }

    const expectedState = this._session.getItem(this.keys.state);
    // state 是一次性的：读出来就立刻作废，防止回放
    this._clearPkce(false);

    if (!state || !expectedState || state !== expectedState) {
      this._clearPkce();
      throw new SekaiAuthError('Invalid state parameter — possible CSRF', {
        code: 'invalid_state',
      });
    }
    if (!code) {
      this._clearPkce();
      throw new SekaiAuthError('Missing authorization code', { code: 'invalid_request' });
    }

    const codeVerifier = this._session.getItem(this.keys.codeVerifier);
    if (!codeVerifier) {
      this._clearPkce();
      throw new SekaiAuthError('Missing PKCE code_verifier', { code: 'invalid_request' });
    }

    const endpoints = await this.getEndpoints();
    const tokens = await this._postToken(endpoints.token, {
      grant_type: 'authorization_code',
      client_id: this.clientId,
      code,
      redirect_uri: this.redirectUri,
      code_verifier: codeVerifier,
    });

    this._persistTokens(tokens);
    this._clearPkce();
    return tokens;
  }

  // ------------------------------------------------------------------- tokens

  /**
   * 拿一个当前有效的 access token，必要时自动刷新。
   *
   * 没有 token、或刷新失败时返回 `null`（不抛异常）——调用方据此引导重新登录。
   * @returns {Promise<string|null>}
   */
  async getAccessToken() {
    const token = this._local.getItem(this.keys.accessToken);
    if (!token) return null;

    const expiresAt = Number.parseInt(this._local.getItem(this.keys.expiresAt) ?? '', 10);
    const stale = !Number.isFinite(expiresAt) || Date.now() >= expiresAt - REFRESH_SKEW_MS;
    if (!stale) return token;

    return this.refresh();
  }

  /**
   * 用 refresh token 换新的 access token。并发调用共享同一个请求（single-flight）。
   * @returns {Promise<string|null>} 新的 access token；失败返回 `null`
   */
  async refresh() {
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = this._doRefresh().finally(() => {
      this._refreshPromise = null;
    });
    return this._refreshPromise;
  }

  async _doRefresh() {
    const refreshToken = this._local.getItem(this.keys.refreshToken);
    if (!refreshToken) {
      this._clearTokens();
      return null;
    }

    try {
      const endpoints = await this.getEndpoints();
      const tokens = await this._postToken(endpoints.token, {
        grant_type: 'refresh_token',
        client_id: this.clientId,
        refresh_token: refreshToken,
      });
      this._persistTokens(tokens);
      return tokens.access_token;
    } catch (err) {
      // refresh 失败即认为会话结束：清干净并通知调用方
      this._clearTokens();
      this.onAuthExpired?.(err);
      return null;
    }
  }

  /**
   * @param {string} url
   * @param {Record<string, string>} body
   * @returns {Promise<object>}
   */
  async _postToken(url, body) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
      });
    } catch (err) {
      throw new SekaiAuthError(`Token request failed: ${err?.message ?? err}`, {
        code: 'network_error',
        cause: err,
      });
    }

    if (!response.ok) {
      let code = 'token_request_failed';
      let description = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        if (body?.error) code = body.error;
        if (body?.error_description) description = body.error_description;
      } catch {
        /* 响应体不是 JSON，保留 HTTP 状态描述 */
      }
      throw new SekaiAuthError(`Token request failed: ${description}`, {
        code,
        status: response.status,
      });
    }

    return response.json();
  }

  /** @param {object} tokens token 端点响应 */
  _persistTokens(tokens) {
    if (!tokens?.access_token) {
      throw new SekaiAuthError('Token response is missing access_token', {
        code: 'invalid_token_response',
      });
    }
    this._local.setItem(this.keys.accessToken, tokens.access_token);
    // OAuth 2.1 允许 refresh token 轮换；没下发就保留原来的
    if (tokens.refresh_token) {
      this._local.setItem(this.keys.refreshToken, tokens.refresh_token);
    }
    const expiresIn = Number(tokens.expires_in) || DEFAULT_EXPIRES_IN_S;
    this._local.setItem(this.keys.expiresAt, String(Date.now() + expiresIn * 1000));
  }

  // --------------------------------------------------------------------- user

  /**
   * 取 userinfo。会先确保 access token 有效。
   * @param {{cache?: boolean}} [options] `cache` 为 true 时把结果写入 localStorage
   * @returns {Promise<object|null>} 未登录或请求失败时返回 `null`
   */
  async getUserInfo(options = {}) {
    const token = await this.getAccessToken();
    if (!token) return null;

    const endpoints = await this.getEndpoints();
    if (!endpoints.userinfo) {
      throw new SekaiAuthError('No userinfo endpoint configured', { code: 'invalid_config' });
    }

    try {
      const response = await fetch(endpoints.userinfo, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        // 401 说明服务端已经不认这个 token，本地状态没有保留价值
        if (response.status === 401) this._clearTokens();
        return null;
      }
      const userInfo = await response.json();
      if (options.cache) {
        this._local.setItem(this.keys.user, JSON.stringify(userInfo));
      }
      return userInfo;
    } catch {
      return null;
    }
  }

  /**
   * 读取 `getUserInfo({ cache: true })` 缓存下来的用户信息，不发请求。
   * @returns {object|null}
   */
  getCachedUser() {
    const raw = this._local.getItem(this.keys.user);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * 归一化后的 profile。见 {@link normalizeProfile}。
   * @param {object|null} userInfo
   */
  normalizeProfile(userInfo) {
    return normalizeProfile(userInfo);
  }

  // -------------------------------------------------------------------- state

  /**
   * 是否处于已登录状态。
   *
   * 有 refresh token 时即使 access token 过期也算已登录——它可以静默续期。
   * 这是纯本地判断，不发网络请求。
   * @returns {boolean}
   */
  isAuthenticated() {
    if (!this._local.getItem(this.keys.accessToken)) return false;
    if (this._local.getItem(this.keys.refreshToken)) return true;
    const expiresAt = Number.parseInt(this._local.getItem(this.keys.expiresAt) ?? '', 10);
    return Number.isFinite(expiresAt) && Date.now() < expiresAt;
  }

  /**
   * 登出：尽力向服务端撤销 token（RFC 7009），然后清空本地状态。
   *
   * 撤销请求是 fire-and-forget（`keepalive`），不阻塞跳转。
   * @param {{redirectTo?: string, revoke?: boolean}} [options]
   *        `redirectTo` 给了就跳转；`revoke` 默认 true
   * @returns {Promise<void>}
   */
  async logout(options = {}) {
    const { redirectTo, revoke = true } = options;
    const accessToken = this._local.getItem(this.keys.accessToken);
    const refreshToken = this._local.getItem(this.keys.refreshToken);

    if (revoke && (accessToken || refreshToken)) {
      try {
        const endpoints = await this.getEndpoints();
        const url = this._revokeUrl(endpoints);
        const fire = (token, hint) => {
          if (!token) return;
          try {
            void fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                token,
                token_type_hint: hint,
                client_id: this.clientId,
              }),
              keepalive: true,
            }).catch(() => {});
          } catch {
            /* 撤销失败不影响本地登出 */
          }
        };
        fire(refreshToken, 'refresh_token');
        fire(accessToken, 'access_token');
      } catch {
        /* 端点解析失败也照样本地登出 */
      }
    }

    this._clearTokens();
    if (redirectTo) globalThis.location.href = redirectTo;
  }

  /** 清空 token 与缓存的用户信息，但不动正在进行的 PKCE 流程。 */
  _clearTokens() {
    this._local.removeItem(this.keys.accessToken);
    this._local.removeItem(this.keys.refreshToken);
    this._local.removeItem(this.keys.expiresAt);
    this._local.removeItem(this.keys.user);
  }

  /**
   * 清掉 PKCE 临时状态。
   * @param {boolean} [includeVerifier] 为 false 时只作废 state，保留 verifier
   */
  _clearPkce(includeVerifier = true) {
    this._session.removeItem(this.keys.state);
    if (includeVerifier) this._session.removeItem(this.keys.codeVerifier);
  }
}

/**
 * 工厂函数。等价于 `new SekaiAuth(options)`。
 * @param {ConstructorParameters<typeof SekaiAuth>[0]} options
 * @returns {SekaiAuth}
 */
function createSekaiAuth(options) {
  return new SekaiAuth(options);
}

/** SEKAI Pass 生产环境端点。 */
const SEKAI_PASS_ENDPOINTS = Object.freeze({
  authorize: 'https://id.nightcord.de5.net/oauth/authorize',
  token: 'https://id.nightcord.de5.net/oauth/token',
  userinfo: 'https://id.nightcord.de5.net/oauth/userinfo',
  revoke: 'https://id.nightcord.de5.net/oauth/revoke',
});

const SEKAI_PASS_ISSUER = 'https://id.nightcord.de5.net';



  // --- IIFE bundle footer (generated by scripts/build.mjs) ---
  const SekaiAuthSDK = { REFRESH_SKEW_MS, DEFAULT_EXPIRES_IN_S, randomHex, base64UrlEncode, computeCodeChallenge, normalizeProfile, SekaiAuthError, SekaiAuth, createSekaiAuth, SEKAI_PASS_ENDPOINTS, SEKAI_PASS_ISSUER };
  global.SekaiAuthSDK = SekaiAuthSDK;
  // 兼容旧的全局名：nightcord 过去用 window.SekaiPassAuth 作为构造器
  global.SekaiPassAuth = SekaiAuth;
})(typeof globalThis !== 'undefined' ? globalThis : self);
