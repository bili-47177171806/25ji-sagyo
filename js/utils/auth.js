// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2025-2026 The 25-ji-code-de Team

// SEKAI Pass 认证 —— 实现已移至 @25-ji-code-de/sekai-auth（Apache-2.0）。
//
// 这个文件此前与 hub/assets/js/auth.js 是近乎逐字相同的两份拷贝，
// nightcord 与 stickers-maker 又各有一份独立实现，四份行为已经开始漂移。
//
// 本文件现在只做三件事：
//   1. 把 window.SEKAI_CONFIG 映射成 SDK 的构造参数
//   2. 锁住 25ji 历史上的 storage key（否则升级会把所有人登出）
//   3. 保留 window.SekaiAuth 的旧方法名，让 9 个调用点无需改动
//
// js/vendor/sekai-auth.global.js 是从上游 tag 原样复制的，请勿手工编辑。
// 必须在本文件之前加载。
(function () {
  'use strict';

  const CONFIG = window.SEKAI_CONFIG;
  const { SekaiAuth, normalizeProfile } = window.SekaiAuthSDK;

  const auth = new SekaiAuth({
    clientId: CONFIG.clientId,
    redirectUri: CONFIG.redirectUri,
    scope: CONFIG.scope,
    endpoints: {
      authorize: CONFIG.authEndpoint,
      token: CONFIG.tokenEndpoint,
      userinfo: CONFIG.userInfoEndpoint,
      // CONFIG 无 revoke；SDK 从 token 端点推导 /oauth/revoke，与迁移前一致
    },
    storagePrefix: 'sekai_',
    // 25ji 历史上用的是这两个非默认名，必须显式对齐，否则升级即登出
    keys: {
      expiresAt: 'sekai_token_expires_at',
      state: 'sekai_auth_state',
    },
  });

  /** 取归一化后的 profile；userInfo 为空时返回一个全空对象，简化下面的 helper。 */
  function profileOf(userInfo) {
    return normalizeProfile(userInfo) || { displayName: '', username: '', avatarUrl: null, bio: '' };
  }

  window.SekaiAuth = {
    /** @returns {Promise<void>} */
    login: () => auth.login(),

    /** @returns {Promise<object>} */
    handleCallback: (code, state) => auth.handleCallback(code, state),

    /**
     * 取有效 access token，必要时自动刷新；失败返回 null。
     * @returns {Promise<string|null>}
     */
    getValidAccessToken: () => auth.getAccessToken(),

    /** @returns {Promise<object|null>} 未登录或失败返回 null */
    getUserInfo: () => auth.getUserInfo(),

    /** @returns {boolean} */
    isAuthenticated: () => auth.isAuthenticated(),

    /** 登出后刷新当前页，与迁移前行为一致（hub 是跳首页，这里是 reload）。 */
    logout: () => auth.logout().then(() => window.location.reload()),

    /**
     * 展示用昵称。
     * 优先级 display_name → name → preferred_username → username → email。
     * @param {object|null} userInfo
     * @param {string} [fallback]
     */
    getDisplayName: (userInfo, fallback = 'User') => profileOf(userInfo).displayName || fallback,

    /**
     * 登录名（不是昵称）。preferred_username → username。
     * @param {object|null} userInfo
     * @param {string} [fallback]
     */
    getUsername: (userInfo, fallback = '') => profileOf(userInfo).username || fallback,

    /** 头像 URL；非 https 一律返回 null。 */
    getAvatarUrl: (userInfo) => profileOf(userInfo).avatarUrl,

    /** 个性签名。 */
    getBio: (userInfo) => profileOf(userInfo).bio,

    /** 归一化 SEKAI Pass / OIDC 的字段差异。 */
    normalizeProfile: (userInfo) => normalizeProfile(userInfo),

    /** 底层 SDK 实例，供需要新能力时直接使用。 */
    sdk: auth,
  };
})();
