'use strict';

(() => {
  const {
    drawVU,
    drawScope,
    drawCassette,
    drawVinyl,
    drawAetherMorph,
    AETHER_PRESETS,
    vuDbToPos
  } = window.Instruments;

  // 7 Visualizers (4 Braun Hardware + 3 Aether-Morph 3D WebGL)
  const MODES = [
    { id: 'scope',       viewId: 'scopeView',       label: 'Oscilloscopio CRT' },
    { id: 'cassette',    viewId: 'cassetteView',    label: 'Musicassetta' },
    { id: 'vu',          viewId: 'vuView',          label: 'Dual VU Meter' },
    { id: 'vinyl',       viewId: 'vinylView',       label: 'Giradischi Vinile' },
    { id: 'aetherBlob',  viewId: 'aetherBlobView',  label: 'Aether Blob (Cerchio)' },
    { id: 'aetherMacro', viewId: 'aetherMacroView', label: 'Aether Blob Macro (Cerchio Grande)' },
    { id: 'aetherAura',  viewId: 'aetherAuraView',  label: 'Aether Aura (Tutto Schermo)' }
  ];

  // Load enabled visualizers from localStorage (auto-enabling newly introduced visualizers)
  let enabledModeIds = new Set(MODES.map((m) => m.id));
  try {
    const savedModes = JSON.parse(localStorage.getItem('spotteck_enabled_modes') || 'null');
    const knownModes = JSON.parse(localStorage.getItem('spotteck_known_modes') || '[]');
    if (Array.isArray(savedModes) && savedModes.length > 0) {
      const valid = savedModes.filter((id) => MODES.some((m) => m.id === id));
      if (valid.length > 0) {
        enabledModeIds = new Set(valid);
        MODES.forEach((m) => {
          if (!Array.isArray(knownModes) || !knownModes.includes(m.id)) {
            enabledModeIds.add(m.id);
          }
        });
      }
    }
    localStorage.setItem('spotteck_known_modes', JSON.stringify(MODES.map((m) => m.id)));
  } catch (_e) {}

  function saveEnabledModes() {
    try {
      localStorage.setItem('spotteck_enabled_modes', JSON.stringify(Array.from(enabledModeIds)));
    } catch (_e) {}
  }

  function playlistIdOf(input) {
    if (!input) return null;
    const m = String(input).match(/playlist[/:]([A-Za-z0-9]+)/);
    if (m) return m[1];
    return String(input).split('?')[0].split('#')[0].split(':').pop().trim();
  }

  function isSamePlaylist(a, b) {
    if (!a || !b) return false;
    const idA = playlistIdOf(a);
    const idB = playlistIdOf(b);
    return !!(idA && idB && idA === idB);
  }

  // Load hidden playlists from localStorage
  let hiddenPlaylistIds = new Set();
  try {
    const savedHidden = JSON.parse(localStorage.getItem('spotteck_hidden_playlists') || '[]');
    if (Array.isArray(savedHidden)) {
      hiddenPlaylistIds = new Set(savedHidden);
    }
  } catch (_e) {}

  function saveHiddenPlaylists() {
    try {
      localStorage.setItem('spotteck_hidden_playlists', JSON.stringify(Array.from(hiddenPlaylistIds)));
    } catch (_e) {}
  }

  // Custom playlist order from localStorage
  let customPlaylistOrder = [];
  try {
    const savedOrder = JSON.parse(localStorage.getItem('spotteck_playlist_order') || '[]');
    if (Array.isArray(savedOrder)) {
      customPlaylistOrder = savedOrder;
    }
  } catch (_e) {}

  function savePlaylistOrder() {
    try {
      customPlaylistOrder = playlists.map((p) => p.id);
      localStorage.setItem('spotteck_playlist_order', JSON.stringify(customPlaylistOrder));
    } catch (_e) {}
  }

  function applyCustomPlaylistOrder(list) {
    if (!Array.isArray(list) || list.length <= 1) return list;
    if (!customPlaylistOrder || customPlaylistOrder.length === 0) return list;

    const orderMap = new Map();
    customPlaylistOrder.forEach((id, idx) => {
      const clean = playlistIdOf(id) || String(id);
      orderMap.set(clean, idx);
      orderMap.set(String(id), idx);
    });

    return [...list].sort((a, b) => {
      const keyA = playlistIdOf(a.id) || String(a.id);
      const keyB = playlistIdOf(b.id) || String(b.id);
      const posA = orderMap.has(keyA) ? orderMap.get(keyA) : (orderMap.has(String(a.id)) ? orderMap.get(String(a.id)) : 999999);
      const posB = orderMap.has(keyB) ? orderMap.get(keyB) : (orderMap.has(String(b.id)) ? orderMap.get(String(b.id)) : 999999);
      return posA - posB;
    });
  }

  let modeIndex = 0;
  // Independent preset index per Blob / Anadol mode
  const blobPresetIndices = {
    aetherBlob: 0,
    aetherMacro: 0,
    aetherAura: 0
  };

  // Custom Aether-Morph Live Parameters (ONLY for Full-Screen Aura Blob via Option/Alt HUD)
  // Exact Aether initial setup (baseSize: 0.5, complexity: 0.45, saturation: 1.0, bg: #000510 -> #002030) + Aura at 100% max
  const AETHER_AURA_MAX_SCALE = 7.0;
  const AETHER_AURA_DEFAULTS = {
    biomass: 0.50,    // 50% (Aether initial baseSize: 0.5 — slightly smaller)
    morphing: 0.50,   // 50% (Aether initial complexity: 0.45)
    metabolism: 1.00, // Fixed, non-modifiable
    aura: 7.00,       // 100% maximum possible at startup (90px optical blur + full halo)
    vibrance: 1.00,   // 100% (Aether initial saturation: 1.0)
    bgMode: 'color'   // 'color' (#000510 -> #002030 Aether blue gradient) | 'black' (#000000)
  };

  const aetherCustomParams = { ...AETHER_AURA_DEFAULTS };

  // DOM Elements
  const faceplate = document.getElementById('faceplate');
  const zenBtn = document.getElementById('zenBtn');
  const zenIcon = document.getElementById('zenIcon');
  const stage = document.getElementById('stage');
  const presetToast = document.getElementById('presetToast');
  const bgArtwork = document.getElementById('bgArtwork');
  const trackNameEl = document.getElementById('trackName');
  const artistNameEl = document.getElementById('artistName');
  const playBtn = document.getElementById('playBtn');
  const playIcon = document.getElementById('playIcon');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const shuffleBtn = document.getElementById('shuffleBtn');
  const shuffleDot = document.getElementById('shuffleDot');
  const volumeSlider = document.getElementById('volumeSlider');
  const settingsBtn = document.getElementById('settingsBtn');
  const progressBar = document.getElementById('progressBar');
  const progressFill = document.getElementById('progressFill');

  // Option-Hold Aether HUD Elements
  const aetherAuraView = document.getElementById('aetherAuraView');
  const aetherHud = document.getElementById('aetherHud');
  const hudBiomass = document.getElementById('hudBiomass');
  const hudBiomassVal = document.getElementById('hudBiomassVal');
  const hudMorphing = document.getElementById('hudMorphing');
  const hudMorphingVal = document.getElementById('hudMorphingVal');
  const hudAura = document.getElementById('hudAura');
  const hudAuraVal = document.getElementById('hudAuraVal');
  const hudVibrance = document.getElementById('hudVibrance');
  const hudVibranceVal = document.getElementById('hudVibranceVal');
  const hudBgColor = document.getElementById('hudBgColor');
  const hudBgBlack = document.getElementById('hudBgBlack');
  const hudResetBtn = document.getElementById('hudResetBtn');

  const playlistGrid = document.getElementById('playlistGrid');
  const drawer = document.getElementById('drawer');
  const drawerCover = document.getElementById('drawerCover');
  const drawerTitle = document.getElementById('drawerTitle');
  const drawerPlayAll = document.getElementById('drawerPlayAll');
  const drawerClose = document.getElementById('drawerClose');
  const drawerList = document.getElementById('drawerList');
  const drawerRemove = document.getElementById('drawerRemove');

  const addModal = document.getElementById('addModal');
  const addInput = document.getElementById('addInput');
  const addError = document.getElementById('addError');
  const addCancel = document.getElementById('addCancel');
  const addConfirm = document.getElementById('addConfirm');

  const settingsModal = document.getElementById('settingsModal');
  const settingsClose = document.getElementById('settingsClose');
  const settingsTabSystem = document.getElementById('settingsTabSystem');
  const settingsTabPlaylists = document.getElementById('settingsTabPlaylists');
  const settingsPageSystem = document.getElementById('settingsPageSystem');
  const settingsPagePlaylists = document.getElementById('settingsPagePlaylists');
  const playlistChecklist = document.getElementById('playlistChecklist');
  const playlistShowAll = document.getElementById('playlistShowAll');
  const playlistHideAll = document.getElementById('playlistHideAll');
  const profileAvatar = document.getElementById('profileAvatar');
  const profileName = document.getElementById('profileName');
  const profileSub = document.getElementById('profileSub');
  const profileLed = document.getElementById('profileLed');
  const profileLoginBtn = document.getElementById('profileLoginBtn');
  const profileLogoutBtn = document.getElementById('profileLogoutBtn');
  const visChecklist = document.getElementById('visChecklist');
  const visSelectAll = document.getElementById('visSelectAll');
  const zenHideHudRow = document.getElementById('zenHideHudRow');
  const zenHideHudBox = document.getElementById('zenHideHudBox');

  // Canvases
  const scopeCanvas = document.getElementById('scopeCanvas');
  const cassetteCanvas = document.getElementById('cassetteCanvas');
  const vuL = document.getElementById('vuL');
  const vuR = document.getElementById('vuR');
  const vinylCanvas = document.getElementById('vinylCanvas');
  const aetherBlobCanvas = document.getElementById('aetherBlobCanvas');
  const aetherMacroCanvas = document.getElementById('aetherMacroCanvas');
  const aetherAuraCanvas = document.getElementById('aetherAuraCanvas');
  const aetherAuraGlow = document.getElementById('aetherAuraGlow');

  // Playback & Cover State
  const player = {
    isRunning: false,
    isPlaying: false,
    track: 'Spotteck',
    artist: 'Seleziona una playlist per iniziare',
    album: '',
    duration: 0,
    position: 0,
    lastPollAt: performance.now(),
    shuffling: true,
    artwork: '',
    trackUri: '',
    activePlaylistId: null
  };

  const coverImage = new Image();
  coverImage.crossOrigin = 'anonymous';
  let currentArtworkUrl = '';

  let toastTimer = null;
  function showToast(text, duration = 1350) {
    if (!presetToast) return;
    presetToast.textContent = text;
    presetToast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => presetToast.classList.remove('show'), duration);
  }

  function isBlobMode(id) {
    return id === 'aetherBlob' || id === 'aetherMacro' || id === 'aetherAura';
  }

  // ====================================================================
  // TOP-RIGHT FULL-SCREEN / ZEN VISUALIZER MODE TOGGLE
  // ====================================================================
  let isZenMode = false;
  let zenHideHud = true;
  try {
    const savedZenHide = localStorage.getItem('spotteck_zen_hide_hud');
    if (savedZenHide !== null) {
      zenHideHud = savedZenHide === 'true';
    }
  } catch (_e) {}

  function syncZenHideHudUI() {
    if (faceplate) faceplate.classList.toggle('zen-hide-hud', zenHideHud);
    if (zenHideHudRow) zenHideHudRow.classList.toggle('checked', zenHideHud);
    if (zenHideHudBox) {
      zenHideHudBox.innerHTML = zenHideHud
        ? '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#FFF" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'
        : '';
    }
  }
  syncZenHideHudUI();

  if (zenHideHudRow) {
    zenHideHudRow.addEventListener('click', () => {
      zenHideHud = !zenHideHud;
      try { localStorage.setItem('spotteck_zen_hide_hud', String(zenHideHud)); } catch (_e) {}
      syncZenHideHudUI();
    });
  }

  function setZenMode(val) {
    isZenMode = !!val;
    if (faceplate) {
      faceplate.classList.toggle('zen-mode', isZenMode);
      faceplate.classList.toggle('zen-hide-hud', zenHideHud);
      if (!isZenMode) faceplate.classList.remove('zen-hover-controls');
    }
    if (zenBtn) zenBtn.classList.toggle('active', isZenMode);
    if (zenIcon) {
      if (isZenMode) {
        zenIcon.innerHTML = '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7"/>';
      } else {
        zenIcon.innerHTML = '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>';
      }
    }
  }
  if (zenBtn) {
    zenBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setZenMode(!isZenMode);
    });
  }

  // Smoothly reveal track title & transport buttons when hovering the bottom zone in Zen Mode
  const leftBayEl = document.querySelector('.left-bay');
  let zenHoverHideTimer = null;

  function setZenControlsHovered(hovered) {
    if (!faceplate) return;
    if (hovered) {
      clearTimeout(zenHoverHideTimer);
      faceplate.classList.add('zen-hover-controls');
    } else {
      clearTimeout(zenHoverHideTimer);
      zenHoverHideTimer = setTimeout(() => {
        faceplate.classList.remove('zen-hover-controls');
      }, 220);
    }
  }

  if (leftBayEl) {
    leftBayEl.addEventListener('mousemove', (e) => {
      if (!isZenMode || !zenHideHud) return;
      const rect = leftBayEl.getBoundingClientRect();
      const distFromBottom = rect.bottom - e.clientY;
      const horizCenterDist = Math.abs(e.clientX - (rect.left + rect.width / 2));
      const inBottomZone = distFromBottom <= 112 && horizCenterDist <= Math.min(280, rect.width * 0.45);
      setZenControlsHovered(inBottomZone);
    });
    leftBayEl.addEventListener('mouseleave', () => {
      if (isZenMode) setZenControlsHovered(false);
    });
  }

  // ====================================================================
  // OPTION (ALT) HOLD: AETHER AURA CONTROL MENU (ONLY FOR FULL-SCREEN AURA)
  // Stays visible for 2.2s after releasing Option (resets on slider drag)
  // ====================================================================
  let hudHideTimer = null;
  let isAltDown = false;

  function scheduleHudHide(delayMs = 2200) {
    clearTimeout(hudHideTimer);
    hudHideTimer = setTimeout(() => {
      if (!isAltDown && aetherHud) {
        aetherHud.classList.add('hidden');
      }
    }, delayMs);
  }

  function syncHudUI() {
    const bioPct = Math.round((aetherCustomParams.biomass * 100) / 10) * 10;
    const morphPct = Math.round((aetherCustomParams.morphing * 100) / 10) * 10;
    const auraPct = Math.round(((aetherCustomParams.aura / AETHER_AURA_MAX_SCALE) * 100) / 10) * 10;
    const vibPct = Math.round((aetherCustomParams.vibrance * 100) / 10) * 10;
    const isBlack = aetherCustomParams.bgMode === 'black';

    if (hudBiomass) { hudBiomass.value = String(bioPct); hudBiomassVal.textContent = `${bioPct}%`; }
    if (hudMorphing) { hudMorphing.value = String(morphPct); hudMorphingVal.textContent = `${morphPct}%`; }
    if (hudAura) { hudAura.value = String(auraPct); hudAuraVal.textContent = `${auraPct}%`; }
    if (hudVibrance) { hudVibrance.value = String(vibPct); hudVibranceVal.textContent = `${vibPct}%`; }

    if (hudBgColor) hudBgColor.classList.toggle('active', !isBlack);
    if (hudBgBlack) hudBgBlack.classList.toggle('active', isBlack);
    if (aetherAuraView) aetherAuraView.classList.toggle('pure-black', isBlack);
  }

  function resetCustomAetherParams() {
    Object.assign(aetherCustomParams, AETHER_AURA_DEFAULTS);
    syncHudUI();
  }

  if (aetherHud) {
    // Clicking the backdrop outside .aether-hud-panel closes the HUD immediately
    aetherHud.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target === aetherHud) {
        clearTimeout(hudHideTimer);
        aetherHud.classList.add('hidden');
      } else if (!isAltDown) {
        scheduleHudHide(2200);
      }
    });
    aetherHud.addEventListener('contextmenu', (e) => e.stopPropagation());
    aetherHud.addEventListener('input', () => {
      if (!isAltDown) scheduleHudHide(2200);
    });
  }

  if (hudBiomass) {
    hudBiomass.addEventListener('input', () => {
      const pct = Number(hudBiomass.value);
      aetherCustomParams.biomass = pct / 100;
      hudBiomassVal.textContent = `${pct}%`;
    });
  }
  if (hudMorphing) {
    hudMorphing.addEventListener('input', () => {
      const pct = Number(hudMorphing.value);
      aetherCustomParams.morphing = pct / 100;
      hudMorphingVal.textContent = `${pct}%`;
    });
  }
  if (hudAura) {
    hudAura.addEventListener('input', () => {
      const pct = Number(hudAura.value);
      aetherCustomParams.aura = (pct / 100) * AETHER_AURA_MAX_SCALE;
      hudAuraVal.textContent = `${pct}%`;
    });
  }
  if (hudVibrance) {
    hudVibrance.addEventListener('input', () => {
      const pct = Number(hudVibrance.value);
      aetherCustomParams.vibrance = pct / 100;
      hudVibranceVal.textContent = `${pct}%`;
    });
  }
  if (hudBgColor) {
    hudBgColor.addEventListener('click', (e) => {
      e.stopPropagation();
      aetherCustomParams.bgMode = 'color';
      syncHudUI();
      if (!isAltDown) scheduleHudHide(2200);
    });
  }
  if (hudBgBlack) {
    hudBgBlack.addEventListener('click', (e) => {
      e.stopPropagation();
      aetherCustomParams.bgMode = 'black';
      syncHudUI();
      if (!isAltDown) scheduleHudHide(2200);
    });
  }
  if (hudResetBtn) {
    hudResetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      resetCustomAetherParams();
      if (!isAltDown) scheduleHudHide(2200);
    });
  }

  // Show Aether HUD while holding Option (Alt) key ONLY in full-screen Aether Aura mode
  // Also support ArrowLeft / ArrowRight / Space and Media keys
  window.addEventListener('keydown', (e) => {
    const tag = e.target && e.target.tagName ? e.target.tagName.toUpperCase() : '';
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA';

    if (e.key === 'Alt') {
      isAltDown = true;
      clearTimeout(hudHideTimer);
      const activeId = MODES[modeIndex].id;
      if (activeId === 'aetherAura' && aetherHud && aetherHud.classList.contains('hidden')) {
        syncHudUI();
        aetherHud.classList.remove('hidden');
      }
      return;
    }

    if (e.key === 'Escape' && isZenMode) {
      setZenMode(false);
      return;
    }

    if (inInput) return;

    if (e.key === 'ArrowRight' || e.key === 'MediaTrackNext') {
      e.preventDefault();
      window.spotteck.next();
      setTimeout(pollSpotify, 180);
    } else if (e.key === 'ArrowLeft' || e.key === 'MediaTrackPrevious') {
      e.preventDefault();
      window.spotteck.prev();
      setTimeout(pollSpotify, 180);
    } else if (e.key === ' ' || e.key === 'MediaPlayPause') {
      e.preventDefault();
      window.spotteck.playPause();
      setTimeout(pollSpotify, 180);
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === 'Alt') {
      isAltDown = false;
      if (aetherHud && !aetherHud.classList.contains('hidden')) {
        scheduleHudHide(2200);
      }
    }
  });

  window.addEventListener('blur', () => {
    isAltDown = false;
    if (aetherHud && !aetherHud.classList.contains('hidden')) {
      scheduleHudHide(1200);
    }
  });

  // Switch Visualizer on Stage Left-Click (only cycling enabled modes)
  function setMode(idx) {
    const total = MODES.length;
    let candidate = ((idx % total) + total) % total;
    for (let step = 0; step < total; step++) {
      const m = MODES[candidate];
      if (enabledModeIds.has(m.id)) {
        modeIndex = candidate;
        break;
      }
      candidate = (candidate + 1) % total;
    }

    const current = MODES[modeIndex];
    MODES.forEach((m) => {
      const el = document.getElementById(m.viewId);
      if (el) el.classList.toggle('hidden', m.id !== current.id);
    });
    if (current.id !== 'aetherAura' && aetherHud) {
      clearTimeout(hudHideTimer);
      aetherHud.classList.add('hidden');
    }
  }

  stage.addEventListener('click', (e) => {
    if (e.altKey || (aetherHud && !aetherHud.classList.contains('hidden'))) return;
    setMode(modeIndex + 1);
  });

  // Right-Click on Stage: Cycle Preset for Blob or Refik Anadol visualizers
  stage.addEventListener('contextmenu', (e) => {
    const activeId = MODES[modeIndex].id;
    if (isBlobMode(activeId)) {
      e.preventDefault();
      const curIdx = blobPresetIndices[activeId] || 0;
      const nextIdx = (curIdx + 1) % AETHER_PRESETS.length;
      blobPresetIndices[activeId] = nextIdx;
      const p = AETHER_PRESETS[nextIdx];
      if (p) showToast(`Preset: ${p.name}`);
    }
  });

  // Ensure initial mode is one of the enabled modes
  setMode(0);

  const bridge = window.spotteck || window.spotdeck;

  // Format seconds -> m:ss
  // Refused controls (signed out, Free plan, nothing playing) explain themselves on the stage.
  function reportControl(result) {
    if (result?.error) showToast(result.error, 3200);
  }

  function fmtDuration(sec) {
    const s = Math.max(0, Math.round(sec || 0));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${rem < 10 ? '0' : ''}${rem}`;
  }

  // ====================================================================
  // SETTINGS & PROFILE MODAL
  // ====================================================================
  function renderVisChecklist() {
    if (!visChecklist) return;
    visChecklist.innerHTML = '';
    MODES.forEach((m) => {
      const isChecked = enabledModeIds.has(m.id);
      const row = document.createElement('div');
      row.className = 'vis-item' + (isChecked ? ' checked' : '');

      const nameSpan = document.createElement('span');
      nameSpan.textContent = m.label;

      const box = document.createElement('div');
      box.className = 'vis-toggle';
      if (isChecked) {
        box.innerHTML = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#FFF" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
      }

      row.appendChild(nameSpan);
      row.appendChild(box);

      row.addEventListener('click', () => {
        if (enabledModeIds.has(m.id)) {
          if (enabledModeIds.size <= 1) return; // Keep at least 1 active
          enabledModeIds.delete(m.id);
        } else {
          enabledModeIds.add(m.id);
        }
        saveEnabledModes();
        if (!enabledModeIds.has(MODES[modeIndex].id)) {
          setMode(modeIndex + 1);
        }
        renderVisChecklist();
      });

      visChecklist.appendChild(row);
    });
  }

  async function refreshProfileUI() {
    if (!bridge || !bridge.getProfile) return;
    try {
      const res = await bridge.getProfile();
      const status = document.getElementById('spotifyStatus');
      status.textContent = res?.message || '';
      if (res && res.authenticated && res.profile) {
        const p = res.profile;
        profileName.textContent = p.name || 'Account Spotify';
        profileSub.textContent = `${p.product || 'Premium'} · Spotteck`;
        profileLed.classList.add('on');
        if (p.avatar) {
          const img = document.createElement('img');
          img.src = p.avatar;
          img.alt = '';
          profileAvatar.replaceChildren(img);
        } else {
          profileAvatar.textContent = (p.name || 'S').charAt(0).toUpperCase();
        }
        profileLoginBtn.textContent = 'Cambia Account';
        profileLogoutBtn.style.display = '';
      } else {
        const signedOut = !res || res.readiness === 'signed-out';
        profileName.textContent = signedOut ? 'Non connesso' : 'Account Spotify';
        profileSub.textContent = signedOut ? 'Accedi con Spotify Premium' : (res.message || 'Spotify');
        profileLed.classList.remove('on');
        profileAvatar.textContent = '–';
        profileLoginBtn.textContent = signedOut ? 'Accedi' : 'Cambia Account';
        profileLogoutBtn.style.display = signedOut ? 'none' : '';
      }
    } catch (_e) {}
  }

  function switchSettingsTab(tab) {
    if (tab === 'playlists') {
      settingsTabSystem?.classList.remove('active');
      settingsTabPlaylists?.classList.add('active');
      settingsPageSystem?.classList.add('hidden');
      settingsPagePlaylists?.classList.remove('hidden');
      renderPlaylistChecklist();
    } else {
      settingsTabPlaylists?.classList.remove('active');
      settingsTabSystem?.classList.add('active');
      settingsPagePlaylists?.classList.add('hidden');
      settingsPageSystem?.classList.remove('hidden');
      renderVisChecklist();
    }
  }

  settingsTabSystem?.addEventListener('click', () => switchSettingsTab('system'));
  settingsTabPlaylists?.addEventListener('click', () => switchSettingsTab('playlists'));

  let draggedPlaylistIndex = null;
  let draggedTileId = null;
  let hasDraggedRecently = false;

  function renderPlaylistChecklist() {
    if (!playlistChecklist) return;
    playlistChecklist.innerHTML = '';

    if (!Array.isArray(playlists) || playlists.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'playlist-empty-hint';
      empty.textContent = 'Nessuna playlist presente in libreria.';
      playlistChecklist.appendChild(empty);
      return;
    }

    playlists.forEach((p, index) => {
      const isVisible = !hiddenPlaylistIds.has(p.id);
      const row = document.createElement('div');
      row.className = 'playlist-item' + (isVisible ? ' checked' : '');
      row.draggable = true;
      row.dataset.index = index;

      const handle = document.createElement('span');
      handle.className = 'playlist-drag-handle';
      handle.title = 'Trascina per riordinare';
      handle.innerHTML = '<svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor"><circle cx="2" cy="2" r="1.1"/><circle cx="6" cy="2" r="1.1"/><circle cx="2" cy="6" r="1.1"/><circle cx="6" cy="6" r="1.1"/><circle cx="2" cy="10" r="1.1"/><circle cx="6" cy="10" r="1.1"/></svg>';

      const meta = document.createElement('div');
      meta.className = 'playlist-item-meta';

      if (p.image) {
        const thumb = document.createElement('img');
        thumb.className = 'playlist-item-thumb';
        thumb.src = p.image;
        thumb.alt = '';
        thumb.loading = 'lazy';
        thumb.onerror = () => { thumb.style.display = 'none'; };
        meta.appendChild(thumb);
      } else {
        const ph = document.createElement('div');
        ph.className = 'playlist-item-thumb-placeholder';
        ph.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
        meta.appendChild(ph);
      }

      const name = document.createElement('span');
      name.className = 'playlist-item-name';
      name.textContent = p.name || 'Playlist';
      meta.appendChild(name);

      const toggle = document.createElement('div');
      toggle.className = 'vis-toggle';
      if (isVisible) {
        toggle.innerHTML = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#FFF" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
      }

      row.appendChild(handle);
      row.appendChild(meta);
      row.appendChild(toggle);

      // Drag and drop handlers for reordering playlists
      row.addEventListener('dragstart', (e) => {
        draggedPlaylistIndex = index;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(index));
        setTimeout(() => row.classList.add('dragging'), 0);
      });

      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (draggedPlaylistIndex === null || draggedPlaylistIndex === index) return;
        if (draggedPlaylistIndex < index) {
          row.classList.add('drag-over-bottom');
          row.classList.remove('drag-over-top');
        } else {
          row.classList.add('drag-over-top');
          row.classList.remove('drag-over-bottom');
        }
      });

      row.addEventListener('dragleave', () => {
        row.classList.remove('drag-over-top', 'drag-over-bottom');
      });

      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over-top', 'drag-over-bottom');
        if (draggedPlaylistIndex === null || draggedPlaylistIndex === index) return;

        const [movedItem] = playlists.splice(draggedPlaylistIndex, 1);
        playlists.splice(index, 0, movedItem);
        savePlaylistOrder();
        renderPlaylistChecklist();
        renderPlaylists();
      });

      row.addEventListener('dragend', () => {
        draggedPlaylistIndex = null;
        row.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
        hasDraggedRecently = true;
        setTimeout(() => { hasDraggedRecently = false; }, 80);
      });

      row.addEventListener('click', () => {
        if (hasDraggedRecently) return;
        if (hiddenPlaylistIds.has(p.id)) {
          hiddenPlaylistIds.delete(p.id);
        } else {
          hiddenPlaylistIds.add(p.id);
        }
        saveHiddenPlaylists();
        renderPlaylistChecklist();
        renderPlaylists();
      });

      playlistChecklist.appendChild(row);
    });
  }

  playlistShowAll?.addEventListener('click', () => {
    hiddenPlaylistIds.clear();
    saveHiddenPlaylists();
    renderPlaylistChecklist();
    renderPlaylists();
  });

  playlistHideAll?.addEventListener('click', () => {
    playlists.forEach((p) => hiddenPlaylistIds.add(p.id));
    saveHiddenPlaylists();
    renderPlaylistChecklist();
    renderPlaylists();
  });

  if (settingsBtn && settingsModal) {
    settingsBtn.addEventListener('click', () => {
      renderVisChecklist();
      renderPlaylistChecklist();
      refreshProfileUI();
      settingsModal.classList.add('open');
    });
    settingsClose.addEventListener('click', () => settingsModal.classList.remove('open'));
    settingsModal.addEventListener('click', (e) => {
      if (e.target === settingsModal) settingsModal.classList.remove('open');
    });
  }

  if (visSelectAll) {
    visSelectAll.addEventListener('click', () => {
      MODES.forEach((m) => enabledModeIds.add(m.id));
      saveEnabledModes();
      renderVisChecklist();
    });
  }

  if (profileLoginBtn) {
    profileLoginBtn.addEventListener('click', async () => {
      if (!bridge || !bridge.login) return;
      profileLoginBtn.disabled = true;
      const status = document.getElementById('spotifyStatus');
      status.textContent = 'Completa l’accesso nel browser…';
      try {
        const result = await bridge.login();
        await refreshProfileUI();
        if (result?.error) status.textContent = result.error;
        else if (!playlists.some((p) => !p.pinned)) await loadPlaylists();
        await pollSpotify();
      } catch (_) {
        status.textContent = 'Accesso non riuscito. Riprova.';
      } finally {
        profileLoginBtn.disabled = false;
      }
    });
  }

  if (profileLogoutBtn) {
    profileLogoutBtn.addEventListener('click', async () => {
      if (!bridge || !bridge.logout) return;
      await bridge.logout();
      await refreshProfileUI();
      await pollSpotify();
    });
  }

  // ====================================================================
  // PLAYLISTS MANAGEMENT
  // ====================================================================
  let playlists = [];
  let drawerPlaylist = null;

  function isSameTrack(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const idA = String(a).split('?')[0].split('#')[0].split(':').pop().trim();
    const idB = String(b).split('?')[0].split('#')[0].split(':').pop().trim();
    return !!(idA && idB && idA === idB);
  }

  function updatePlaylistActiveState() {
    if (!playlistGrid) return;
    playlistGrid.querySelectorAll('.tile').forEach((btn) => {
      const isAct = isSamePlaylist(player.activePlaylistId, btn.dataset.playlistId);
      btn.classList.toggle('active', isAct);
    });
    if (drawerPlaylist && drawerCover) {
      drawerCover.classList.toggle('active', isSamePlaylist(player.activePlaylistId, drawerPlaylist.id));
    }
  }

  function syncDrawerTrackSelection(shouldScroll = true) {
    if (!drawerList) return;
    const currentUri = player.trackUri;
    const currentTitle = (player.track || '').toLowerCase().trim();
    let targetRow = null;
    drawerList.querySelectorAll('.track-row').forEach((r) => {
      let isCur = isSameTrack(currentUri, r.dataset.uri);
      if (!isCur && (!currentUri || currentUri === '') && currentTitle) {
        const titleEl = r.querySelector('.tr-title');
        const rTitle = titleEl ? titleEl.textContent.toLowerCase().trim() : '';
        if (rTitle && rTitle === currentTitle) isCur = true;
      }
      r.classList.toggle('current', isCur);
      if (isCur) targetRow = r;
    });
    if (targetRow && shouldScroll && drawer && drawer.classList.contains('open')) {
      targetRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function renderPlaylists() {
    playlistGrid.innerHTML = '';
    const visiblePlaylists = playlists.filter((p) => !hiddenPlaylistIds.has(p.id));
    visiblePlaylists.forEach((p) => {
      const isActive = isSamePlaylist(player.activePlaylistId, p.id);
      const btn = document.createElement('button');
      btn.className = 'tile' + (isActive ? ' active' : '');
      btn.dataset.playlistId = p.id;
      btn.title = p.name || 'Playlist';

      const img = document.createElement('img');
      img.src = p.image || '';
      img.alt = p.name || 'Playlist';
      img.loading = 'lazy';

      const pin = document.createElement('span');
      pin.className = 'pin';

      btn.appendChild(img);
      btn.appendChild(pin);

      btn.draggable = true;

      // Drag and drop for grid tiles
      btn.addEventListener('dragstart', (e) => {
        draggedTileId = p.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', p.id);
        setTimeout(() => btn.classList.add('tile-dragging'), 0);
      });

      btn.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!draggedTileId || isSamePlaylist(draggedTileId, p.id)) return;
        btn.classList.add('tile-drag-over');
      });

      btn.addEventListener('dragleave', () => {
        btn.classList.remove('tile-drag-over');
      });

      btn.addEventListener('drop', (e) => {
        e.preventDefault();
        btn.classList.remove('tile-drag-over');
        if (!draggedTileId || isSamePlaylist(draggedTileId, p.id)) return;

        const fromIndex = playlists.findIndex((item) => isSamePlaylist(item.id, draggedTileId));
        const toIndex = playlists.findIndex((item) => isSamePlaylist(item.id, p.id));
        if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
          const [movedItem] = playlists.splice(fromIndex, 1);
          playlists.splice(toIndex, 0, movedItem);
          savePlaylistOrder();
          renderPlaylists();
          renderPlaylistChecklist();
        }
      });

      btn.addEventListener('dragend', () => {
        draggedTileId = null;
        btn.classList.remove('tile-dragging', 'tile-drag-over');
        hasDraggedRecently = true;
        setTimeout(() => { hasDraggedRecently = false; }, 80);
      });

      // Left-click: Play playlist immediately in background
      btn.addEventListener('click', async () => {
        if (hasDraggedRecently) return;
        player.activePlaylistId = p.id;
        updatePlaylistActiveState();
        reportControl(await window.spotteck.playUri(p.id));
        setTimeout(pollSpotify, 280);
      });

      // Right-click: Open playlist tracklist drawer to pick a specific song
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openPlaylistDrawer(p);
      });

      playlistGrid.appendChild(btn);
    });

    // "+" tile to add a Spotify playlist URL
    const addTile = document.createElement('button');
    addTile.className = 'tile-add';
    addTile.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>';
    addTile.addEventListener('click', () => {
      addError.textContent = '';
      addInput.value = '';
      addModal.classList.add('open');
      setTimeout(() => addInput.focus(), 50);
    });
    playlistGrid.appendChild(addTile);
  }

  async function openPlaylistDrawer(p) {
    drawerPlaylist = p;
    drawerCover.hidden = true;
    drawerCover.onload = () => { drawerCover.hidden = false; };
    drawerCover.onerror = () => { drawerCover.hidden = true; };
    if (p.image) drawerCover.src = p.image;
    else drawerCover.removeAttribute('src');
    drawerCover.classList.toggle('active', isSamePlaylist(player.activePlaylistId, p.id));
    drawerTitle.textContent = p.name || 'Playlist';
    drawerRemove.hidden = !p.pinned;
    drawerList.innerHTML = '<div class="drawer-msg">Caricamento brani in corso…</div>';
    drawer.classList.add('open');

    const res = await window.spotteck.getPlaylistTracks(p.id);
    if (drawerPlaylist !== p) return;

    if (!res || !res.success || !Array.isArray(res.tracks) || res.tracks.length === 0) {
      drawerList.innerHTML = `<div class="drawer-msg">${(res && res.error) || 'Nessun brano trovato.'}</div>`;
      return;
    }

    drawerTitle.textContent = `${p.name || 'Playlist'} · ${res.tracks.length}`;
    drawerList.innerHTML = '';
    res.tracks.forEach((t) => {
      const row = document.createElement('button');
      row.className = 'track-row' + (isSameTrack(player.trackUri, t.uri) ? ' current' : '');
      row.dataset.uri = t.uri;
      row.disabled = t.playable === false;

      const titleEl = document.createElement('div');
      titleEl.className = 'tr-title';
      titleEl.textContent = t.title;

      const artistEl = document.createElement('div');
      artistEl.className = 'tr-artist';
      artistEl.textContent = t.artist;

      const timeEl = document.createElement('div');
      timeEl.className = 'tr-time';
      timeEl.textContent = fmtDuration(t.duration);

      row.appendChild(titleEl);
      row.appendChild(artistEl);
      row.appendChild(timeEl);

      row.addEventListener('click', async () => {
        player.activePlaylistId = p.id;
        player.trackUri = t.uri;
        updatePlaylistActiveState();
        syncDrawerTrackSelection(false);
        reportControl(await window.spotteck.playTrackInContext(t.uri, p.id));
        setTimeout(pollSpotify, 280);
      });

      drawerList.appendChild(row);
    });

    syncDrawerTrackSelection(true);
    setTimeout(() => syncDrawerTrackSelection(true), 120);
  }

  drawerClose.addEventListener('click', () => {
    drawer.classList.remove('open');
    drawerPlaylist = null;
  });

  drawerPlayAll.addEventListener('click', async () => {
    if (!drawerPlaylist) return;
    player.activePlaylistId = drawerPlaylist.id;
    updatePlaylistActiveState();
    reportControl(await window.spotteck.playUri(drawerPlaylist.id));
    drawer.classList.remove('open');
    setTimeout(pollSpotify, 280);
  });

  drawerRemove.addEventListener('click', async () => {
    if (!drawerPlaylist) return;
    try { playlists = applyCustomPlaylistOrder(await window.spotteck.removePlaylist(drawerPlaylist.id)); }
    catch (_) { drawerTitle.textContent = 'Rimozione non salvata: riprova.'; return; }
    if (player.activePlaylistId === drawerPlaylist.id) player.activePlaylistId = null;
    drawer.classList.remove('open');
    drawerPlaylist = null;
    renderPlaylists();
    renderPlaylistChecklist();
  });

  // Add Playlist Modal
  addCancel.addEventListener('click', () => addModal.classList.remove('open'));
  addModal.addEventListener('click', (e) => {
    if (e.target === addModal) addModal.classList.remove('open');
  });

  async function submitNewPlaylist() {
    const url = addInput.value.trim();
    if (!url) return;
    addConfirm.disabled = true;
    addError.textContent = 'Verifica playlist…';
    let res;
    try { res = await window.spotteck.addPlaylistByUrl(url); }
    catch (_) { res = { error: 'Impossibile aggiungere la playlist.' }; }
    finally { addConfirm.disabled = false; }
    if (!res || !res.success) {
      addError.textContent = (res && res.error) || 'Link non valido';
      return;
    }
    playlists = applyCustomPlaylistOrder(res.all);
    renderPlaylists();
    renderPlaylistChecklist();
    addModal.classList.remove('open');
  }

  addConfirm.addEventListener('click', submitNewPlaylist);
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitNewPlaylist();
    if (e.key === 'Escape') addModal.classList.remove('open');
  });

  // Transport Controls
  playBtn.addEventListener('click', async () => {
    reportControl(await window.spotteck.playPause());
    setTimeout(pollSpotify, 180);
  });
  prevBtn.addEventListener('click', async () => {
    reportControl(await window.spotteck.prev());
    setTimeout(pollSpotify, 220);
  });
  nextBtn.addEventListener('click', async () => {
    reportControl(await window.spotteck.next());
    setTimeout(pollSpotify, 220);
  });
  shuffleBtn.addEventListener('click', async () => {
    const nextState = !player.shuffling;
    player.shuffling = nextState;
    updateTransportUI();
    reportControl(await bridge.setShuffle(nextState));
    setTimeout(pollSpotify, 220);
  });

  if (progressBar) {
    progressBar.addEventListener('click', async (e) => {
      if (!player.duration || player.duration <= 0) return;
      const rect = progressBar.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const targetSec = ratio * player.duration;
      player.position = targetSec;
      player.lastPollAt = performance.now();
      if (progressFill) progressFill.style.width = `${(ratio * 100).toFixed(2)}%`;
      if (bridge.seek) await bridge.seek(targetSec);
      setTimeout(pollSpotify, 220);
    });
  }

  function updateTransportUI() {
    if (player.isPlaying) {
      playBtn.classList.add('latched');
      playIcon.innerHTML = '<path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z"/>';
    } else {
      playBtn.classList.remove('latched');
      playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
    }

    shuffleBtn.classList.toggle('latched', !!player.shuffling);
    shuffleDot.classList.toggle('on', !!player.shuffling);

    trackNameEl.textContent = player.track || 'Spotteck';
    artistNameEl.textContent = player.artist || (player.isRunning ? 'In pausa' : 'Pronto');

    if (player.artwork && player.artwork !== currentArtworkUrl) {
      currentArtworkUrl = player.artwork;
      bgArtwork.classList.remove('ready');
      bgArtwork.onload = () => { bgArtwork.hidden = false; bgArtwork.classList.add('ready'); };
      bgArtwork.onerror = () => { bgArtwork.hidden = true; };
      bgArtwork.src = player.artwork;
      coverImage.src = player.artwork;
    }
  }

  // ====================================================================
  // STANDALONE INTERNAL AUDIO ENGINE & WEBAUDIO ANALYSER
  // ====================================================================

  // Volume ALWAYS defaults to 100% (maximum) on startup as requested
  player.volume = 100;
  try { localStorage.setItem('spotteck_volume', '100'); } catch (_e) {}
  let pendingVolume = null;
  let volumeSending = false;
  let volumeTimer;
  let volumeSyncAfter = 0;
  async function sendVolume() {
    clearTimeout(volumeTimer);
    if (volumeSending || pendingVolume === null) return;
    const value = pendingVolume;
    pendingVolume = null;
    volumeSending = true;
    try {
      const result = await bridge.setVolume(value);
      if (result?.error) throw new Error(result.error);
    } catch (error) {
      document.getElementById('spotifyStatus').textContent = error.message;
      settingsModal.classList.add('open');
    } finally {
      volumeSending = false;
      volumeSyncAfter = Date.now() + 1500;
      if (pendingVolume !== null) sendVolume();
    }
  }
  if (volumeSlider) {
    volumeSlider.value = '100';
    volumeSlider.addEventListener('input', () => {
      const v = Math.min(100, Math.max(0, Number(volumeSlider.value) || 0));
      player.volume = v;
      if (bridge?.setVolume) {
        pendingVolume = v;
        clearTimeout(volumeTimer);
        volumeTimer = setTimeout(sendVolume, 120);
      }
      try { localStorage.setItem('spotteck_volume', String(v)); } catch (_e) {}
    });
    volumeSlider.addEventListener('change', sendVolume);
  }

  let freqData = new Uint8Array(256);
  let timeData = new Uint8Array(512);
  bridge?.onAudioStatus?.((status) => {
    document.getElementById('audioAnalysisStatus').textContent = status;
  });
  let nativeAudio = null;
  let nativeAudioAt = -Infinity;
  bridge?.onAudioFrame?.((frame) => {
    nativeAudio = frame;
    nativeAudioAt = performance.now();
  });

  function applyPlayerState(st) {
    const status = document.getElementById('spotifyStatus');
    if (st?.playbackError && status.textContent !== st.playbackError) {
      status.textContent = st.playbackError;
      settingsModal.classList.add('open');
    }
    if (st && st.isRunning) {
      player.isRunning = true;
      player.isPlaying = !!st.isPlaying;
      player.track = st.track || 'Spotify';
      player.artist = st.artist || '';
      player.album = st.album || '';
      if (typeof st.duration === 'number' && st.duration > 0) {
        player.duration = st.duration;
      }
      if (typeof st.position === 'number') {
        player.position = st.position;
        player.lastPollAt = performance.now();
      }
      player.shuffling = !!st.shuffling;
      player.artwork = st.artwork || '';
      if (Number.isFinite(st.volume) && pendingVolume === null && !volumeSending &&
          !volumeSlider?.matches(':active') && Date.now() >= volumeSyncAfter) {
        player.volume = st.volume;
        if (volumeSlider) volumeSlider.value = String(st.volume);
      }
      const prevUri = player.trackUri;
      player.trackUri = st.trackUri || '';
      if (st.contextUri && !isSamePlaylist(player.activePlaylistId, st.contextUri)) {
        player.activePlaylistId = st.contextUri;
        updatePlaylistActiveState();
      }
      if (player.trackUri !== prevUri) {
        syncDrawerTrackSelection(true);
      }
    } else {
      player.isRunning = false;
      player.isPlaying = false;
      if (st && typeof st.shuffling === 'boolean') player.shuffling = st.shuffling;
      if (st && st.artist) player.artist = st.artist;
    }
    updateTransportUI();
    syncDrawerTrackSelection(false);
    updatePlaylistActiveState();
  }
  updateTransportUI();

  async function pollSpotify() {
    try {
      const st = await window.spotteck.getState();
      applyPlayerState(st);
    } catch (_e) {}
  }

  if (bridge) {
    if (bridge.onState) {
      bridge.onState((st) => applyPlayerState(st));
    }
  }

  // Library playlists, then the ones pinned with "+". Reloaded when the account changes.
  async function loadPlaylists() {
    try {
      const loaded = await bridge.getPlaylists();
      if (Array.isArray(loaded)) {
        playlists = applyCustomPlaylistOrder(loaded);
        renderPlaylists();
        renderPlaylistChecklist();
      }
    } catch (e) {
      addError.textContent = e.message || 'Archivio playlist non disponibile.';
      addModal.classList.add('open');
    }
  }
  bridge?.onPlaylistsChanged?.(() => loadPlaylists());

  // Initial Load — render "+" button immediately, then populate playlists
  renderPlaylists();
  (async () => {
    await loadPlaylists();
    await pollSpotify();
  })();

  // ====================================================================
  // 60 FPS REAL-TIME INSTRUMENT TELEMETRY & RENDER LOOP
  // ====================================================================

  const TRACE_POINTS = 140;
  const flatTrace = new Float32Array(TRACE_POINTS);
  const scopeHistory = [flatTrace, flatTrace, flatTrace];

  let vuPosL = 0.03;
  let vuPosR = 0.03;
  let vuVelL = 0;
  let vuVelR = 0;
  let vuPeakL = 0;
  let vuPeakR = 0;
  let vuLamp = 0.65;

  let angleL = 0;
  let angleR = 0;
  let vinylSpin = 0;

  let smoothBass = 0;
  let smoothMid = 0;
  let smoothHigh = 0;
  let smoothEnergy = 0;

  // Dynamic beat-tracking & transient flux envelopes for VU Meters and Blobs
  let avgBassPower = 0;
  let avgMidPower = 0;
  let beatPulseBass = 0;
  let beatPulseMid = 0;
  let blobBass = 0;
  let blobMid = 0;
  let blobHigh = 0;
  let blobEnergy = 0;
  const bands16 = new Float32Array(16);

  let lastFrame = performance.now();

  function extractAudioTelemetry(nowSec, curPos) {
    if (!player.isPlaying) {
      smoothBass *= 0.86;
      smoothMid *= 0.86;
      smoothHigh *= 0.86;
      smoothEnergy *= 0.86;
      avgBassPower *= 0.85;
      avgMidPower *= 0.85;
      beatPulseBass *= 0.80;
      beatPulseMid *= 0.80;
      blobBass *= 0.84;
      blobMid *= 0.84;
      blobHigh *= 0.84;
      blobEnergy *= 0.84;
      for (let i = 0; i < 16; i++) bands16[i] *= 0.84;
      return {
        wave: flatTrace,
        vuTargetL: 0.025,
        vuTargetR: 0.025,
        peakHitL: false,
        peakHitR: false
      };
    }

    const wave = new Float32Array(TRACE_POINTS);

    if (performance.now() - nativeAudioAt < 250) {
      freqData.set(nativeAudio.frequency);
      timeData.set(nativeAudio.time);
    } else {
      freqData.fill(0);
      timeData.fill(128);
    }

    if (freqData) {
      let bassSum = 0;
      let bassPowSum = 0;
      for (let i = 1; i <= 10; i++) {
        const v = freqData[i];
        bassSum += v;
        const norm = v / 255;
        bassPowSum += norm * norm * norm;
      }
      const targetB = Math.min(1, (bassSum / (10 * 255)) * 1.15);
      const rawBassPow = bassPowSum / 10;

      let midSum = 0;
      let midPowSum = 0;
      for (let i = 11; i <= 54; i++) {
        const v = freqData[i];
        midSum += v;
        const norm = v / 255;
        midPowSum += norm * norm * norm;
      }
      const targetM = Math.min(1, (midSum / (44 * 255)) * 1.25);
      const rawMidPow = midPowSum / 44;

      let highSum = 0;
      let highPowSum = 0;
      for (let i = 55; i <= 140; i++) {
        const v = freqData[i];
        highSum += v;
        const norm = v / 255;
        highPowSum += norm * norm * norm;
      }
      const targetH = Math.min(1, (highSum / (86 * 255)) * 1.35);
      const rawHighPow = highPowSum / 86;

      // Silky-smooth envelope integration for the Oscilloscope waveform (unchanged feel!)
      smoothBass += (targetB - smoothBass) * 0.11;
      smoothMid += (targetM - smoothMid) * 0.11;
      smoothHigh += (targetH - smoothHigh) * 0.11;
      smoothEnergy = Math.min(1, smoothBass * 0.45 + smoothMid * 0.35 + smoothHigh * 0.20);

      // Real-time transient / onset flux detector (extracts kick drum & snare beats from mastered audio)
      avgBassPower += (rawBassPow - avgBassPower) * 0.055;
      avgMidPower += (rawMidPow - avgMidPower) * 0.065;
      const bassFlux = Math.max(0, rawBassPow - avgBassPower * 0.88);
      const midFlux = Math.max(0, rawMidPow - avgMidPower * 0.86);

      const targetBeatB = Math.min(1.35, bassFlux * 4.2 + Math.pow(rawBassPow, 1.35) * 0.85);
      const targetBeatM = Math.min(1.30, midFlux * 4.6 + Math.pow(rawMidPow, 1.35) * 0.85);
      beatPulseBass += (targetBeatB - beatPulseBass) * (targetBeatB > beatPulseBass ? 0.42 : 0.16);
      beatPulseMid += (targetBeatM - beatPulseMid) * (targetBeatM > beatPulseMid ? 0.42 : 0.16);

      // Beat-responsive envelopes for Blobs (smooth organic motion + clear rhythmic beat pulse)
      const targetBlobB = Math.min(1.25, smoothBass * 0.48 + beatPulseBass * 0.68);
      const targetBlobM = Math.min(1.20, smoothMid * 0.48 + beatPulseMid * 0.65);
      const targetBlobH = Math.min(1.15, smoothHigh * 0.55 + Math.pow(rawHighPow, 0.8) * 0.65);
      blobBass += (targetBlobB - blobBass) * (targetBlobB > blobBass ? 0.30 : 0.14);
      blobMid += (targetBlobM - blobMid) * (targetBlobM > blobMid ? 0.28 : 0.14);
      blobHigh += (targetBlobH - blobHigh) * 0.22;
      blobEnergy = Math.min(1.2, blobBass * 0.48 + blobMid * 0.34 + blobHigh * 0.18);

      for (let b = 0; b < 16; b++) {
        const binStart = Math.floor(Math.pow(b / 16, 1.6) * 140) + 1;
        const binEnd = Math.max(binStart + 1, Math.floor(Math.pow((b + 1) / 16, 1.6) * 140) + 1);
        let sum = 0;
        for (let k = binStart; k < binEnd && k < freqData.length; k++) sum += freqData[k];
        const val = Math.min(1, (sum / ((binEnd - binStart) * 255)) * 1.25);
        bands16[b] += (val - bands16[b]) * 0.18;
      }

      // Smooth measured samples spatially and across frames, keeping the real waveform.
      const previousWave = scopeHistory[scopeHistory.length - 1] || flatTrace;
      for (let i = 0; i < TRACE_POINTS; i++) {
        const sample = Math.floor(i * (timeData.length - 1) / (TRACE_POINTS - 1));
        const left = timeData[Math.max(0, sample - 1)];
        const right = timeData[Math.min(timeData.length - 1, sample + 1)];
        const measured = ((left + timeData[sample] * 2 + right) / 4 - 128) / 128;
        wave[i] = previousWave[i] * 0.65 + measured * 0.35;
      }

      // True Time-Domain RMS + Beat Flux for lively, musical Dual VU Meters
      let tdSumL = 0;
      let tdSumR = 0;
      let tdPeakL = 0;
      let tdPeakR = 0;
      if (performance.now() - nativeAudioAt < 250 && nativeAudio?.levels) {
        [tdSumL, tdSumR] = nativeAudio.levels.rms;
        [tdPeakL, tdPeakR] = nativeAudio.levels.peak;
      }

      const dynL = Math.pow(tdSumL * 1.65, 1.35) * 0.42 + beatPulseBass * 0.48 + beatPulseMid * 0.18 + tdPeakL * 0.16;
      const dynR = Math.pow(tdSumR * 1.65, 1.35) * 0.42 + beatPulseMid * 0.46 + beatPulseBass * 0.22 + tdPeakR * 0.16;

      const vuTargetL = Math.min(0.98, Math.max(0.06, 0.10 + dynL * 0.78));
      const vuTargetR = Math.min(0.98, Math.max(0.06, 0.10 + dynR * 0.78));
      const peakHitL = vuTargetL > 0.80 || tdPeakL > 0.72 || bassFlux > 0.11;
      const peakHitR = vuTargetR > 0.80 || tdPeakR > 0.72 || midFlux > 0.10;

      return { wave, vuTargetL, vuTargetR, peakHitL, peakHitR };
    }

    return { wave: flatTrace, vuTargetL: 0.025, vuTargetR: 0.025, peakHitL: false, peakHitR: false };
  }

  function renderFrame(now) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    const nowSec = now / 1000;

    // Smoothly interpolate playback position
    const elapsed = player.isPlaying ? (now - player.lastPollAt) / 1000 : 0;
    const curPos = Math.min(player.duration || 1, player.position + elapsed);
    const progress = player.duration > 0 ? Math.min(1, Math.max(0, curPos / player.duration)) : 0;

    if (progressFill) {
      progressFill.style.width = `${(progress * 100).toFixed(2)}%`;
    }

    const { wave, vuTargetL, vuTargetR, peakHitL, peakHitR } = extractAudioTelemetry(nowSec, curPos);

    // Update Scope Trace History
    if (player.isPlaying) {
      scopeHistory.shift();
      scopeHistory.push(wave);
    } else {
      // Smoothly damp scope trace to pure flat line when stopped/paused
      const prev = scopeHistory[scopeHistory.length - 1];
      const damped = new Float32Array(TRACE_POINTS);
      for (let i = 0; i < TRACE_POINTS; i++) damped[i] = prev[i] * 0.72;
      scopeHistory.shift();
      scopeHistory.push(damped);
    }

    // Update VU Needle Ballistics with lively analog spring momentum + peak LED
    const targetPosL = player.isPlaying ? vuTargetL : 0.025;
    const targetPosR = player.isPlaying ? vuTargetR : 0.025;

    const accelL = (targetPosL - vuPosL) * (targetPosL > vuPosL ? 0.42 : 0.18);
    const accelR = (targetPosR - vuPosR) * (targetPosR > vuPosR ? 0.42 : 0.18);
    vuVelL = vuVelL * 0.58 + accelL;
    vuVelR = vuVelR * 0.58 + accelR;
    vuPosL = Math.min(1.01, Math.max(0.02, vuPosL + vuVelL));
    vuPosR = Math.min(1.01, Math.max(0.02, vuPosR + vuVelR));

    if (peakHitL && player.isPlaying) vuPeakL = 1;
    else vuPeakL = Math.max(0, vuPeakL - dt * 3.4);

    if (peakHitR && player.isPlaying) vuPeakR = 1;
    else vuPeakR = Math.max(0, vuPeakR - dt * 3.4);

    const targetLamp = player.isPlaying ? 0.94 + 0.06 * beatPulseBass : 0.52;
    vuLamp += (targetLamp - vuLamp) * 0.16;

    // Update Cassette & Vinyl rotation angles (only advance when playing!)
    if (player.isPlaying) {
      const speedL = 1.9 / (0.55 + (1 - progress) * 0.65);
      const speedR = 1.9 / (0.55 + progress * 0.65);
      angleL -= dt * speedL;
      angleR -= dt * speedR;
      vinylSpin += dt * 3.49; // 33 1/3 RPM = 3.49 rad/s
    }

    const sharedState = {
      isPlaying: player.isPlaying,
      progress,
      trackKey: player.trackUri || player.track || '',
      trackTitle: player.track || '',
      trackArtist: player.artist || '',
      angleL,
      angleR,
      spinAngle: vinylSpin,
      cover: coverImage,
      time: nowSec,
      energy: blobEnergy,
      bass: blobBass,
      mid: blobMid,
      high: blobHigh,
      bands: bands16,
      wave
    };

    // Draw only the active instrument for 60/120 FPS efficiency
    const activeId = MODES[modeIndex].id;
    if (activeId === 'scope') {
      drawScope(scopeCanvas, scopeHistory);
    } else if (activeId === 'cassette') {
      drawCassette(cassetteCanvas, sharedState);
    } else if (activeId === 'vu') {
      drawVU(vuL, vuPosL, vuPeakL, vuLamp);
      drawVU(vuR, vuPosR, vuPeakR, vuLamp);
    } else if (activeId === 'vinyl') {
      drawVinyl(vinylCanvas, sharedState);
    } else if (activeId === 'aetherBlob') {
      drawAetherMorph(aetherBlobCanvas, sharedState, 'circleSmall', null, blobPresetIndices.aetherBlob, null);
    } else if (activeId === 'aetherMacro') {
      drawAetherMorph(aetherMacroCanvas, sharedState, 'circleMacro', null, blobPresetIndices.aetherMacro, null);
    } else if (activeId === 'aetherAura') {
      drawAetherMorph(aetherAuraCanvas, sharedState, 'fullAura', aetherAuraGlow, blobPresetIndices.aetherAura, aetherCustomParams);
    }

    requestAnimationFrame(renderFrame);
  }

  requestAnimationFrame(renderFrame);
})();
