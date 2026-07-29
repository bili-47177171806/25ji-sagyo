// @sekai-vendor @25-ji-code-de/sekai-auth@v0.2.0 dist/sekai-auth.global.js
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
 * ID Token 允许的签名算法白名单。
 *
 * 只收非对称算法。`alg: none` 与任何 HMAC 算法都不在表里，
 * 于是「把 JWKS 公钥当 HMAC 密钥」的经典伪造攻击直接不成立。
 * sekai-pass 签 ID Token 用的是 ES256。
 */
const ID_TOKEN_ALGS = {
  __proto__: null,
  ES256: {
    importParams: { name: 'ECDSA', namedCurve: 'P-256' },
    verifyParams: { name: 'ECDSA', hash: { name: 'SHA-256' } },
  },
  RS256: {
    importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    verifyParams: { name: 'RSASSA-PKCS1-v1_5' },
  },
};

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
  nonce: 'nonce',
};

/**
 * 解码 JWT 的 payload —— **不验签**。
 *
 * 只用于读取 claim。任何安全判断都必须建立在 {@link SekaiAuth#validateIdToken}
 * 的验签之上，不能只看这里的返回值。
 * @param {string} token
 * @returns {object|null}
 */
function decodeJwtPayload(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** base64url → ArrayBuffer。 */
function base64UrlDecode(str) {
  const padded = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer;
}

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
   * @param {typeof fetch} [options.fetch] HTTP transport；默认调用 `globalThis.fetch`
   * @param {(url: string) => void|Promise<void>} [options.navigate]
   *        授权页导航；默认写入 `globalThis.location.href`
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

    // Transport hooks：native shell / 测试可注入。不传时与旧行为逐字一致。
    // 默认路径在**调用时**再取 globalThis.fetch / location —— 不能在构造时 bind，
    // 否则测试（以及运行时替换 polyfill）改了全局也接不上。
    this._fetch =
      options.fetch ??
      ((...args) => globalThis.fetch(...args));
    this._navigate =
      options.navigate ??
      ((url) => {
        globalThis.location.href = url;
      });

    /** @type {Promise<string|null>|null} single-flight refresh */
    this._refreshPromise = null;
    /** @type {Promise<object[]>|null} JWKS 缓存 */
    this._jwksPromise = null;
  }

  /** 本次配置的 scope 是否是 OIDC 请求（含 openid）。 */
  isOidcRequest() {
    return String(this.scope).split(/\s+/).includes('openid');
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
      const response = await this._fetch(url);
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
      jwks: doc.jwks_uri,
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

    // OIDC nonce：把 ID Token 绑定到本次授权请求，防止别处签发的 ID Token
    // 被注入进来。只有请求 openid scope 时才有意义。
    if (this.isOidcRequest()) {
      const nonce = randomHex(16);
      this._session.setItem(this.keys.nonce, nonce);
      params.set('nonce', nonce);
    } else {
      this._session.removeItem(this.keys.nonce);
    }

    await this._navigate(`${endpoints.authorize}?${params.toString()}`);
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

    // 先取出本次流程存下的 nonce。ID Token 必须在落盘 token 之前验完：
    // 否则验签失败会把攻击者提供的 access/refresh token 留在本地。
    const expectedNonce = this._session.getItem(this.keys.nonce);

    try {
      // 拿到 ID Token 就必须验 —— 否则 nonce 只是走了个过场
      if (tokens.id_token) {
        await this.validateIdToken(tokens.id_token, { nonce: expectedNonce });
      }
      this._persistTokens(tokens);
      return tokens;
    } finally {
      // 成功失败都作废 PKCE 临时状态，防止回放。
      this._clearPkce();
    }
  }

  /**
   * 验证 ID Token：签名 + iss / aud / exp / nonce。
   *
   * 签名用 issuer 的 JWKS 验（走 discovery 的 `jwks_uri`，没有就按
   * `<issuer>/.well-known/jwks.json` 推）。**不验签的 nonce 校验没有意义** ——
   * 能注入 token 的攻击者同样能伪造 nonce，所以这两步必须一起做。
   *
   * @param {string} idToken
   * @param {{nonce?: string|null, clockSkewSec?: number}} [options]
   * @returns {Promise<object>} 验证通过的 claim
   * @throws {SekaiAuthError} 任何一项不通过
   */
  async validateIdToken(idToken, options = {}) {
    const { nonce = null, clockSkewSec = 60 } = options;

    const parts = String(idToken).split('.');
    if (parts.length !== 3) {
      throw new SekaiAuthError('ID token is malformed', { code: 'invalid_id_token' });
    }

    const claims = decodeJwtPayload(idToken);
    if (!claims) {
      throw new SekaiAuthError('ID token payload is not valid JSON', {
        code: 'invalid_id_token',
      });
    }

    let header;
    try {
      header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    } catch {
      throw new SekaiAuthError('ID token header is not valid JSON', {
        code: 'invalid_id_token',
      });
    }

    await this._verifyIdTokenSignature(idToken, header);

    // iss：必须是配置的 issuer（走 discovery 时就是它；显式端点时从 authorize 推）
    const expectedIssuer = this.issuer ?? this._issuerFromEndpoints();
    if (expectedIssuer && claims.iss !== expectedIssuer.replace(/\/$/, '')) {
      throw new SekaiAuthError(
        `ID token issuer mismatch: ${claims.iss}`,
        { code: 'invalid_id_token' },
      );
    }

    // sub：用户身份本身。缺了它，调用方拿到的是 `claims.sub === undefined` ——
    // 而应用通常拿 sub 当主键，于是所有缺 sub 的 token 都映射到**同一个**用户。
    // OIDC Core §2 把它列为 REQUIRED。
    if (typeof claims.sub !== 'string' || claims.sub === '') {
      throw new SekaiAuthError('ID token is missing sub', { code: 'invalid_id_token' });
    }

    // aud：必须包含本 client
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(this.clientId)) {
      throw new SekaiAuthError('ID token audience does not include this client', {
        code: 'invalid_id_token',
      });
    }

    /*
     * azp（authorized party）—— OIDC Core §3.1.3.7。
     *
     * `aud` 只说明「这个 token 可以被谁接受」，`azp` 说明「它是为谁签的」。
     * 两者不同时，一个签给**别的客户端**、只是顺带把我们列进 aud 的 token，
     * 在只查 aud 的实现里会被当成「这个用户在我们这里登录了」。
     *
     * 规范：多 aud 时 SHOULD 验 azp 存在；azp 存在时 SHOULD 验它等于自己的
     * client_id。这里两条都做成硬性检查 —— 这是个给别人用的 SDK，
     * 「SHOULD」在这种位置上没有放宽的理由。
     */
    if (claims.azp !== undefined && claims.azp !== this.clientId) {
      throw new SekaiAuthError(
        `ID token azp is another client: ${claims.azp}`,
        { code: 'invalid_id_token' },
      );
    }
    if (audiences.length > 1 && claims.azp === undefined) {
      throw new SekaiAuthError(
        'ID token has multiple audiences but no azp',
        { code: 'invalid_id_token' },
      );
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + clockSkewSec < now) {
      throw new SekaiAuthError('ID token has expired', { code: 'invalid_id_token' });
    }
    // iat 是 REQUIRED（§2）。此前只在它**存在**时检查「不能是未来」——
    // 于是干脆不带 iat 的 token 一路畅通。
    if (typeof claims.iat !== 'number') {
      throw new SekaiAuthError('ID token is missing iat', { code: 'invalid_id_token' });
    }
    if (claims.iat - clockSkewSec > now) {
      throw new SekaiAuthError('ID token was issued in the future', {
        code: 'invalid_id_token',
      });
    }

    // nonce：发过就必须对得上
    if (nonce) {
      if (claims.nonce !== nonce) {
        throw new SekaiAuthError('ID token nonce mismatch — possible token injection', {
          code: 'invalid_id_token',
        });
      }
    }

    return claims;
  }

  /** 从显式配置的 authorize 端点推出 issuer（`…/oauth/authorize` → `…`）。 */
  _issuerFromEndpoints() {
    if (!this._endpoints?.authorize) return null;
    try {
      const url = new URL(this._endpoints.authorize);
      return url.origin;
    } catch {
      return null;
    }
  }

  /** 用 issuer 的 JWKS 验 ID Token 的签名。 */
  async _verifyIdTokenSignature(idToken, header) {
    // 算法白名单先判，早于任何网络请求。
    // 明确只支持这两种非对称算法：`alg: none` 与对称算法一律拒绝 ——
    // 后者会让「把 JWKS 里的公钥当成 HMAC 密钥」的经典攻击成立。
    if (!ID_TOKEN_ALGS[header.alg]) {
      throw new SekaiAuthError(`Unsupported ID token algorithm: ${header.alg ?? 'none'}`, {
        code: 'invalid_id_token',
      });
    }

    const jwks = await this._fetchJwks();
    const key = jwks.find(
      (k) => (!header.kid || k.kid === header.kid) && (!header.alg || !k.alg || k.alg === header.alg),
    );
    if (!key) {
      throw new SekaiAuthError(
        `No JWKS key matches ID token header (kid=${header.kid ?? 'none'})`,
        { code: 'invalid_id_token' },
      );
    }

    const { importParams, verifyParams } = ID_TOKEN_ALGS[header.alg];

    let publicKey;
    try {
      publicKey = await crypto.subtle.importKey('jwk', key, importParams, false, ['verify']);
    } catch (err) {
      throw new SekaiAuthError(`Cannot import JWKS key: ${err?.message ?? err}`, {
        code: 'invalid_id_token',
        cause: err,
      });
    }

    const parts = String(idToken).split('.');
    const ok = await crypto.subtle.verify(
      verifyParams,
      publicKey,
      base64UrlDecode(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!ok) {
      throw new SekaiAuthError('ID token signature is invalid', { code: 'invalid_id_token' });
    }
  }

  /** 取 JWKS 并缓存（签名密钥会轮换，但一次会话内不必重复拉）。 */
  async _fetchJwks() {
    if (this._jwksPromise) return this._jwksPromise;

    this._jwksPromise = (async () => {
      const endpoints = await this.getEndpoints();
      const uri =
        endpoints.jwks ??
        (this.issuer ? `${this.issuer.replace(/\/$/, '')}/.well-known/jwks.json` : null) ??
        (this._issuerFromEndpoints()
          ? `${this._issuerFromEndpoints()}/.well-known/jwks.json`
          : null);

      if (!uri) {
        throw new SekaiAuthError('Cannot determine jwks_uri for ID token validation', {
          code: 'invalid_config',
        });
      }

      const response = await this._fetch(uri);
      if (!response.ok) {
        throw new SekaiAuthError(`JWKS fetch failed: HTTP ${response.status}`, {
          code: 'jwks_failed',
          status: response.status,
        });
      }
      const doc = await response.json();
      if (!Array.isArray(doc?.keys)) {
        throw new SekaiAuthError('JWKS document has no keys array', { code: 'jwks_failed' });
      }
      return doc.keys;
    })().catch((err) => {
      // 失败不缓存，下次可重试
      this._jwksPromise = null;
      throw err;
    });

    return this._jwksPromise;
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
      response = await this._fetch(url, {
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
      const response = await this._fetch(endpoints.userinfo, {
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
            void this._fetch(url, {
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
    if (redirectTo) await this._navigate(redirectTo);
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
    if (includeVerifier) {
      this._session.removeItem(this.keys.codeVerifier);
      this._session.removeItem(this.keys.nonce);
    }
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
  const SekaiAuthSDK = { REFRESH_SKEW_MS, DEFAULT_EXPIRES_IN_S, randomHex, base64UrlEncode, computeCodeChallenge, normalizeProfile, SekaiAuthError, SekaiAuth, createSekaiAuth, SEKAI_PASS_ENDPOINTS, SEKAI_PASS_ISSUER, decodeJwtPayload };
  global.SekaiAuthSDK = SekaiAuthSDK;
  // 兼容旧的全局名：nightcord 过去用 window.SekaiPassAuth 作为构造器
  global.SekaiPassAuth = SekaiAuth;
})(typeof globalThis !== 'undefined' ? globalThis : self);
