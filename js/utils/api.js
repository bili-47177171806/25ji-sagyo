// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2025-2026 The 25-ji-code-de Team

// SEKAI Gateway API 客户端
// Mirrors hub API.request() pattern for DRY Bearer calls
(function() {
  'use strict';

  const CONFIG = window.SEKAI_CONFIG;
  const Auth = window.SekaiAuth;

  class API {
    /**
     * Shared authenticated JSON request (optional — silent on missing auth for events).
     * @param {string} path
     * @param {RequestInit} [init]
     * @param {{ silentAuth?: boolean }} [opts]
     */
    static async request(path, init = {}, opts = {}) {
      if (!Auth.isAuthenticated()) {
        if (opts.silentAuth) return null;
        throw new Error('Not authenticated');
      }

      const accessToken = await Auth.getValidAccessToken();
      if (!accessToken) {
        if (opts.silentAuth) return null;
        throw new Error('No access token');
      }

      const headers = new Headers(init.headers || {});
      headers.set('Authorization', `Bearer ${accessToken}`);
      if (init.body && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }

      const response = await fetch(`${CONFIG.apiBaseUrl}${path}`, {
        ...init,
        headers,
      });

      if (!response.ok) {
        // Gateway 错误信封为 { error: true, message, details? }
        let detail = `API error: ${response.status}`;
        try {
          const body = await response.json();
          if (body?.message) detail = body.message;
        } catch (_) {
          /* ignore */
        }
        const err = new Error(detail);
        err.status = response.status;
        throw err;
      }

      const text = await response.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }

    /**
     * 上报用户事件
     */
    static async reportEvent(eventType, metadata = {}) {
      try {
        const result = await this.request(
          '/user/events',
          {
            method: 'POST',
            body: JSON.stringify({
              project: '25ji',
              event_type: eventType,
              metadata: metadata,
            }),
          },
          { silentAuth: true },
        );
        if (!result) {
          console.log('Not authenticated, skipping event report');
          return false;
        }
        console.log(`Event reported: ${eventType}`, metadata);
        return true;
      } catch (error) {
        console.error('Error reporting event:', error);
        return false;
      }
    }

    /**
     * 批量上报事件（用于数据迁移）
     */
    static async reportBatch(events) {
      if (!Auth.isAuthenticated()) {
        return false;
      }

      try {
        for (const event of events) {
          await this.reportEvent(event.type, event.metadata);
          // 避免请求过快
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return true;
      } catch (error) {
        console.error('Error reporting batch:', error);
        return false;
      }
    }
  }

  // Export to global
  window.SekaiAPI = API;
})();
