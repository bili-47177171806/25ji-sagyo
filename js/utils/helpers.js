// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2025-2026 The 25-ji-code-de Team

// js/utils/helpers.js
// 通用辅助函数

(function() {
  'use strict';

  /**
   * 格式化时间为 HH:MM:SS 或 MM:SS
   * @param {number} seconds - 秒数
   * @param {boolean} [showHours=false] - 是否显示小时
   * @returns {string}
   */
  function formatTimeSeconds(seconds, showHours = false) {
    if (!isFinite(seconds) || seconds < 0) return showHours ? '0:00:00' : '0:00';
    
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (showHours || hrs > 0) {
      return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  /**
   * 格式化 Date 对象为本地时间字符串
   * @param {Date} date
   * @returns {string}
   */
  function formatTime(date) {
    return date.toLocaleTimeString();
  }

  /**
   * HTML 转义
   * @param {string} text
   * @returns {string}
   */
  function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    // 原本用 div.textContent → innerHTML 的写法，只转义 < > &，**不转义引号**。
    // 元素上下文够用，但插进 value="…" / onclick="…" 这类属性时会被闭合。
    // 这里改成显式转义五个字符，两种上下文都安全。
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * 防抖函数
   * @param {Function} func
   * @param {number} wait
   * @returns {Function}
   */
  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  /**
   * 节流函数
   * @param {Function} func
   * @param {number} limit
   * @returns {Function}
   */
  function throttle(func, limit) {
    let inThrottle;
    return function(...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  }

  /**
   * RGB 转 HSL
   * @param {number} r - 0-255
   * @param {number} g - 0-255
   * @param {number} b - 0-255
   * @returns {{h: number, s: number, l: number}}
   */
  function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;

    if (max === min) {
      h = s = 0;
    } else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }

    return {
      h: h * 360,
      s: s * 100,
      l: l * 100
    };
  }

  /**
   * 通用视频 Seek 工具：处理 duration 溢出、seeked 事件监听、readyState 兼容
   * @param {HTMLVideoElement} video - 视频元素
   * @param {number} offsetSeconds - 目标位置（秒）
   * @returns {Promise<void>}
   */
  function seekVideo(video, offsetSeconds) {
    return new Promise((resolve) => {
      let targetOffset = offsetSeconds;
      try {
        if (video.duration && targetOffset > video.duration) {
          targetOffset = targetOffset % video.duration;
        }
      } catch (e) {}

      function onSeeked() {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      }

      video.addEventListener('seeked', onSeeked);
      try {
        if (isFinite(targetOffset)) {
          video.currentTime = Math.max(0, targetOffset);
        }
      } catch (err) {
        setTimeout(() => {
          try {
            if (isFinite(targetOffset)) {
              video.currentTime = Math.max(0, targetOffset);
            }
          } catch (e) {}
        }, 300);
      }
    });
  }

  /**
   * 等待视频 metadata 加载完成后执行 Seek
   * @param {HTMLVideoElement} video - 视频元素
   * @param {number} offsetSeconds - 目标位置（秒）
   * @param {boolean} [autoPlay=false] - seek 后是否自动播放
   * @returns {Promise<void>}
   */
  function seekVideoWhenReady(video, offsetSeconds, autoPlay = false) {
    const doSeek = () => {
      const p = seekVideo(video, offsetSeconds);
      if (autoPlay) video.play().catch(() => {});
      return p;
    };

    if (video.readyState >= 1) {
      return doSeek();
    }
    return new Promise((resolve) => {
      video.addEventListener('loadedmetadata', function onMeta() {
        video.removeEventListener('loadedmetadata', onMeta);
        doSeek().then(resolve);
      });
    });
  }

  // 导出到全局命名空间
  window.AppHelpers = {
    formatTimeSeconds,
    formatTime,
    escapeHtml,
    debounce,
    throttle,
    rgbToHsl,
    seekVideo,
    seekVideoWhenReady
  };
})();
