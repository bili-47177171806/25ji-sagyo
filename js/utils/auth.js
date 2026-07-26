// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2025-2026 The 25-ji-code-de Team

// SEKAI Pass OAuth 认证模块
// Aligned with hub/assets/js/auth.js patterns:
// - sessionStorage for PKCE secrets
// - single-flight refresh
// - refresh token keeps isAuthenticated true
(function() {
  'use strict';

  const CONFIG = window.SEKAI_CONFIG;

  class Auth {
    constructor() {
      this.accessTokenKey = 'sekai_access_token';
      this.refreshTokenKey = 'sekai_refresh_token';
      this.tokenExpiresAtKey = 'sekai_token_expires_at';
      this.codeVerifierKey = 'sekai_code_verifier';
      this.stateKey = 'sekai_auth_state';
      /** @type {Promise<boolean>|null} */
      this._refreshPromise = null;
    }

    // Generate a hex string from `byteLength` random bytes.
    // NOTE: the returned string is 2 * byteLength characters long.
    generateRandomString(byteLength) {
      const array = new Uint8Array(byteLength);
      window.crypto.getRandomValues(array);
      return Array.from(array, (dec) => ('0' + dec.toString(16)).slice(-2)).join('');
    }

    // Base64URL encode (chunked — avoids apply arg limits)
    base64UrlEncode(arrayBuffer) {
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    // SHA-256 hash
    async sha256(plain) {
      const encoder = new TextEncoder();
      const data = encoder.encode(plain);
      return await window.crypto.subtle.digest('SHA-256', data);
    }

    // Generate PKCE Challenge
    async generateCodeChallenge(verifier) {
      const hashed = await this.sha256(verifier);
      return this.base64UrlEncode(hashed);
    }

    // Initiate Login — PKCE secrets live in sessionStorage (tab-scoped)
    async login() {
      const state = this.generateRandomString(16);
      // PKCE verifier: 64 random bytes → 128 hex chars (RFC 7636 max length)
      const codeVerifier = this.generateRandomString(64);

      sessionStorage.setItem(this.stateKey, state);
      sessionStorage.setItem(this.codeVerifierKey, codeVerifier);

      const codeChallenge = await this.generateCodeChallenge(codeVerifier);

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: CONFIG.clientId,
        redirect_uri: CONFIG.redirectUri,
        scope: CONFIG.scope,
        state: state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });

      window.location.href = `${CONFIG.authEndpoint}?${params.toString()}`;
    }

    // Handle Callback
    async handleCallback(code, state) {
      const storedState =
        sessionStorage.getItem(this.stateKey) || localStorage.getItem(this.stateKey);
      const codeVerifier =
        sessionStorage.getItem(this.codeVerifierKey) ||
        localStorage.getItem(this.codeVerifierKey);

      if (!state || state !== storedState) {
        throw new Error('Invalid state parameter');
      }
      if (!codeVerifier) {
        throw new Error('Missing PKCE code_verifier');
      }

      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CONFIG.clientId,
        code: code,
        redirect_uri: CONFIG.redirectUri,
        code_verifier: codeVerifier,
      });

      const response = await fetch(CONFIG.tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token exchange failed: ${errorText}`);
      }

      const data = await response.json();

      // Store tokens
      localStorage.setItem(this.accessTokenKey, data.access_token);
      if (data.refresh_token) {
        localStorage.setItem(this.refreshTokenKey, data.refresh_token);
      }

      // Calculate and store expiration time
      const expiresIn = Number(data.expires_in) || 3600;
      const expiresAt = Date.now() + expiresIn * 1000;
      localStorage.setItem(this.tokenExpiresAtKey, String(expiresAt));

      // Clean up PKCE state from both storages (migration-friendly)
      sessionStorage.removeItem(this.stateKey);
      sessionStorage.removeItem(this.codeVerifierKey);
      localStorage.removeItem(this.stateKey);
      localStorage.removeItem(this.codeVerifierKey);

      return data;
    }

    // Get User Info
    async getUserInfo() {
      const token = await this.getValidAccessToken();
      if (!token) return null;

      try {
        const response = await fetch(CONFIG.userInfoEndpoint, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          if (response.status === 401) {
            this.logout();
            return null;
          }
          throw new Error('Failed to fetch user info');
        }

        return await response.json();
      } catch (e) {
        console.error(e);
        return null;
      }
    }

    /**
     * Resolve the display nickname from SEKAI Pass userinfo.
     * Prefer real display name over login username.
     * Priority: display_name → name → preferred_username → username → email
     * (SEKAI Pass userinfo uses display_name/username; OIDC ID Token uses name/preferred_username)
     */
    getDisplayName(userInfo, fallback = 'User') {
      if (!userInfo) return fallback;
      const candidates = [
        userInfo.display_name,
        userInfo.name,
        userInfo.preferred_username,
        userInfo.username,
        userInfo.email,
      ];
      for (const value of candidates) {
        if (typeof value === 'string' && value.trim()) {
          return value.trim();
        }
      }
      return fallback;
    }

    /**
     * Resolve login username (not display name).
     * Priority: preferred_username → username
     */
    getUsername(userInfo, fallback = '') {
      if (!userInfo) return fallback;
      const candidates = [userInfo.preferred_username, userInfo.username];
      for (const value of candidates) {
        if (typeof value === 'string' && value.trim()) {
          return value.trim();
        }
      }
      return fallback;
    }

    /**
     * Avatar URL from OIDC picture / SEKAI Pass avatar_url.
     */
    getAvatarUrl(userInfo) {
      if (!userInfo) return null;
      const candidates = [userInfo.picture, userInfo.avatar_url];
      for (const value of candidates) {
        if (typeof value === 'string' && value.trim()) {
          const url = value.trim();
          if (/^https:\/\//i.test(url)) return url;
        }
      }
      return null;
    }

    /**
     * Personal bio / signature (个性签名).
     */
    getBio(userInfo) {
      if (!userInfo || typeof userInfo.bio !== 'string') return '';
      return userInfo.bio.trim();
    }

    /**
     * Normalize SEKAI Pass / OIDC userinfo into a stable profile object.
     */
    normalizeProfile(userInfo) {
      if (!userInfo) return null;
      return {
        sub: userInfo.sub || userInfo.id || null,
        displayName: this.getDisplayName(userInfo, ''),
        username: this.getUsername(userInfo, ''),
        avatarUrl: this.getAvatarUrl(userInfo),
        bio: this.getBio(userInfo),
      };
    }

    // Get a valid access token, refreshing if necessary
    async getValidAccessToken() {
      const token = localStorage.getItem(this.accessTokenKey);
      const expiresAt = localStorage.getItem(this.tokenExpiresAtKey);

      if (!token) return null;

      // Check if token is expired or will expire in the next 5 minutes
      const now = Date.now();
      const expiryTime = parseInt(expiresAt, 10);

      if (!Number.isFinite(expiryTime) || now >= expiryTime - 5 * 60 * 1000) {
        console.log('Access token expired or expiring soon, refreshing...');
        const refreshed = await this.refreshAccessToken();
        if (!refreshed) {
          return null;
        }
        return localStorage.getItem(this.accessTokenKey);
      }

      return token;
    }

    // Refresh access token using refresh token (single-flight)
    async refreshAccessToken() {
      if (this._refreshPromise) {
        return this._refreshPromise;
      }
      this._refreshPromise = this._doRefreshAccessToken().finally(() => {
        this._refreshPromise = null;
      });
      return this._refreshPromise;
    }

    async _doRefreshAccessToken() {
      const refreshToken = localStorage.getItem(this.refreshTokenKey);
      if (!refreshToken) {
        console.error('No refresh token available');
        return false;
      }

      try {
        const params = new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: CONFIG.clientId,
          refresh_token: refreshToken,
        });

        const response = await fetch(CONFIG.tokenEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params,
        });

        if (!response.ok) {
          console.error('Token refresh failed:', response.status);
          this.logout();
          return false;
        }

        const data = await response.json();

        // Update tokens
        localStorage.setItem(this.accessTokenKey, data.access_token);
        if (data.refresh_token) {
          localStorage.setItem(this.refreshTokenKey, data.refresh_token);
        }

        // Update expiration time
        const expiresIn = Number(data.expires_in) || 3600;
        const expiresAt = Date.now() + expiresIn * 1000;
        localStorage.setItem(this.tokenExpiresAtKey, String(expiresAt));

        console.log('Access token refreshed successfully');
        return true;
      } catch (error) {
        console.error('Error refreshing token:', error);
        this.logout();
        return false;
      }
    }

    isAuthenticated() {
      const token = localStorage.getItem(this.accessTokenKey);
      if (!token) return false;
      const expiresAt = parseInt(localStorage.getItem(this.tokenExpiresAtKey), 10);
      // If we have a refresh token, treat as authenticated even if access expired
      if (localStorage.getItem(this.refreshTokenKey)) return true;
      return Number.isFinite(expiresAt) && Date.now() < expiresAt;
    }

    logout() {
      const access = localStorage.getItem(this.accessTokenKey);
      const refresh = localStorage.getItem(this.refreshTokenKey);
      const revokeUrl = CONFIG.tokenEndpoint.replace(/\/token$/, '/revoke');
      const fire = (token, hint) => {
        if (!token) return;
        try {
          void fetch(revokeUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              token,
              token_type_hint: hint,
              client_id: CONFIG.clientId,
            }),
            keepalive: true,
          }).catch(() => {});
        } catch (_) { /* ignore */ }
      };
      fire(refresh, 'refresh_token');
      fire(access, 'access_token');

      localStorage.removeItem(this.accessTokenKey);
      localStorage.removeItem(this.refreshTokenKey);
      localStorage.removeItem(this.tokenExpiresAtKey);
      localStorage.removeItem(this.stateKey);
      localStorage.removeItem(this.codeVerifierKey);
      sessionStorage.removeItem(this.stateKey);
      sessionStorage.removeItem(this.codeVerifierKey);
      window.location.reload();
    }
  }

  // Export to global
  window.SekaiAuth = new Auth();
})();
