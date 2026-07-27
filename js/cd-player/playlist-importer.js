// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2025-2026 The 25-ji-code-de Team

/**
 * Playlist Importer Module
 * Handles importing playlists from online music services (Netease, QQ Music)
 */

import { state } from './constants.js';
import { saveImportedMusicBatch } from './local-music-db.js';

// API endpoints
const APIS = [
  'https://api.injahow.cn/meting/',
  'https://api.hoshiroko.com/meting/'
];

// Server names
const SERVER_NAMES = {
  netease: '网易云音乐',
  tencent: 'QQ音乐'
};

/**
 * Parse playlist input (URL or ID)
 * @param {string} input - User input
 * @param {string} server - Server type (netease/tencent)
 * @returns {string|null} Playlist ID or null if invalid
 */
export function parsePlaylistInput(input, server) {
  input = input.trim();

  if (!input) return null;

  // If it's just a number, assume it's a playlist ID
  if (/^\d+$/.test(input)) {
    return input;
  }

  // Parse Netease URL
  if (server === 'netease') {
    // https://music.163.com/#/playlist?id=2619366284
    const neteaseMatch = input.match(/playlist\?id=(\d+)/);
    if (neteaseMatch) return neteaseMatch[1];
  }

  // Parse QQ Music URL
  if (server === 'tencent') {
    // https://y.qq.com/n/ryqq/playlist/8666627396
    const qqMatch = input.match(/playlist\/(\d+)/);
    if (qqMatch) return qqMatch[1];
  }

  return null;
}

/**
 * Fetch playlist with fallback to backup API
 * @param {string} server - Server type (netease/tencent)
 * @param {string} id - Playlist ID
 * @returns {Promise<Array>} Track list
 */
