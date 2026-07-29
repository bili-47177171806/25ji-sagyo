// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 The 25-ji-code-de Team

(function () {
  'use strict';

  const tab = document.getElementById('tab-leaderboard');
  if (!tab || !window.SekaiAPI || !window.SekaiAuth) return;

  const loggedOut = document.getElementById('focus-leaderboard-logged-out');
  const content = document.getElementById('focus-leaderboard-content');
  const controls = [...tab.querySelectorAll('.focus-leaderboard-control')];
  const rows = document.getElementById('focusLeaderboardRows');
  const status = document.getElementById('focusLeaderboardStatus');
  const me = document.getElementById('focusLeaderboardMe');
  const showProfile = document.getElementById('focusLeaderboardShowProfile');
  const displayName = document.getElementById('focusLeaderboardDisplayName');
  const saveProfile = document.getElementById('focusLeaderboardSaveProfile');
  let activeBoard = controls[0]?.dataset.boardId;
  let loaded = false;

  const formatScore = (value, metric) => {
    const score = Number(value) || 0;
    if (metric === 'study_minutes') {
      const hours = Math.floor(score / 60);
      const minutes = score % 60;
      return hours ? `${hours}h ${minutes}min` : `${minutes}min`;
    }
    if (metric === 'songs_played') return `${score} 首`;
    if (metric === 'streak_days') return `${score} 天`;
    if (metric === 'achievements_unlocked') return `${score} 个成就`;
    return `${score} 个`;
  };

  function setAuthenticated(authenticated) {
    loggedOut?.classList.toggle('sekai-hidden', authenticated);
    content?.classList.toggle('sekai-hidden', !authenticated);
  }

  function renderRows(entries, metric) {
    rows.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'focus-leaderboard-empty';
      empty.textContent = '暂无成绩';
      rows.appendChild(empty);
      return;
    }
    entries.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'focus-leaderboard-row';
      const rank = document.createElement('span');
      rank.className = 'focus-leaderboard-rank';
      rank.textContent = `#${Number(entry.rank) || '-'}`;
      const name = document.createElement('span');
      name.className = 'focus-leaderboard-name';
      name.textContent = entry.is_public ? entry.display_name : '匿名用户';
      const score = document.createElement('span');
      score.className = 'focus-leaderboard-score';
      score.textContent = formatScore(entry.score, metric);
      row.append(rank, name, score);
      rows.appendChild(row);
    });
  }

  async function loadBoard(boardId) {
    if (!boardId) return;
    activeBoard = boardId;
    controls.forEach((control) => {
      const active = control.dataset.boardId === boardId;
      control.classList.toggle('active', active);
      control.setAttribute('aria-pressed', String(active));
    });
    status.textContent = '加载中...';
    me.classList.add('sekai-hidden');
    try {
      const data = await window.SekaiAPI.getLeaderboard(boardId, 20, 0);
      const metric = data?.leaderboard?.metric_name || '';
      renderRows(Array.isArray(data?.entries) ? data.entries : [], metric);
      status.textContent = `${data?.leaderboard?.title || '排行榜'} · ${Number(data?.total) || 0} 人`;
      if (data?.me) {
        me.textContent = `我的排名 #${Number(data.me.rank) || '-'} · ${formatScore(data.me.score, metric)}`;
        me.classList.remove('sekai-hidden');
      }
    } catch (error) {
      rows.replaceChildren();
      status.textContent = error?.status === 404 ? '榜单尚未启用' : '榜单加载失败';
    }
  }

  async function loadPanel() {
    const authenticated = window.SekaiAuth.isAuthenticated();
    setAuthenticated(authenticated);
    if (!authenticated) return;
    try {
      const profile = await window.SekaiAPI.getLeaderboardProfile();
      showProfile.checked = Boolean(profile?.show_profile);
      displayName.value = profile?.display_name || '';
      await loadBoard(activeBoard);
      loaded = true;
    } catch (error) {
      status.textContent = '排行榜加载失败';
    }
  }

  controls.forEach((control) => {
    control.addEventListener('click', () => loadBoard(control.dataset.boardId));
  });
  saveProfile?.addEventListener('click', async () => {
    saveProfile.disabled = true;
    try {
      await window.SekaiAPI.updateLeaderboardProfile(showProfile.checked, displayName.value);
      status.textContent = showProfile.checked ? '榜单昵称已公开' : '已恢复匿名展示';
      await loadBoard(activeBoard);
    } catch (error) {
      status.textContent = '身份设置保存失败';
    } finally {
      saveProfile.disabled = false;
    }
  });
  document.getElementById('focusLeaderboardLoginBtn')?.addEventListener('click', () => {
    window.SekaiAuth.login();
  });
  tab.closest('.settings-content')?.parentElement
    ?.querySelector('[data-tab="leaderboard"]')
    ?.addEventListener('click', () => {
      if (!loaded) loadPanel();
    });
})();
