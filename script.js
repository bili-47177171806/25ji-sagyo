// script.js
// Logic to choose which video (p1/p2/p3) to load and the correct seek offset
// so playback matches visitor's chosen timezone (local or Tokyo). Assumes each part is 8 hours long:
//  - Part P1: 25:00 - 09:00
//  - Part P2: 09:00 - 17:00
//  - Part P3: 17:00 - 25:00

(() => {
  const video = document.getElementById('video');
  const localTimeEl = document.getElementById('localTime');
  const partNameEl = document.getElementById('partName');
  const tzLabelEl = document.getElementById('tzLabel');
  const muteBtn = document.getElementById('muteBtn');
  const volumeSlider = document.getElementById('volumeSlider');
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const tzToggleBtn = document.getElementById('tzToggleBtn');

  const sources = window.TIME_SYNC_SOURCES || { p1: 'p1.mp4', p2: 'p2.mp4', p3: 'p3.mp4' };

  const PART_LENGTH_SECONDS = 8 * 3600; // 8 hours

  // timezone mode: 'local' or 'tokyo'
  let timezoneMode = 'local';
  // remember last non-zero volume so we can restore after unmute
  let savedVolume = 1;

  function formatTime(d) {
    return d.toLocaleTimeString();
  }

  // Given a Date, compute which part index (0=p1,1=p2,2=p3) and offset seconds into that part
  function computePartAndOffset(date) {
    // base reference: period starts at 25:00. We'll compute seconds since 25:00 of the same repeating cycle.
    const base = new Date(date);
    base.setHours(1, 0, 0, 0);
    if (date < base) {
      // use previous day's 25:00 so diff is positive
      base.setDate(base.getDate() - 1);
    }
    let diffSeconds = Math.floor((date.getTime() - base.getTime()) / 1000);

    // wrap to [0, 86400)
    diffSeconds = ((diffSeconds % 86400) + 86400) % 86400;

    const partIndex = Math.floor(diffSeconds / PART_LENGTH_SECONDS); // 0,1,2
    const offset = diffSeconds % PART_LENGTH_SECONDS;
    return { partIndex, offset };
  }

  function partIndexToKey(i) {
    return ['p1','p2','p3'][i] || 'p1';
  }

  let lastPartIndex = null;

  // Load the right src and seek to offset. Returns a Promise that resolves when seek done.
  function loadAndSeekTo(partIndex, offsetSeconds) {
    const key = partIndexToKey(partIndex);
    const src = sources[key];
    if (!src) return Promise.reject(new Error('Missing source for part ' + key));

    return new Promise((resolve, reject) => {
      // If same video and metadata is loaded, just set currentTime
      const doSeek = () => {
        // clamp offset to available duration if we can
        try {
          if (video.duration && offsetSeconds > video.duration) {
            // if duration smaller than expected, wrap around modulo duration
            offsetSeconds = offsetSeconds % video.duration;
          }
        } catch (e) {
          // ignore
        }

        function onSeeked() {
          video.removeEventListener('seeked', onSeeked);
          resolve();
        }

        video.addEventListener('seeked', onSeeked);
        // Some browsers will throw if setting currentTime before metadata is ready.
        try {
          video.currentTime = Math.max(0, offsetSeconds);
        } catch (err) {
          // fallback: wait a moment and try again
          setTimeout(() => {
            try { video.currentTime = Math.max(0, offsetSeconds); } catch (e) {}
          }, 300);
        }
      };

      if (!video.src || !video.src.endsWith(src)) {
        lastPartIndex = partIndex;
        video.src = src;
        // Ensure metadata loads so we can seek
        video.load();
        video.addEventListener('loadedmetadata', function onMeta() {
          video.removeEventListener('loadedmetadata', onMeta);
          doSeek();
          // ensure play (autoplay might be blocked unless muted; we set muted in HTML)
          video.play().catch(() => {});
        });
      } else {
        // same src; if metadata ready, seek immediately
        if (video.readyState >= 1) {
          doSeek();
        } else {
          video.addEventListener('loadedmetadata', function onMeta2() {
            video.removeEventListener('loadedmetadata', onMeta2);
            doSeek();
          });
        }
      }
    });
  }

  // Unmute UX: show unmute button when video is muted. Clicking will unmute and attempt play.
  // Controls UI
  function volumeIconForLevel(v, muted) {
    if (muted || v === 0) return '🔇';
    if (v < 0.33) return '🔈';
    if (v < 0.66) return '🔉';
    return '🔊';
  }

  function updateControlsUI() {
    // (no play/pause UI here per UX decision)
    // mute button icon and aria
    if (muteBtn) {
      const icon = volumeIconForLevel(video.volume, video.muted);
      muteBtn.textContent = icon;
      muteBtn.setAttribute('aria-pressed', String(!video.muted));
      muteBtn.title = video.muted ? 'Muted — click to unmute' : 'Click to mute';
    }
    // volume slider reflect current volume
    if (volumeSlider) {
      // when muted, visually show 0; otherwise show actual volume
      volumeSlider.value = video.muted ? '0' : String(video.volume);
    }
    // tz label
    if (tzLabelEl) tzLabelEl.textContent = timezoneMode === 'local' ? 'Local' : 'Tokyo';
  }

  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      // toggle mute
      if (!video.muted) {
        // muting: save current volume and set slider to 0 (visual cue)
        savedVolume = video.volume || savedVolume || 1;
        video.muted = true;
        if (volumeSlider) volumeSlider.value = '0';
      } else {
        // unmuting: restore previous volume
        video.muted = false;
        video.volume = savedVolume || 1;
        if (volumeSlider) volumeSlider.value = String(video.volume);
        // user gesture: try to play with audio
        video.play().catch(() => {});
      }
      updateControlsUI();
      saveSettings();
    });
  }

  if (volumeSlider) {
    // initialize slider value when available
    volumeSlider.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      const vol = isNaN(v) ? 1 : v;
      video.volume = vol;
      if (vol > 0) {
        // unmute when slider > 0
        video.muted = false;
        savedVolume = vol;
      } else {
        // if slider set to 0, mute
        video.muted = true;
      }
      updateControlsUI();
      saveSettings();
    });
  }
  // play/pause and speed selector removed per user request

  if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', async () => {
      try {
        if (!document.fullscreenElement) {
          await document.documentElement.requestFullscreen();
          await screen.orientation?.lock('landscape').catch(() => {});
        } else {
          await document.exitFullscreen();
          await screen.orientation?.unlock().catch(() => {});
        }
      } catch (e) {
        // ignore
      }
    });
  }

  if (tzToggleBtn) {
    tzToggleBtn.addEventListener('click', () => {
      timezoneMode = timezoneMode === 'local' ? 'tokyo' : 'local';
      updateControlsUI();
      // immediate resync with new timezone
      resyncOnce();
      saveSettings();
    });
  }

  // Persist settings to localStorage
  const SETTINGS_KEY = 'videoPlayerSettings';

  function saveSettings() {
    try {
      const s = {
        muted: !!video.muted,
        volume: Number(video.volume) || 0,
        timezoneMode: timezoneMode
      };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch (e) {
      // ignore
    }
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (typeof s.volume === 'number') video.volume = s.volume;
      if (typeof s.muted === 'boolean') video.muted = s.muted;
      if (s.timezoneMode) timezoneMode = s.timezoneMode;
      // reflect UI (no playbackRate control)
    } catch (e) {
      // ignore
    }
  }

  // Desired behavior: keep the playback matched to local clock. Periodically check and correct drift.
  function getNowByMode() {
    if (timezoneMode === 'local') return new Date();
    // Tokyo: compute from UTC +9
    const utcMs = Date.now() + new Date().getTimezoneOffset() * 60000;
    const tokyoMs = utcMs + 9 * 3600 * 1000;
    return new Date(tokyoMs);
  }

  function resyncOnce() {
    const now = getNowByMode();
    localTimeEl.textContent = formatTime(now);

    const { partIndex, offset } = computePartAndOffset(now);
    const key = partIndexToKey(partIndex);
    partNameEl.textContent = key.toUpperCase();

    const desired = offset;

    // If part changed, load new source and seek
    if (lastPartIndex === null || lastPartIndex !== partIndex) {
      return loadAndSeekTo(partIndex, desired).catch(console.warn).finally(updateControlsUI);
    }

    // Same part: check drift
    const current = video.currentTime || 0;
    const drift = Math.abs(current - desired);
    // allow a small tolerance (30 seconds)
    if (drift > 30) {
      // seek to correct position
      try {
        video.currentTime = desired;
      } catch (e) {
        // if not ready, attempt load/seek sequence
        loadAndSeekTo(partIndex, desired).catch(console.warn);
      }
    }
    // ensure playing
    if (video.paused) video.play().catch(() => {});
    updateControlsUI();
  }

  // initial setup
  // ensure default muted state and slider reflect current volume
  if (typeof video.muted === 'undefined') video.muted = true;
  // load persisted settings (if any) before updating UI
  loadSettings();
  if (!volumeSlider) {
    // nothing
  } else {
    // set initial slider to video.volume (default 1)
    volumeSlider.value = String(video.volume || 1);
  }
  updateControlsUI();
  // initial sync when script loads

  // --- HEVC (H.265) 支持检测 ---
  function browserSupportsHEVC() {
    // Common HEVC codec strings
    const types = [
      'video/mp4; codecs="hvc1"',
      'video/mp4; codecs="hev1"',
      'video/mp4; codecs="hev1.1.6.L93.B0"',
      'video/mp4; codecs="hvc1.1.L63.B0"'
    ];

    // Prefer MediaSource.isTypeSupported when available
    try {
      if (window.MediaSource && typeof MediaSource.isTypeSupported === 'function') {
        for (const t of types) {
          try {
            if (MediaSource.isTypeSupported(t)) return true;
          } catch (e) {
            // ignore individual errors
          }
        }
      }
    } catch (e) {}

    // Fallback: use video.canPlayType
    try {
      for (const t of types) {
        const r = video.canPlayType(t);
        if (r === 'probably' || r === 'maybe') return true;
      }
    } catch (e) {}

    return false;
  }

  function showHEVCWarning() {
    // create a dismissible banner near the top of the app
    const existing = document.getElementById('hevcWarning');
    if (existing) return;
    const container = document.createElement('div');
    container.id = 'hevcWarning';
    container.className = 'hevc-warning';
    container.innerHTML = `
      <div class="hevc-inner">
        <span>检测到您的浏览器可能不支持 H.265 / HEVC 编码，播放可能失败。</span>
      </div>
    `;
    // insert into #app if present, otherwise body
    const app = document.getElementById('app') || document.body;
    app.appendChild(container);
    // clicking the warning must not toggle the overlay or unmute the video
    container.addEventListener('click', (e) => e.stopPropagation());
  }

  // Run detection and show message if unsupported
  try {
    if (!browserSupportsHEVC()) {
      // Delay slightly to avoid layout flash while other inits run
      setTimeout(showHEVCWarning, 80);
    }
  } catch (e) {
    // safe fallback: don't block the app
    console.warn('HEVC detection error', e);
  }

  resyncOnce();

  // resync every 5 seconds to correct drift and to handle boundary changes
  setInterval(resyncOnce, 5000);

  // update clock display every second (respecting timezone mode)
  setInterval(() => {
    const now = getNowByMode();
    localTimeEl.textContent = formatTime(now);
  }, 1000);

  // Click behavior: toggle overlay visibility and unmute on first user gesture.
  // When the page autoplays muted due to browser policy, the first user click should
  // be able to unmute and resume playback with audio. Also clicking the video toggles
  // showing/hiding the overlay. Clicks on the overlay itself (controls) won't propagate
  // to the video so users can interact with controls normally.
  const overlay = document.getElementById('overlay');
  let firstUserClick = true;

  function toggleOverlay() {
    if (!overlay) return;
    overlay.classList.toggle('hidden');
  }

  // Video click: unmute on first interaction if muted, then toggle overlay
  video.addEventListener('click', (e) => {
    // first user gesture: attempt to unmute if currently muted
    if (firstUserClick) {
      if (video.muted) {
        // restore last saved volume (or 1) and unmute
        video.muted = false;
        video.volume = savedVolume || 1;
        // play with sound (user gesture)
        video.play().catch(() => {});
        updateControlsUI();
      }
      firstUserClick = false;
    }
    // toggle overlay visibility
    toggleOverlay();
  });

  // Prevent clicks inside overlay (controls area) from bubbling to the video
  if (overlay) {
    overlay.addEventListener('click', (ev) => {
      // allow interactions with buttons/inputs inside overlay but stop propagation
      ev.stopPropagation();
    });
  }

  // Keyboard shortcuts: only M (mute) and F (fullscreen). Do not alter play/pause or seek.
  document.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    const tag = active && active.tagName && active.tagName.toLowerCase();
    // don't intercept when typing into inputs/selects/textareas
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || (active && active.isContentEditable)) return;

    const k = (e.key || '').toLowerCase();
    if (k === 'm') {
      e.preventDefault();
      if (muteBtn) muteBtn.click();
      return;
    }
    if (k === 'f') {
      e.preventDefault();
      if (fullscreenBtn) fullscreenBtn.click();
      return;
    }
  });

  // --- Pomodoro Timer Logic ---
  (() => {
    const pomodoroBtn = document.getElementById('pomodoroBtn');
    const pomodoroPanel = document.getElementById('pomodoroPanel');
    const pomodoroCloseBtn = document.getElementById('pomodoroCloseBtn');
    const toggleClockWidgetBtn = document.getElementById('toggleClockWidget');
    const worldClockSection = document.getElementById('worldClockSection');
    const pomodoroDisplay = document.getElementById('pomodoroDisplay');
    const pomodoroStatus = document.querySelector('.pomodoro-status');
    const startBtn = document.getElementById('pomodoroStartBtn');
    const pauseBtn = document.getElementById('pomodoroPauseBtn');
    const resetBtn = document.getElementById('pomodoroResetBtn');
    const workDurationInput = document.getElementById('workDuration');
    const shortBreakInput = document.getElementById('shortBreak');
    const longBreakInput = document.getElementById('longBreak');
    const pomodoroRound = document.getElementById('pomodoroRound');

    // World Clock elements - Time.is style
    const localHoursEl = document.getElementById('localHours');
    const localMinutesEl = document.getElementById('localMinutes');
    const localSecondsEl = document.getElementById('localSeconds');
    const localMillisecondsEl = document.getElementById('localMilliseconds');
    const localDateEl = document.getElementById('localDate');
    
    const tokyoTimeEl = document.getElementById('tokyoTime');
    const nyTimeEl = document.getElementById('nyTime');
    const londonTimeEl = document.getElementById('londonTime');

    if (!pomodoroBtn || !pomodoroPanel) return;

    let timer = null;
    let remainingSeconds = 25 * 60;
    let isRunning = false;
    let currentMode = 'work'; // 'work', 'short-break', 'long-break'
    let workRounds = 0;
    const maxRounds = 4;
    let clockWidgetVisible = false;

    // SessionStorage keys for Pomodoro
    const POMODORO_STORAGE_KEYS = {
      REMAINING: 'pomodoro_remaining',
      MODE: 'pomodoro_mode',
      ROUNDS: 'pomodoro_rounds',
      IS_RUNNING: 'pomodoro_isRunning'
    };

    // Save pomodoro state to sessionStorage
    function savePomodoroState() {
      try {
        sessionStorage.setItem(POMODORO_STORAGE_KEYS.REMAINING, remainingSeconds);
        sessionStorage.setItem(POMODORO_STORAGE_KEYS.MODE, currentMode);
        sessionStorage.setItem(POMODORO_STORAGE_KEYS.ROUNDS, workRounds);
        sessionStorage.setItem(POMODORO_STORAGE_KEYS.IS_RUNNING, isRunning);
      } catch (e) {
        console.warn('Failed to save pomodoro state:', e);
      }
    }

    // Load pomodoro state from sessionStorage
    function loadPomodoroState() {
      try {
        const savedRemaining = sessionStorage.getItem(POMODORO_STORAGE_KEYS.REMAINING);
        const savedMode = sessionStorage.getItem(POMODORO_STORAGE_KEYS.MODE);
        const savedRounds = sessionStorage.getItem(POMODORO_STORAGE_KEYS.ROUNDS);
        const savedRunning = sessionStorage.getItem(POMODORO_STORAGE_KEYS.IS_RUNNING);

        if (savedRemaining !== null) {
          remainingSeconds = parseInt(savedRemaining);
        }
        if (savedMode !== null) {
          currentMode = savedMode;
        }
        if (savedRounds !== null) {
          workRounds = parseInt(savedRounds);
        }
        
        updateDisplay();
        
        // If it was running, resume the timer
        if (savedRunning === 'true') {
          startTimer();
        }
      } catch (e) {
        console.warn('Failed to load pomodoro state:', e);
      }
    }

    // Toggle clock widget visibility
    function toggleClockWidget() {
      clockWidgetVisible = !clockWidgetVisible;
      if (worldClockSection) {
        worldClockSection.classList.toggle('collapsed', !clockWidgetVisible);
      }
      if (toggleClockWidgetBtn) {
        toggleClockWidgetBtn.classList.toggle('active', clockWidgetVisible);
      }
      // Save preference
      try {
        localStorage.setItem('clockWidgetVisible', clockWidgetVisible);
      } catch (e) {}
    }

    // Load saved preference
    try {
      const saved = localStorage.getItem('clockWidgetVisible');
      if (saved !== null) {
        clockWidgetVisible = saved === 'true';
        if (worldClockSection) {
          worldClockSection.classList.toggle('collapsed', !clockWidgetVisible);
        }
        if (toggleClockWidgetBtn) {
          toggleClockWidgetBtn.classList.toggle('active', clockWidgetVisible);
        }
      } else {
        // Default: show clock widget
        clockWidgetVisible = true;
      }
    } catch (e) {}

    if (toggleClockWidgetBtn) {
      toggleClockWidgetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleClockWidget();
      });
    }

    // High-precision World Clock Update with milliseconds
    function updateWorldClocks() {
      const now = new Date();
      const ms = now.getMilliseconds();
      
      // Local time with milliseconds
      if (localHoursEl && localMinutesEl && localSecondsEl && localMillisecondsEl) {
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const milliseconds = '.' + String(ms).padStart(3, '0');
        
        localHoursEl.textContent = hours;
        localMinutesEl.textContent = minutes;
        localSecondsEl.textContent = seconds;
        localMillisecondsEl.textContent = milliseconds;
      }

      // Local date
      if (localDateEl) {
        const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${weekdays[now.getDay()]}`;
        localDateEl.textContent = dateStr;
      }

      // Tokyo time (UTC+9) - no milliseconds
      if (tokyoTimeEl) {
        const tokyoTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
        const tokyoHours = String(tokyoTime.getHours()).padStart(2, '0');
        const tokyoMinutes = String(tokyoTime.getMinutes()).padStart(2, '0');
        const tokyoSeconds = String(tokyoTime.getSeconds()).padStart(2, '0');
        
        tokyoTimeEl.textContent = `${tokyoHours}:${tokyoMinutes}:${tokyoSeconds}`;
      }

      // New York time (UTC-5/-4) - no milliseconds
      if (nyTimeEl) {
        const nyTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const nyHours = String(nyTime.getHours()).padStart(2, '0');
        const nyMinutes = String(nyTime.getMinutes()).padStart(2, '0');
        const nySeconds = String(nyTime.getSeconds()).padStart(2, '0');
        
        nyTimeEl.textContent = `${nyHours}:${nyMinutes}:${nySeconds}`;
      }

      // London time (UTC+0/+1) - no milliseconds
      if (londonTimeEl) {
        const londonTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
        const londonHours = String(londonTime.getHours()).padStart(2, '0');
        const londonMinutes = String(londonTime.getMinutes()).padStart(2, '0');
        const londonSeconds = String(londonTime.getSeconds()).padStart(2, '0');
        
        londonTimeEl.textContent = `${londonHours}:${londonMinutes}:${londonSeconds}`;
      }
    }

    // Update world clocks immediately and then every 50ms for smooth milliseconds
    updateWorldClocks();
    setInterval(updateWorldClocks, 50);

    function formatTime(seconds) {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    function updateDisplay() {
      pomodoroDisplay.textContent = formatTime(remainingSeconds);
      pomodoroRound.textContent = `${workRounds} / ${maxRounds}`;
      
      // Update status text
      if (currentMode === 'work') {
        pomodoroStatus.textContent = '工作时间 🎯';
        pomodoroDisplay.style.color = '#ff6b6b';
      } else if (currentMode === 'short-break') {
        pomodoroStatus.textContent = '短休息 ☕';
        pomodoroDisplay.style.color = '#51cf66';
      } else if (currentMode === 'long-break') {
        pomodoroStatus.textContent = '长休息 🌟';
        pomodoroDisplay.style.color = '#339af0';
      }
    }

    function startTimer() {
      if (isRunning) return;
      isRunning = true;
      startBtn.disabled = true;
      pauseBtn.disabled = false;
      savePomodoroState(); // Save state
      
      timer = setInterval(() => {
        remainingSeconds--;
        updateDisplay();
        savePomodoroState(); // Save state on each tick
        
        if (remainingSeconds <= 0) {
          clearInterval(timer);
          isRunning = false;
          savePomodoroState(); // Save state
          handleTimerComplete();
        }
      }, 1000);
    }

    function pauseTimer() {
      if (!isRunning) return;
      clearInterval(timer);
      isRunning = false;
      startBtn.disabled = false;
      pauseBtn.disabled = true;
      savePomodoroState(); // Save state
    }

    function resetTimer() {
      pauseTimer();
      currentMode = 'work';
      remainingSeconds = parseInt(workDurationInput.value) * 60;
      workRounds = 0;
      updateDisplay();
      startBtn.disabled = false;
      pauseBtn.disabled = true;
      savePomodoroState(); // Save state
    }

    function handleTimerComplete() {
      // Play notification sound (browser notification)
      try {
        if ('Notification' in window && Notification.permission === 'granted') {
          const title = currentMode === 'work' ? '工作完成!' : '休息结束!';
          const body = currentMode === 'work' ? '该休息一下了 ☕' : '开始下一个番茄钟 🍅';
          new Notification(title, { body, icon: '🍅' });
        }
      } catch (e) {
        console.warn('Notification error:', e);
      }

      // Switch modes
      if (currentMode === 'work') {
        workRounds++;
        if (workRounds >= maxRounds) {
          currentMode = 'long-break';
          remainingSeconds = parseInt(longBreakInput.value) * 60;
          workRounds = 0;
        } else {
          currentMode = 'short-break';
          remainingSeconds = parseInt(shortBreakInput.value) * 60;
        }
      } else {
        currentMode = 'work';
        remainingSeconds = parseInt(workDurationInput.value) * 60;
      }

      updateDisplay();
      startBtn.disabled = false;
      pauseBtn.disabled = true;
      savePomodoroState(); // Save state after mode switch
    }

    function togglePanel() {
      pomodoroPanel.classList.toggle('hidden');
    }

    // Event listeners
    pomodoroBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel();
      // Request notification permission if not granted
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    });

    pomodoroCloseBtn.addEventListener('click', () => {
      togglePanel();
    });

    startBtn.addEventListener('click', startTimer);
    pauseBtn.addEventListener('click', pauseTimer);
    resetBtn.addEventListener('click', resetTimer);

    // Update timer duration when settings change (only when not running)
    workDurationInput.addEventListener('change', () => {
      if (!isRunning && currentMode === 'work') {
        remainingSeconds = parseInt(workDurationInput.value) * 60;
        updateDisplay();
      }
    });

    shortBreakInput.addEventListener('change', () => {
      if (!isRunning && currentMode === 'short-break') {
        remainingSeconds = parseInt(shortBreakInput.value) * 60;
        updateDisplay();
      }
    });

    longBreakInput.addEventListener('change', () => {
      if (!isRunning && currentMode === 'long-break') {
        remainingSeconds = parseInt(longBreakInput.value) * 60;
        updateDisplay();
      }
    });

    // Prevent clicks inside panel from propagating
    pomodoroPanel.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    // Initialize display and load saved state
    updateDisplay();
    loadPomodoroState(); // Load saved state from sessionStorage
  })();

  // --- CD Player Logic ---
  (() => {
    const cdPlayerBtn = document.getElementById('cdPlayerBtn');
    const cdPlayerPanel = document.getElementById('cdPlayerPanel');
    const cdPlayerCloseBtn = document.getElementById('cdPlayerCloseBtn');
    const musicList = document.getElementById('musicList');
    const musicSearchInput = document.getElementById('musicSearchInput');
    const albumCover = document.getElementById('albumCover');
    const cdAnimation = document.getElementById('cdAnimation');
    const trackTitle = document.getElementById('trackTitle');
    const trackArtist = document.getElementById('trackArtist');
    const trackVocal = document.getElementById('trackVocal');
    const cdAudioPlayer = document.getElementById('cdAudioPlayer');
    const trackLoadingSpinner = document.getElementById('trackLoadingSpinner');
    const playPauseBtn = document.getElementById('playPauseBtn');
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    const shuffleBtn = document.getElementById('shuffleBtn');
    const repeatBtn = document.getElementById('repeatBtn');
    const progressBar = document.getElementById('progressBar');
    const currentTimeEl = document.getElementById('currentTime');
    const totalTimeEl = document.getElementById('totalTime');
    const cdVolumeSlider = document.getElementById('cdVolumeSlider');

    if (!cdPlayerBtn || !cdPlayerPanel) return;

    let musicData = [];
    let musicVocalsData = [];
    let musicTitlesZhCN = {}; // Chinese translations
    const gameCharacters = {
      1: '星乃一歌', 2: '天马咲希', 3: '望月穗波', 4: '日野森志步',
      5: '花里实乃里', 6: '桐谷遥', 7: '桃井爱莉', 8: '日野森雫',
      9: '小豆泽心羽', 10: '白石杏', 11: '东云彰人', 12: '青柳冬弥',
      13: '天马司', 14: '凤笑梦', 15: '草薙宁宁', 16: '神代类',
      17: '宵崎奏', 18: '朝比奈真冬', 19: '东云绘名', 20: '晓山瑞希',
      21: '初音未来', 22: '镜音铃', 23: '镜音连', 24: '巡音流歌', 25: 'MEIKO', 26: 'KAITO'
    };
    let filteredMusicData = [];
    let currentTrackIndex = -1;
    let currentMusicId = null; // Currently playing music ID (for tracking across category changes)
    let currentVocalId = null; // Currently selected vocal version
    let preferredVocalType = 'sekai'; // Default preference
    let isPlaying = false;
    let isShuffleOn = false;
    let isRepeatOn = false;
    let pendingAutoPlay = false; // Flag to track if we should auto-play after loading
    let favorites = new Set(); // Set of favorite music IDs
    let playlists = []; // Array of { id, name, tracks: Set(musicIds) }
    let currentCategory = 'all'; // Current selected category or playlist ID

    // LocalStorage keys for CD Player
    const STORAGE_KEYS = {
      VOLUME: 'cdPlayer_volume',
      LAST_TRACK: 'cdPlayer_lastTrack',
      SHUFFLE: 'cdPlayer_shuffle',
      REPEAT: 'cdPlayer_repeat',
      VOCAL_PREFERENCE: 'cdPlayer_vocalPreference',
      FAVORITES: 'cdPlayer_favorites',
      PLAYLISTS: 'cdPlayer_playlists'
    };

    // Save settings to localStorage
    function saveSettings() {
      try {
        localStorage.setItem(STORAGE_KEYS.VOLUME, cdAudioPlayer.volume);
        localStorage.setItem(STORAGE_KEYS.LAST_TRACK, currentTrackIndex);
        localStorage.setItem(STORAGE_KEYS.SHUFFLE, isShuffleOn);
        localStorage.setItem(STORAGE_KEYS.REPEAT, isRepeatOn);
        localStorage.setItem(STORAGE_KEYS.VOCAL_PREFERENCE, preferredVocalType);
        localStorage.setItem(STORAGE_KEYS.FAVORITES, JSON.stringify([...favorites]));
        
        // Serialize playlists (convert Sets to Arrays)
        const serializedPlaylists = playlists.map(p => ({
          id: p.id,
          name: p.name,
          tracks: [...p.tracks]
        }));
        localStorage.setItem(STORAGE_KEYS.PLAYLISTS, JSON.stringify(serializedPlaylists));
      } catch (e) {
        console.warn('Failed to save CD player settings:', e);
      }
    }

    // Load settings from localStorage
    function loadSettings() {
      try {
        const savedVolume = localStorage.getItem(STORAGE_KEYS.VOLUME);
        if (savedVolume !== null) {
          const vol = parseFloat(savedVolume);
          cdAudioPlayer.volume = vol;
          if (cdVolumeSlider) cdVolumeSlider.value = vol;
        }

        const savedShuffle = localStorage.getItem(STORAGE_KEYS.SHUFFLE);
        if (savedShuffle !== null) {
          isShuffleOn = savedShuffle === 'true';
          if (shuffleBtn) shuffleBtn.classList.toggle('active', isShuffleOn);
        }

        const savedRepeat = localStorage.getItem(STORAGE_KEYS.REPEAT);
        if (savedRepeat !== null) {
          isRepeatOn = savedRepeat === 'true';
          if (repeatBtn) repeatBtn.classList.toggle('active', isRepeatOn);
          cdAudioPlayer.loop = isRepeatOn;
        }

        const savedVocalPref = localStorage.getItem(STORAGE_KEYS.VOCAL_PREFERENCE);
        if (savedVocalPref !== null) {
          preferredVocalType = savedVocalPref;
        }

        const savedFavorites = localStorage.getItem(STORAGE_KEYS.FAVORITES);
        if (savedFavorites !== null) {
          favorites = new Set(JSON.parse(savedFavorites));
        }

        const savedPlaylists = localStorage.getItem(STORAGE_KEYS.PLAYLISTS);
        if (savedPlaylists !== null) {
          const parsed = JSON.parse(savedPlaylists);
          playlists = parsed.map(p => ({
            id: p.id,
            name: p.name,
            tracks: new Set(p.tracks)
          }));
        }

        const savedTrack = localStorage.getItem(STORAGE_KEYS.LAST_TRACK);
        if (savedTrack !== null) {
          const trackIndex = parseInt(savedTrack);
          // Load last track after music data is ready
          return trackIndex;
        }
      } catch (e) {
        console.warn('Failed to load CD player settings:', e);
      }
      return null;
    }

    // Helper to determine music category
    function getMusicCategory(music) {
      // Map categories based on Sekai logic

      // 1. Check for Sekai Unit (Human vocals)
      // A song belongs to a unit if it has a 'sekai' version sung by that unit.
      const sekaiVocal = musicVocalsData.find(v => v.musicId === music.id && v.musicVocalType === 'sekai');
      if (sekaiVocal) {
        // Get all game character IDs
        const charIds = sekaiVocal.characters
          .filter(c => c.characterType === 'game_character')
          .map(c => c.characterId);
        
        if (charIds.length === 0) {
          // No game characters
          return 'other';
        }
        
        // Check if this is a cross-unit collaboration (characters from multiple units)
        const units = new Set();
        charIds.forEach(id => {
          if (id >= 1 && id <= 4) units.add('leo_need');
          else if (id >= 5 && id <= 8) units.add('more_more_jump');
          else if (id >= 9 && id <= 12) units.add('vivid_bad_squad');
          else if (id >= 13 && id <= 16) units.add('wonderlands_x_showtime');
          else if (id >= 17 && id <= 20) units.add('25_ji_nightcord_de');
        });
        
        // If multiple units are involved, it's a cross-unit collaboration -> Other
        if (units.size > 1) {
          return 'other';
        }
        
        // Single unit song
        if (units.has('leo_need')) return 'leo_need';
        if (units.has('more_more_jump')) return 'more_more_jump';
        if (units.has('vivid_bad_squad')) return 'vivid_bad_squad';
        if (units.has('wonderlands_x_showtime')) return 'wonderlands_x_showtime';
        if (units.has('25_ji_nightcord_de')) return '25_ji_nightcord_de';
      }
      
      // 2. Special check: If music has vocals but all vocals have empty or missing characters
      // (Like some special event songs that have vocals but no credited singers)
      const allVocals = musicVocalsData.filter(v => 
        v.musicId === music.id && 
        v.musicVocalType !== 'instrumental'
      );
      
      if (allVocals.length > 0) {
        // Check if ALL vocals have no characters
        const allHaveNoCharacters = allVocals.every(v => 
          !v.characters || v.characters.length === 0
        );
        
        if (allHaveNoCharacters) {
          // All vocals exist but none have credited singers -> Other
          return 'other';
        }
        
        // Has vocals with characters -> Virtual Singer
        return 'virtual_singer';
      }

      // 3. No vocals at all (pure instrumental) -> Other
      return 'other';
    }

    // Filter music list based on category and search
    function filterMusicList(query = '') {
      let list = musicData.filter(music => {
          // Find any vocal for this music
          const hasVocal = musicVocalsData.some(
            vocal => vocal.musicId === music.id
          );
          return hasVocal;
      });

      // Filter by category
      if (currentCategory === 'favorites') {
        list = list.filter(music => favorites.has(music.id));
      } else if (currentCategory === 'playlists') {
        // Special case: handled by displayPlaylists, but if we are here, it means we are searching
        // or filtering within "all playlists" context? No, 'playlists' category shows playlist grid.
        // If currentCategory is a specific playlist ID:
      } else if (currentCategory.startsWith('playlist_')) {
        const playlistId = currentCategory;
        const playlist = playlists.find(p => p.id === playlistId);
        if (playlist) {
          list = list.filter(music => playlist.tracks.has(music.id));
        } else {
          list = [];
        }
      } else if (currentCategory !== 'all') {
        list = list.filter(music => getMusicCategory(music) === currentCategory);
      }

      // Filter by search query
      if (query) {
        list = list.filter(music => {
          const zhTitle = musicTitlesZhCN[music.id];
          return music.title.toLowerCase().includes(query) ||
            (music.pronunciation && music.pronunciation.toLowerCase().includes(query)) ||
            (music.lyricist && music.lyricist.toLowerCase().includes(query)) ||
            (music.composer && music.composer.toLowerCase().includes(query)) ||
            (zhTitle && zhTitle.toLowerCase().includes(query));
        });
      }
      
      filteredMusicData = list;
      displayMusicList(filteredMusicData);
    }

    // Playlist Management Functions
    function createPlaylist() {
      const name = prompt('请输入歌单名称:');
      if (name && name.trim()) {
        const id = 'playlist_' + Date.now();
        playlists.push({
          id: id,
          name: name.trim(),
          tracks: new Set()
        });
        saveSettings();
        displayPlaylists();
      }
    }

    function deletePlaylist(id) {
      if (confirm('确定要删除这个歌单吗？')) {
        playlists = playlists.filter(p => p.id !== id);
        saveSettings();
        displayPlaylists();
      }
    }

    function addToPlaylist(musicId, buttonElement) {
      // Close any other open dropdowns
      document.querySelectorAll('.playlist-dropdown.show').forEach(dropdown => {
        dropdown.classList.remove('show');
      });
      
      // Show simple modal or prompt to select playlist
      if (playlists.length === 0) {
        if (confirm('还没有创建歌单，是否现在创建？')) {
          createPlaylist();
        }
        return;
      }

      // Create dropdown for selection
      const dropdown = document.createElement('div');
      dropdown.className = 'playlist-dropdown show';
      
      playlists.forEach(p => {
        const item = document.createElement('div');
        item.className = 'playlist-dropdown-item';
        const isAdded = p.tracks.has(musicId);
        
        const icon = document.createElement('span');
        icon.className = 'playlist-dropdown-icon';
        icon.textContent = '📂';
        
        const name = document.createElement('span');
        name.className = 'playlist-dropdown-name';
        name.textContent = p.name;
        
        const check = document.createElement('span');
        check.className = 'playlist-dropdown-check';
        check.textContent = isAdded ? '✓' : '';
        
        item.appendChild(icon);
        item.appendChild(name);
        item.appendChild(check);
        
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          if (isAdded) {
            p.tracks.delete(musicId);
          } else {
            p.tracks.add(musicId);
          }
          saveSettings();
          dropdown.remove();
          // Refresh list if we are currently viewing this playlist
          if (currentCategory === p.id) {
            filterMusicList(musicSearchInput ? musicSearchInput.value.toLowerCase().trim() : '');
          }
        });
        
        dropdown.appendChild(item);
      });
      
      // New playlist option
      const newItem = document.createElement('div');
      newItem.className = 'playlist-dropdown-item create-new';
      
      const newIcon = document.createElement('span');
      newIcon.className = 'playlist-dropdown-icon';
      newIcon.textContent = '+';
      
      const newName = document.createElement('span');
      newName.className = 'playlist-dropdown-name';
      newName.textContent = '新建歌单';
      
      newItem.appendChild(newIcon);
      newItem.appendChild(newName);
      
      newItem.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.remove();
        createPlaylist();
      });
      
      dropdown.appendChild(newItem);

      // Position dropdown relative to the button
      const actionsContainer = buttonElement.closest('.music-item-actions');
      if (actionsContainer) {
        actionsContainer.appendChild(dropdown);
      }
      
      // Close dropdown when clicking outside - use capture phase and check immediately
      const closeDropdown = (e) => {
        // Check if dropdown still exists in DOM
        if (!document.body.contains(dropdown)) {
          document.removeEventListener('click', closeDropdown, true);
          return;
        }
        
        // Check if click is outside both the dropdown and the button
        if (!dropdown.contains(e.target) && !buttonElement.contains(e.target)) {
          dropdown.classList.remove('show');
          setTimeout(() => {
            if (document.body.contains(dropdown)) {
              dropdown.remove();
            }
          }, 150); // Wait for animation
          document.removeEventListener('click', closeDropdown, true);
        }
      };
      
      // Add listener in next tick to avoid immediate trigger
      setTimeout(() => {
        document.addEventListener('click', closeDropdown, true); // Use capture phase
      }, 0);
      
      // Also close when pressing Escape key
      const handleEscape = (e) => {
        if (e.key === 'Escape') {
          dropdown.classList.remove('show');
          setTimeout(() => dropdown.remove(), 150);
          document.removeEventListener('keydown', handleEscape);
        }
      };
      document.addEventListener('keydown', handleEscape);
    }

    function displayPlaylists() {
      musicList.innerHTML = '';
      
      const grid = document.createElement('div');
      grid.className = 'playlist-grid';
      
      // Create New Card
      const createCard = document.createElement('div');
      createCard.className = 'playlist-card create-new';
      createCard.innerHTML = `
        <div class="playlist-icon">✚</div>
        <div class="playlist-name">新建歌单</div>
      `;
      createCard.addEventListener('click', createPlaylist);
      grid.appendChild(createCard);
      
      // Playlist Cards
      playlists.forEach(p => {
        const card = document.createElement('div');
        card.className = 'playlist-card';
        card.innerHTML = `
          <div class="playlist-icon">📂</div>
          <div class="playlist-name">${p.name}</div>
          <div class="playlist-count">${p.tracks.size} 首歌曲</div>
        `;
        
        // Right click to delete
        card.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          deletePlaylist(p.id);
        });
        
        card.addEventListener('click', () => {
          currentCategory = p.id;
          // Update active category button visually (none of the main ones)
          document.querySelectorAll('.category-btn').forEach(b => b.classList.remove('active'));
          // Maybe highlight the playlist folder button?
          const plBtn = document.querySelector('.category-btn[data-category="playlists"]');
          if (plBtn) plBtn.classList.add('active');
          
          filterMusicList('');
        });
        
        grid.appendChild(card);
      });
      
      musicList.appendChild(grid);
    }

    // Toggle favorite
    function toggleFavorite(musicId, btn) {
      if (favorites.has(musicId)) {
        favorites.delete(musicId);
        btn.classList.remove('active');
        btn.textContent = '☆';
        btn.title = '添加到收藏';
      } else {
        favorites.add(musicId);
        btn.classList.add('active');
        btn.textContent = '★';
        btn.title = '取消收藏';
      }
      saveSettings();
      
      // If currently viewing favorites, refresh list
      if (currentCategory === 'favorites') {
        filterMusicList(musicSearchInput ? musicSearchInput.value.toLowerCase().trim() : '');
      }
    }

    // Check if a music has a specific vocal type
    function checkMusicHasVocalType(musicId, type) {
      if (!type) return true;
      return musicVocalsData.some(v => v.musicId === musicId && v.musicVocalType === type);
    }

    // Find next track index based on preference
    function getNextTrackIndex(currentIndex, direction, isShuffle) {
      let attempts = 0;
      let nextIndex = currentIndex;
      const maxAttempts = filteredMusicData.length;

      if (isShuffle) {
        while (attempts < maxAttempts) {
          const r = Math.floor(Math.random() * filteredMusicData.length);
          const music = filteredMusicData[r];
          if (checkMusicHasVocalType(music.id, preferredVocalType)) {
            return r;
          }
          attempts++;
        }
        return Math.floor(Math.random() * filteredMusicData.length);
      } else {
        while (attempts < maxAttempts) {
          nextIndex = (nextIndex + direction + filteredMusicData.length) % filteredMusicData.length;
          const music = filteredMusicData[nextIndex];
          if (checkMusicHasVocalType(music.id, preferredVocalType)) {
            return nextIndex;
          }
          attempts++;
        }
        return (currentIndex + direction + filteredMusicData.length) % filteredMusicData.length;
      }
    }

    // Format time helper
    function formatTime(seconds) {
      if (!isFinite(seconds)) return '0:00';
      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return `${mins}:${String(secs).padStart(2, '0')}`;
    }

    // Load music data from Sekai API
    async function loadMusicData() {
      try {
        musicList.innerHTML = '<div class="loading">加载音乐列表中...</div>';
        
        // Fetch musics.json
        const musicsResponse = await fetch('https://pj-sekai.oss-cn-shanghai.aliyuncs.com/musics.json');
        if (!musicsResponse.ok) throw new Error('Failed to fetch musics');
        musicData = await musicsResponse.json();
        
        // Fetch musicVocals.json
        const vocalsResponse = await fetch('https://pj-sekai.oss-cn-shanghai.aliyuncs.com/musicVocals.json');
        if (!vocalsResponse.ok) throw new Error('Failed to fetch music vocals');
        musicVocalsData = await vocalsResponse.json();
        
        // Fetch Chinese translations
        try {
          const titlesResponse = await fetch('https://pj-sekai.oss-cn-shanghai.aliyuncs.com/music_titles.json');
          if (titlesResponse.ok) {
            musicTitlesZhCN = await titlesResponse.json();
          }
        } catch (error) {
          console.warn('Failed to load Chinese translations:', error);
        }
        
        // Filter and prepare music list
        // Initial filter (just to populate filteredMusicData correctly for the first time)
        filterMusicList('');
        
        // Load saved settings and restore last track
        loadSettings();
        const savedTrackIndex = localStorage.getItem(STORAGE_KEYS.LAST_TRACK);
        if (savedTrackIndex !== null && parseInt(savedTrackIndex) >= 0 && parseInt(savedTrackIndex) < filteredMusicData.length) {
          // Load last track but don't auto-play
          loadTrack(parseInt(savedTrackIndex));
        }
      } catch (error) {
        console.error('Error loading music data:', error);
        musicList.innerHTML = '<div class="loading">加载失败，请重试</div>';
      }
    }

    // Display music list
    function displayMusicList(list) {
      if (list.length === 0) {
        musicList.innerHTML = '<div class="loading">没有找到歌曲</div>';
        return;
      }

      musicList.innerHTML = '';
      list.forEach((music, index) => {
        const item = document.createElement('div');
        item.className = 'music-item';
        // Use music.id to determine if this is the currently playing track
        if (currentMusicId === music.id) {
          item.classList.add('active');
        }
        
        // Always display original title + composer
        const displayTitle = music.title;
        const displayArtist = music.composer || 'Unknown';
        
        const isFav = favorites.has(music.id);
        
        item.innerHTML = `
          <div class="music-item-content">
            <div class="music-item-title" data-full-text="${displayTitle.replace(/"/g, '&quot;')}">${displayTitle}</div>
            <div class="music-item-artist">${displayArtist}</div>
          </div>
          <div class="music-item-actions">
            <button class="add-to-playlist-btn" title="添加到歌单">✚</button>
            <button class="favorite-btn ${isFav ? 'active' : ''}" title="${isFav ? '取消收藏' : '添加到我喜欢的音乐'}">
              ${isFav ? '★' : '☆'}
            </button>
          </div>
        `;
        
        // Check if title is too long and add scrolling animation
        const titleElement = item.querySelector('.music-item-title');
        const contentElement = item.querySelector('.music-item-content');
        
        // Wait for DOM to render to measure width
        requestAnimationFrame(() => {
          const containerWidth = contentElement.clientWidth;
          const textWidth = titleElement.scrollWidth;
          
          if (textWidth > containerWidth) {
            titleElement.classList.add('scrolling');
            // Allow overflow to show scrolling text
            contentElement.style.overflow = 'visible';
            
            // Calculate how much to scroll: move left by (textWidth - containerWidth)
            // This ensures the entire text becomes visible
            const scrollDistance = -(textWidth - containerWidth);
            titleElement.style.setProperty('--scroll-distance', `${scrollDistance}px`);
          }
        });
        
        // Click on item content to play
        const content = item.querySelector('.music-item-content');
        content.addEventListener('click', () => {
          const trackIndex = filteredMusicData.indexOf(music);
          pendingAutoPlay = true; // Set flag to auto-play after loading
          loadTrack(trackIndex);
        });
        
        // Click on add to playlist button
        const addBtn = item.querySelector('.add-to-playlist-btn');
        addBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          addToPlaylist(music.id, addBtn);
        });
        
        // Click on favorite button
        const favBtn = item.querySelector('.favorite-btn');
        favBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleFavorite(music.id, favBtn);
        });
        
        musicList.appendChild(item);
      });
    }

    // Category buttons
    const categoryBtns = document.querySelectorAll('.category-btn');
    categoryBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        // Update active state
        categoryBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        // Update category and filter
        const cat = btn.dataset.category;
        
        if (cat === 'playlists') {
          currentCategory = 'playlists';
          displayPlaylists();
        } else {
          currentCategory = cat;
          filterMusicList(musicSearchInput ? musicSearchInput.value.toLowerCase().trim() : '');
        }
      });
    });

    // Search functionality
    if (musicSearchInput) {
      musicSearchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        filterMusicList(query);
      });
    }

    // Get character names for vocal
    function getVocalCharacterNames(vocal) {
      if (!vocal.characters || vocal.characters.length === 0) return '';
      
      const names = vocal.characters
        .filter(c => c.characterType === 'game_character')
        .map(c => gameCharacters[c.characterId])
        .filter(name => name !== undefined);
      
      return names.length > 0 ? names.join('・') : '';
    }

    // Load a track
    function loadTrack(index, vocalId = null) {
      if (index < 0 || index >= filteredMusicData.length) return;
      
      currentTrackIndex = index;
      const music = filteredMusicData[index];
      currentMusicId = music.id; // Track the current music ID

      // Show loading spinner
      if (trackLoadingSpinner) trackLoadingSpinner.classList.remove('hidden');
      
      // Get all vocals for this music
      const availableVocals = musicVocalsData.filter(
        vocal => vocal.musicId === music.id
      );
      
      if (availableVocals.length === 0) {
        console.error('No vocals found for music:', music.id);
        return;
      }
      
      // Select vocal: use specified vocalId, or prefer preferredVocalType, or sekai, or first available
      let selectedVocal;
      
      if (vocalId) {
        // Manual selection
        selectedVocal = availableVocals.find(v => v.id === vocalId);
        if (selectedVocal) {
          preferredVocalType = selectedVocal.musicVocalType;
        }
      }
      
      if (!selectedVocal && preferredVocalType) {
        // Try to match preference
        selectedVocal = availableVocals.find(v => v.musicVocalType === preferredVocalType);
      }
      
      if (!selectedVocal) {
        // Prefer sekai version as fallback
        selectedVocal = availableVocals.find(v => v.musicVocalType === 'sekai');
      }
      
      if (!selectedVocal) {
        // Use first available
        selectedVocal = availableVocals[0];
      }
      
      currentVocalId = selectedVocal.id;
      
      // Always display original title
      const displayTitle = music.title;
      
      // Update UI
      trackTitle.textContent = displayTitle;
      trackArtist.textContent = `作曲: ${music.composer || 'Unknown'} · 作词: ${music.lyricist || 'Unknown'}`;
      
      // Create custom vocal selector
      trackVocal.innerHTML = '';
      
      if (availableVocals.length > 1) {
        const container = document.createElement('div');
        container.style.cssText = 'display: flex; gap: 6px; flex-wrap: wrap; justify-content: center;';
        
        availableVocals.forEach(vocal => {
          const btn = document.createElement('button');
          const characterNames = getVocalCharacterNames(vocal);
          const vocalLabel = vocal.caption || vocal.musicVocalType;
          
          btn.textContent = characterNames ? `${vocalLabel} (${characterNames})` : vocalLabel;
          btn.style.cssText = `
            background: ${vocal.id === selectedVocal.id ? 'linear-gradient(135deg, rgba(99, 102, 241, 0.4), rgba(168, 85, 247, 0.4))' : 'rgba(255,255,255,0.1)'};
            border: 1px solid ${vocal.id === selectedVocal.id ? 'rgba(99, 102, 241, 0.6)' : 'rgba(255,255,255,0.2)'};
            color: #fff;
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.2s;
            white-space: nowrap;
          `;
          
          btn.addEventListener('mouseenter', () => {
            if (vocal.id !== selectedVocal.id) {
              btn.style.background = 'rgba(255,255,255,0.15)';
              btn.style.transform = 'translateY(-1px)';
            }
          });
          
          btn.addEventListener('mouseleave', () => {
            if (vocal.id !== selectedVocal.id) {
              btn.style.background = 'rgba(255,255,255,0.1)';
              btn.style.transform = 'translateY(0)';
            }
          });
          
          btn.addEventListener('click', () => {
            const wasPlaying = isPlaying;
            if (wasPlaying) pauseTrack(); // Pause current first
            pendingAutoPlay = wasPlaying; // Set flag if was playing
            loadTrack(currentTrackIndex, vocal.id);
          });
          
          container.appendChild(btn);
        });
        
        trackVocal.appendChild(container);
      } else {
        const characterNames = getVocalCharacterNames(selectedVocal);
        const vocalLabel = selectedVocal.caption || 'セカイver.';
        trackVocal.textContent = characterNames ? `${vocalLabel} (${characterNames})` : vocalLabel;
      }
      
      // Update album cover with fallback
      const primaryCoverUrl = `https://pj-sekai.oss-cn-shanghai.aliyuncs.com/music/jacket/${music.assetbundleName}/${music.assetbundleName}.png`;
      const fallbackCoverUrl = `https://storage.nightcord.de5.net/music/jacket/${music.assetbundleName}/${music.assetbundleName}.png`;
      
      albumCover.src = primaryCoverUrl;
      albumCover.style.display = 'block';
      albumCover.style.opacity = '0.5'; // Dim while loading
      
      albumCover.onload = () => {
        albumCover.style.opacity = '1';
      };
      
      // If primary cover fails, try fallback
      albumCover.onerror = () => {
        if (albumCover.src === primaryCoverUrl) {
          albumCover.src = fallbackCoverUrl;
        }
      };
      
      // Build audio URL with primary source
      const primaryAudioUrl = `https://pj-sekai.oss-cn-shanghai.aliyuncs.com/music/long/${selectedVocal.assetbundleName}/${selectedVocal.assetbundleName}.flac`;
      const fallbackAudioUrl = `https://storage.nightcord.de5.net/music/long/${selectedVocal.assetbundleName}/${selectedVocal.assetbundleName}.flac`;
      
      // Clear previous onerror handler to prevent conflicts
      cdAudioPlayer.onerror = null;
      
      // Try primary audio first
      cdAudioPlayer.src = primaryAudioUrl;
      cdAudioPlayer.load(); // Explicitly load the new source
      
      // If primary audio fails, use fallback (and preserve pendingAutoPlay flag)
      cdAudioPlayer.onerror = () => {
        if (cdAudioPlayer.src === primaryAudioUrl) {
          console.log('Primary audio source failed, trying fallback... (pendingAutoPlay:', pendingAutoPlay, ')');
          cdAudioPlayer.onerror = null; // Clear handler before changing src
          cdAudioPlayer.src = fallbackAudioUrl;
          cdAudioPlayer.load();
          // pendingAutoPlay flag is preserved, canplay event will handle auto-play
        } else {
          // Both sources failed
          console.error('Both audio sources failed');
          if (trackLoadingSpinner) trackLoadingSpinner.classList.add('hidden');
          pendingAutoPlay = false;
        }
      };
      
      // Set start time to skip filler (blank audio at beginning)
      const fillerSec = music.fillerSec || 0;
      if (fillerSec > 0) {
        cdAudioPlayer.addEventListener('loadedmetadata', function setStartTime() {
          cdAudioPlayer.removeEventListener('loadedmetadata', setStartTime);
          cdAudioPlayer.currentTime = fillerSec;
        });
      }
      
      // Update active item in list (use music ID instead of index)
      document.querySelectorAll('.music-item').forEach((item) => {
        // We already set the active class based on currentMusicId in displayMusicList
        // But we need to update it here as well in case the list wasn't re-rendered
        const itemContent = item.querySelector('.music-item-content');
        const itemIndex = Array.from(item.parentElement.children).indexOf(item);
        const itemMusic = filteredMusicData[itemIndex];
        item.classList.toggle('active', itemMusic && itemMusic.id === music.id);
      });
      
      // Save current track index to localStorage
      saveSettings();
      
      // Reset progress
      progressBar.value = 0;
      currentTimeEl.textContent = '0:00';
    }

    const albumCoverContainer = document.querySelector('.album-cover-container');
    const albumCoverElement = document.getElementById('albumCover');
    const cdAnimationElement = document.getElementById('cdAnimation');

    // Play track
    function playTrack() {
      console.log('[playTrack] Called, currentTrackIndex:', currentTrackIndex);
      if (currentTrackIndex < 0) {
        // Play first track if none selected
        console.log('[playTrack] No track selected, loading first track');
        pendingAutoPlay = true;
        loadTrack(0);
        return;
      }
      
      console.log('[playTrack] Attempting to play audio, src:', cdAudioPlayer.src, 'readyState:', cdAudioPlayer.readyState);
      
      // If audio is not ready yet, set flag and wait for canplay event
      if (cdAudioPlayer.readyState < 2) {
        console.log('[playTrack] Audio not ready, setting pendingAutoPlay flag');
        if (trackLoadingSpinner) trackLoadingSpinner.classList.remove('hidden');
        pendingAutoPlay = true;
        return;
      }
      
      cdAudioPlayer.play()
        .then(() => {
          console.log('[playTrack] Play successful');
          isPlaying = true;
          playPauseBtn.textContent = '⏸️';
          
          // Start CD animation smoothly
          if (albumCoverContainer) {
            albumCoverContainer.classList.add('playing');
          }
        })
        .catch(error => {
          console.error('[playTrack] Error playing audio:', error);
        });
    }

    // Pause track
    function pauseTrack() {
      console.log('[pauseTrack] Called');
      cdAudioPlayer.pause();
      isPlaying = false;
      playPauseBtn.textContent = '▶️';
      
      // Stop CD animation smoothly
      if (albumCoverContainer) {
        // Get current rotation from computed style
        const coverStyle = window.getComputedStyle(albumCoverElement);
        const matrix = coverStyle.transform;
        
        if (matrix && matrix !== 'none') {
          // Parse rotation from matrix
          const values = matrix.match(/matrix.*\((.+)\)/)[1].split(', ');
          const a = parseFloat(values[0]);
          const b = parseFloat(values[1]);
          const currentAngle = Math.round(Math.atan2(b, a) * (180 / Math.PI));
          
          // Remove animation class first
          albumCoverContainer.classList.remove('playing');
          
          // Set current rotation as static transform
          albumCoverElement.style.transform = `rotate(${currentAngle}deg)`;
          if (cdAnimationElement) {
            cdAnimationElement.style.transform = `rotate(${currentAngle}deg)`;
          }
          
          // Smoothly transition back to 0
          requestAnimationFrame(() => {
            albumCoverElement.style.transition = 'transform 0.8s ease-out, border-radius 0.5s ease';
            albumCoverElement.style.transform = 'rotate(0deg)';
            if (cdAnimationElement) {
              cdAnimationElement.style.transition = 'opacity 0.5s, transform 0.8s ease-out';
              cdAnimationElement.style.transform = 'rotate(0deg)';
            }
          });
        } else {
          albumCoverContainer.classList.remove('playing');
        }
      }
    }

    // Toggle play/pause
    if (playPauseBtn) {
      playPauseBtn.addEventListener('click', () => {
        if (isPlaying) {
          pauseTrack();
        } else {
          playTrack();
        }
      });
    }

    // Previous track
    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        const wasPlaying = isPlaying;
        console.log('[Prev] Was playing:', wasPlaying);
        pauseTrack(); // Pause current first
        pendingAutoPlay = wasPlaying; // Set flag for auto-play
        
        const nextIndex = getNextTrackIndex(currentTrackIndex, -1, isShuffleOn);
        console.log('[Prev] Next index:', nextIndex);
        loadTrack(nextIndex);
      });
    }

    // Next track
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        const wasPlaying = isPlaying;
        console.log('[Next] Was playing:', wasPlaying);
        pauseTrack(); // Pause current first
        pendingAutoPlay = wasPlaying; // Set flag for auto-play
        
        const nextIndex = getNextTrackIndex(currentTrackIndex, 1, isShuffleOn);
        console.log('[Next] Next index:', nextIndex);
        loadTrack(nextIndex);
      });
    }

    // Shuffle toggle
    if (shuffleBtn) {
      shuffleBtn.addEventListener('click', () => {
        isShuffleOn = !isShuffleOn;
        shuffleBtn.classList.toggle('active', isShuffleOn);
        saveSettings(); // Save preference
      });
    }

    // Repeat toggle
    if (repeatBtn) {
      repeatBtn.addEventListener('click', () => {
        isRepeatOn = !isRepeatOn;
        repeatBtn.classList.toggle('active', isRepeatOn);
        cdAudioPlayer.loop = isRepeatOn;
        saveSettings(); // Save preference
      });
    }

    // Progress bar update
    if (cdAudioPlayer) {
      // Loading state handlers
      cdAudioPlayer.addEventListener('loadstart', () => {
        if (trackLoadingSpinner) trackLoadingSpinner.classList.remove('hidden');
      });
      
      cdAudioPlayer.addEventListener('waiting', () => {
        if (trackLoadingSpinner) trackLoadingSpinner.classList.remove('hidden');
      });
      
      cdAudioPlayer.addEventListener('canplay', () => {
        if (trackLoadingSpinner) trackLoadingSpinner.classList.add('hidden');
        
        // Auto-play if flag is set
        if (pendingAutoPlay) {
          console.log('[canplay] Auto-playing track (src:', cdAudioPlayer.src, ')');
          pendingAutoPlay = false;
          setTimeout(() => {
            playTrack();
          }, 50); // Small delay to ensure audio is truly ready
        }
      });
      
      cdAudioPlayer.addEventListener('playing', () => {
        if (trackLoadingSpinner) trackLoadingSpinner.classList.add('hidden');
      });

      cdAudioPlayer.addEventListener('error', () => {
        console.error('[error event] Audio error, src:', cdAudioPlayer.src);
        if (trackLoadingSpinner) trackLoadingSpinner.classList.add('hidden');
        // Don't clear pendingAutoPlay here - onerror handler will manage fallback
      });

      cdAudioPlayer.addEventListener('timeupdate', () => {
        if (cdAudioPlayer.duration) {
          const progress = (cdAudioPlayer.currentTime / cdAudioPlayer.duration) * 100;
          progressBar.value = progress;
          currentTimeEl.textContent = formatTime(cdAudioPlayer.currentTime);
        }
      });

      cdAudioPlayer.addEventListener('loadedmetadata', () => {
        totalTimeEl.textContent = formatTime(cdAudioPlayer.duration);
      });

      cdAudioPlayer.addEventListener('ended', () => {
        if (!isRepeatOn) {
          if (isShuffleOn) {
            // Random next track
            const nextIndex = getNextTrackIndex(currentTrackIndex, 1, true);
            pendingAutoPlay = true; // Set flag for auto-play
            loadTrack(nextIndex);
          } else {
            // Sequential next
            const nextIndex = getNextTrackIndex(currentTrackIndex, 1, false);
            
            // Stop if we wrapped around (nextIndex <= currentTrackIndex)
            if (nextIndex > currentTrackIndex) {
              pendingAutoPlay = true; // Set flag for auto-play
              loadTrack(nextIndex);
            } else {
              // End of playlist
              pauseTrack();
              progressBar.value = 0;
              currentTimeEl.textContent = '0:00';
            }
          }
        }
        // If repeat is on, audio will loop automatically
      });
    }

    // Progress bar seek
    if (progressBar) {
      progressBar.addEventListener('input', (e) => {
        const seekTime = (e.target.value / 100) * cdAudioPlayer.duration;
        cdAudioPlayer.currentTime = seekTime;
      });
    }

    // Volume control
    if (cdVolumeSlider) {
      cdVolumeSlider.addEventListener('input', (e) => {
        cdAudioPlayer.volume = parseFloat(e.target.value);
        saveSettings(); // Save volume preference
      });
      // Set initial volume from saved settings or default
      const savedVolume = localStorage.getItem(STORAGE_KEYS.VOLUME);
      if (savedVolume !== null) {
        cdAudioPlayer.volume = parseFloat(savedVolume);
        cdVolumeSlider.value = savedVolume;
      } else {
        cdAudioPlayer.volume = parseFloat(cdVolumeSlider.value);
      }
    }

    // Toggle panel
    function togglePanel() {
      cdPlayerPanel.classList.toggle('hidden');
      // Load music data when panel is opened for the first time
      if (!cdPlayerPanel.classList.contains('hidden') && filteredMusicData.length === 0) {
        loadMusicData();
      }
    }

    // Event listeners
    cdPlayerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel();
    });

    cdPlayerCloseBtn.addEventListener('click', () => {
      togglePanel();
    });

    // Prevent clicks inside panel from propagating
    cdPlayerPanel.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  })();

})();