export async function fetchPlaylistWithFallback(server, id) {
  let lastError = null;

  for (const apiBase of APIS) {
    try {
      const url = `${apiBase}?server=${server}&type=playlist&id=${id}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (!Array.isArray(data)) {
        throw new Error('Invalid response format');
      }

      return data;
    } catch (err) {
      lastError = err;
      console.warn(`API ${apiBase} failed:`, err.message);
      continue;
    }
  }

  throw lastError || new Error('All APIs failed');
}

/**
 * Validate that a URL uses HTTPS to prevent SSRF via attacker-controlled URLs
 * @param {string} url - URL to validate
 * @returns {boolean}
 */
function isSafeUrl(url) {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Convert API response to internal format
 * @param {Array} tracks - Tracks from API
 * @param {string} server - Server type
 * @returns {Array} Converted tracks
 */
export function convertToLocalFormat(tracks, server) {
  const converted = [];

  for (const track of tracks) {
    // Skip tracks without valid HTTPS URL (prevents SSRF via attacker-controlled URLs)
    if (!track.url || !isSafeUrl(track.url)) {
      console.warn('Skipping track without valid HTTPS URL:', track.name);
      continue;
    }

    // Extract song ID from URL if possible
    let songId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const urlMatch = track.url.match(/id=(\d+)/);
    if (urlMatch) {
      songId = urlMatch[1];
    }

    // Store original cover URL, resolve it lazily when needed
    const musicInfo = {
      id: `imported_${server}_${songId}`,
      title: track.name || 'Unknown Title',
      composer: track.artist || 'Unknown Artist',
      lyricist: '',
      album: SERVER_NAMES[server] || 'Imported Playlist',
      isLocal: false,
      isImported: true,
      audioUrl: track.url,
      coverUrl: isSafeUrl(track.pic) ? track.pic : null, // Only store HTTPS URLs
      lrcUrl: track.lrc || null,
      assetbundleName: 'imported',
      server: server
    };

    converted.push(musicInfo);
  }

  return converted;
}

/**
 * Check if a track already exists in the database
 * @param {string} id - Track ID
 * @returns {boolean}
 */
function trackExists(id) {
  return state.importedMusicData.some(track => track.id === id);
}

/**
 * Import playlist from online service
 * @param {string} server - Server type (netease/tencent)
 * @param {string} id - Playlist ID
 * @param {Function} onProgress - Progress callback (current, total)
 * @returns {Promise<Object>} Result object {success, imported, skipped, total}
 */
export async function importPlaylist(server, id, onProgress = null) {
  // Fetch playlist
  const tracks = await fetchPlaylistWithFallback(server, id);

  if (tracks.length === 0) {
    throw new Error('Playlist is empty');
  }

  // Convert to internal format
  const converted = convertToLocalFormat(tracks, server);

  if (converted.length === 0) {
    throw new Error('No valid tracks found in playlist');
  }

  // Filter out duplicates
  const newTracks = [];
  let skipped = 0;

  for (const track of converted) {
    if (trackExists(track.id)) {
      skipped++;
      continue;
    }
    newTracks.push(track);
  }

  // Save to IndexedDB
  if (newTracks.length > 0) {
    await saveImportedMusicBatch(newTracks, onProgress);

    // Add to state
    state.importedMusicData.push(...newTracks);
  }

  return {
    success: true,
    imported: newTracks.length,
    skipped: skipped,
    total: tracks.length
  };
}

/**
 * Open import dialog
 * @param {Function} onComplete - Callback when import completes
 */
export function openImportDialog(onComplete) {
  const dialog = document.getElementById('playlistImportDialog');
  const overlay = document.getElementById('playlistImportOverlay');

  if (!dialog || !overlay) {
    console.error('Import dialog elements not found');
    return;
  }

  // Show dialog
  dialog.classList.remove('hidden');
  overlay.classList.remove('hidden');

  // Reset form
  const serverBtns = dialog.querySelectorAll('.server-select-btn');
  const input = dialog.querySelector('#playlistUrlInput');
  const errorMsg = dialog.querySelector('.import-error-msg');
  const progressMsg = dialog.querySelector('.import-progress-msg');
  const importBtn = dialog.querySelector('.start-import-btn');
  const cancelBtn = dialog.querySelector('.cancel-import-btn');

  if (input) input.value = '';
  if (errorMsg) errorMsg.classList.add('hidden');
  if (progressMsg) progressMsg.classList.add('hidden');
  if (importBtn) importBtn.disabled = false;
  if (cancelBtn) cancelBtn.disabled = false;

  // Set default server
  let selectedServer = 'netease';
  serverBtns.forEach(btn => {
    const isDefault = btn.dataset.server === 'netease';
    btn.classList.toggle('active', isDefault);
  });

  // Server selection
  serverBtns.forEach(btn => {
    const handler = () => {
      selectedServer = btn.dataset.server;
      serverBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };
    btn.removeEventListener('click', handler);
    btn.addEventListener('click', handler);
  });

  // Close handlers
  const closeDialog = () => {
    dialog.classList.add('hidden');
    overlay.classList.add('hidden');
  };

  const overlayHandler = () => closeDialog();
  overlay.removeEventListener('click', overlayHandler);
  overlay.addEventListener('click', overlayHandler);

  const cancelHandler = () => closeDialog();
  cancelBtn.removeEventListener('click', cancelHandler);
  cancelBtn.addEventListener('click', cancelHandler);

  // Helper: Validate input
  function validateInput(urlInput) {
    if (!urlInput) {
      if (errorMsg) {
        errorMsg.textContent = '请输入歌单链接或ID';
        errorMsg.classList.remove('hidden');
      }
      return null;
    }

    const playlistId = parsePlaylistInput(urlInput, selectedServer);

    if (!playlistId) {
      if (errorMsg) {
        errorMsg.textContent = '无效的歌单链接或ID';
        errorMsg.classList.remove('hidden');
      }
      return null;
    }

    return playlistId;
  }

  // Helper: Setup progress UI
  function setupProgressUI() {
    if (errorMsg) errorMsg.classList.add('hidden');
    if (progressMsg) {
      progressMsg.textContent = '正在获取歌单...';
      progressMsg.classList.remove('hidden');
    }

    if (importBtn) importBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;
    if (input) input.disabled = true;
    serverBtns.forEach(btn => btn.disabled = true);
  }

  // Helper: Show success message
  function showSuccess(result) {
    if (progressMsg) {
      let message = `成功导入 ${result.imported} 首歌曲`;
      if (result.skipped > 0) {
        message += ` (跳过 ${result.skipped} 首重复)`;
      }
      progressMsg.textContent = message;
    }

    setTimeout(() => {
      closeDialog();
      if (onComplete) onComplete();
    }, 2000);
  }

  // Helper: Get error message
  function getErrorMessage(err) {
    if (err.message === 'Playlist is empty') {
      return '歌单为空';
    } else if (err.message === 'No valid tracks found in playlist') {
      return '歌单中没有有效的歌曲';
    } else if (err.message.includes('Failed to fetch')) {
      return '网络错误，请检查网络连接';
    } else if (err.message.includes('HTTP')) {
      return '无法获取歌单，请检查ID是否正确';
    }
    return '导入失败';
  }

  // Helper: Show error
  function showError(err) {
    if (progressMsg) progressMsg.classList.add('hidden');
    if (errorMsg) {
      errorMsg.textContent = getErrorMessage(err);
      errorMsg.classList.remove('hidden');
    }

    if (importBtn) importBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
    if (input) input.disabled = false;
    serverBtns.forEach(btn => btn.disabled = false);
  }

  // Import handler
  const importHandler = async () => {
    const urlInput = input.value.trim();
    const playlistId = validateInput(urlInput);

    if (!playlistId) return;

    setupProgressUI();

    try {
      const result = await importPlaylist(selectedServer, playlistId, (current, total) => {
        if (progressMsg) {
          progressMsg.textContent = `正在导入: ${current}/${total}`;
        }
      });

      showSuccess(result);
    } catch (err) {
      console.error('Import failed:', err);
      showError(err);
    }
  };

  importBtn.removeEventListener('click', importHandler);
  importBtn.addEventListener('click', importHandler);

  // Enter key to import
  const enterHandler = (e) => {
    if (e.key === 'Enter' && !importBtn.disabled) {
      importHandler();
    }
  };
  input.removeEventListener('keypress', enterHandler);
  input.addEventListener('keypress', enterHandler);
}
