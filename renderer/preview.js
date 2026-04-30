(function () {
  const { RENDERER_REGISTRY } = window.PackRenderers;

  const BASE_STATES = ['idle', 'thinking', 'working', 'waiting', 'done', 'error'];
  const OVERLAY_STATES = ['dragging', 'falling', 'landed'];
  const STATE_LABELS = {
    idle: '待機中',
    thinking: '考え中…',
    working: '作業中',
    waiting: '確認待ち',
    done: '完了！',
    error: 'エラー',
  };

  // Match runtime constants from main.js: done -> idle auto-reset (~2.5s) and
  // landed overlay duration (~280ms). Documented in the spec as approximate;
  // these are the actual values used by the runtime.
  const DONE_AUTO_RESET_MS = 2500;
  const LANDED_DURATION_MS = 280;
  const AUTOPLAY_PER_STATE_MS = 2000;

  const $ = (id) => document.getElementById(id);
  const packListEl = $('pack-list');
  const stageWindow = $('stage-window');
  const mascotWrap = $('mascot-wrap');
  const bubble = $('bubble');
  const bubbleText = $('bubble-text');
  const sessionLabel = $('session-label');
  const guidesEl = $('guides');
  const insManifest = $('ins-manifest');
  const insStates = $('ins-states');
  const insFiles = $('ins-files');
  const insErrors = $('ins-errors');
  const validatePill = $('validate-pill');
  const btnReload = $('btn-reload');
  const btnOpenDir = $('btn-open-dir');
  const btnAutoplay = $('btn-autoplay');
  const btnOverlaySeq = $('btn-overlay-seq');
  const rowBase = $('row-base');
  const rowOverlay = $('row-overlay');
  const statusEl = $('status');
  const toastEl = $('toast');

  let packs = [];
  let selectedPackId = null;
  let activeRenderer = null;
  let activeManifest = null;
  let unsubscribeWatcher = null;
  let realState = 'idle';
  let overlayState = null;
  // Snapshot kept so a failed reload doesn't blank the preview.
  let lastGoodPackData = null;

  // Auto-play / overlay sequence timers.
  let autoplayTimer = null;
  let autoplayIndex = 0;
  let overlaySeqTimer = null;
  // Mirrors the runtime done -> idle reset so 'done' clears itself in preview too.
  let doneResetTimer = null;
  // Mirrors LANDED_DURATION_MS in main.js.
  let landedClearTimer = null;

  // ---- Helpers --------------------------------------------------------------

  function showToast(msg, ms) {
    toastEl.textContent = msg;
    toastEl.removeAttribute('hidden');
    if (showToast._t) clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.setAttribute('hidden', ''), ms || 2200);
  }

  function setStatus(msg) {
    statusEl.textContent = msg || '';
  }

  function setBubbleAnchor(anchor) {
    const allowed = ['top-right', 'top-left', 'top'];
    bubble.dataset.anchor = allowed.includes(anchor) ? anchor : 'top-right';
  }

  function updateBubble(state, message) {
    const label = message && message.trim() ? message : (STATE_LABELS[state] || state);
    bubbleText.textContent = label;
    bubble.classList.toggle('is-idle', state === 'idle');
    bubble.classList.remove('is-hidden');
  }

  function applyEffectiveState() {
    const effective = overlayState ?? realState;
    if (activeRenderer) activeRenderer.setState(effective);
    updateBubble(realState, '');
    syncStateButtons();
  }

  function syncStateButtons() {
    rowBase.querySelectorAll('.seg').forEach((b) => {
      b.classList.toggle('active', !overlayState && b.dataset.state === realState);
    });
    rowOverlay.querySelectorAll('.seg').forEach((b) => {
      b.classList.toggle('active', overlayState === b.dataset.state);
    });
  }

  function setBaseState(state) {
    if (!BASE_STATES.includes(state)) return;
    realState = state;
    if (doneResetTimer) { clearTimeout(doneResetTimer); doneResetTimer = null; }
    if (state === 'done') {
      doneResetTimer = setTimeout(() => {
        doneResetTimer = null;
        if (realState === 'done') setBaseState('idle');
      }, DONE_AUTO_RESET_MS);
    }
    applyEffectiveState();
  }

  function setOverlayState(next) {
    if (next != null && !OVERLAY_STATES.includes(next)) return;
    overlayState = next || null;
    if (landedClearTimer) { clearTimeout(landedClearTimer); landedClearTimer = null; }
    if (overlayState === 'landed') {
      landedClearTimer = setTimeout(() => {
        landedClearTimer = null;
        if (overlayState === 'landed') {
          overlayState = null;
          applyEffectiveState();
        }
      }, LANDED_DURATION_MS);
    }
    applyEffectiveState();
  }

  function stopAutoplay() {
    if (autoplayTimer) { clearTimeout(autoplayTimer); autoplayTimer = null; }
    btnAutoplay.classList.remove('primary');
    btnAutoplay.textContent = 'Auto-play base';
  }

  function startAutoplay() {
    stopAutoplay();
    btnAutoplay.classList.add('primary');
    btnAutoplay.textContent = 'Stop autoplay';
    autoplayIndex = 0;
    const tick = () => {
      const s = BASE_STATES[autoplayIndex % BASE_STATES.length];
      autoplayIndex += 1;
      setOverlayState(null);
      setBaseState(s);
      autoplayTimer = setTimeout(tick, AUTOPLAY_PER_STATE_MS);
    };
    tick();
  }

  function stopOverlaySequence() {
    if (overlaySeqTimer) { clearTimeout(overlaySeqTimer); overlaySeqTimer = null; }
    btnOverlaySeq.classList.remove('primary');
    btnOverlaySeq.textContent = 'Overlay seq';
  }

  function startOverlaySequence() {
    stopOverlaySequence();
    btnOverlaySeq.classList.add('primary');
    btnOverlaySeq.textContent = 'Stop seq';
    // Drag for 1.2s, fall for 0.6s, land for LANDED_DURATION_MS, pause, repeat.
    setOverlayState('dragging');
    overlaySeqTimer = setTimeout(() => {
      setOverlayState('falling');
      overlaySeqTimer = setTimeout(() => {
        setOverlayState('landed');
        // setOverlayState('landed') schedules the LANDED_DURATION_MS clear
        // itself; chain a small pause then loop.
        overlaySeqTimer = setTimeout(() => {
          setOverlayState(null);
          overlaySeqTimer = setTimeout(startOverlaySequence, 600);
        }, LANDED_DURATION_MS + 200);
      }, 600);
    }, 1200);
  }

  // ---- Pack loading ---------------------------------------------------------

  async function refreshPacks() {
    try {
      packs = await window.api.preview.listPacks();
    } catch (err) {
      console.error('listPacks failed', err);
      packs = [];
    }
    renderPackList();
    if (selectedPackId && !packs.find((p) => p.id === selectedPackId)) {
      selectedPackId = null;
    }
    if (!selectedPackId && packs.length) {
      selectPack(packs[0].id);
    } else if (selectedPackId) {
      // Re-mark UI selection.
      renderPackList();
    }
  }

  function renderPackList() {
    packListEl.innerHTML = '';
    for (const p of packs) {
      const li = document.createElement('li');
      if (p.id === selectedPackId) li.classList.add('selected');
      const name = document.createElement('div');
      name.className = 'pack-name';
      name.textContent = p.name || p.id;
      const id = document.createElement('div');
      id.className = 'pack-id';
      id.textContent = p.id;
      li.appendChild(name);
      li.appendChild(id);
      li.addEventListener('click', () => selectPack(p.id));
      packListEl.appendChild(li);
    }
    if (!packs.length) {
      const li = document.createElement('li');
      li.textContent = '(no packs found)';
      li.style.color = 'var(--muted)';
      li.style.cursor = 'default';
      packListEl.appendChild(li);
    }
  }

  async function selectPack(id) {
    if (!id) return;
    selectedPackId = id;
    btnOpenDir.disabled = false;
    renderPackList();

    if (unsubscribeWatcher) {
      try { unsubscribeWatcher(); } catch {}
      unsubscribeWatcher = null;
    }
    unsubscribeWatcher = window.api.preview.watchPack(id, () => {
      // Debounced + filtered by main.js. Reload once.
      reloadActivePack({ silent: false });
    });

    await loadPackIntoStage(id);
    runValidation();
  }

  async function loadPackIntoStage(id) {
    setStatus(`loading ${id}…`);
    let packData;
    try {
      packData = await window.api.preview.loadPack(id);
    } catch (err) {
      console.error('loadPack failed', err);
      setStatus('load failed');
      showToast(`Load failed: ${err.message || err}`);
      // Keep previous successful state visible (lastGoodPackData) — no swap.
      pushReloadError(err.message || String(err));
      return false;
    }
    const { manifest } = packData;
    if (!manifest || !manifest.id) {
      setStatus('manifest invalid');
      showToast('manifest.json is invalid');
      pushReloadError('manifest invalid');
      return false;
    }
    const rendererType = manifest.renderer || 'svg';
    const RendererClass = RENDERER_REGISTRY[rendererType];
    if (!RendererClass) {
      setStatus(`unknown renderer ${rendererType}`);
      showToast(`Unsupported renderer: ${rendererType}`);
      pushReloadError(`unsupported renderer '${rendererType}'`);
      return false;
    }

    if (activeRenderer) {
      try { activeRenderer.destroy(); } catch {}
      activeRenderer = null;
    }

    const inst = new RendererClass({
      cssOpts: { root: stageWindow, styleId: `pack-css-${manifest.id}` },
      onMissingLottie: () => { bubbleText.textContent = 'lottie 未読込'; },
    });
    try {
      await inst.mount(mascotWrap, packData);
    } catch (err) {
      console.error('renderer.mount failed', err);
      setStatus('mount failed');
      showToast(`Mount failed: ${err.message || err}`);
      pushReloadError(`mount failed: ${err.message || err}`);
      return false;
    }
    activeRenderer = inst;
    activeManifest = manifest;
    lastGoodPackData = packData;

    setBubbleAnchor((manifest.bubble && manifest.bubble.anchor) || 'top-right');
    renderInspector(manifest, packData);
    applyEffectiveState();
    drawGuides();
    setStatus(`${manifest.id} ready`);
    return true;
  }

  async function reloadActivePack(opts) {
    if (!selectedPackId) return;
    setStatus('reloading…');
    const ok = await loadPackIntoStage(selectedPackId);
    if (ok && !(opts && opts.silent)) {
      showToast('Reloaded');
    }
    runValidation();
  }

  function pushReloadError(msg) {
    // Surface in the Errors section in addition to the toast.
    const li = document.createElement('li');
    li.className = 'error';
    li.textContent = `[reload] ${msg}`;
    insErrors.prepend(li);
  }

  // ---- Inspector ------------------------------------------------------------

  function renderInspector(manifest, packData) {
    insManifest.textContent = JSON.stringify(manifest, null, 2);

    insStates.innerHTML = '';
    const fallback = manifest.fallbackState || 'idle';
    const all = [...BASE_STATES, ...OVERLAY_STATES];
    const declared = (manifest.states && typeof manifest.states === 'object') ? manifest.states : null;
    if (declared) {
      for (const s of all) {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = s;
        const meta = document.createElement('span');
        meta.className = 'meta';
        if (declared[s]) {
          meta.textContent = declared[s];
          li.classList.add('ok');
        } else if (declared[fallback]) {
          meta.textContent = `→ fallback (${fallback})`;
          li.classList.add('warn');
        } else {
          meta.textContent = '(missing)';
          li.classList.add('warn');
        }
        li.appendChild(name);
        li.appendChild(meta);
        insStates.appendChild(li);
      }
    } else {
      // SVG renderer: states live as CSS selectors inside pack.css; we can't
      // tell statically whether each is implemented. Just list as informational.
      for (const s of all) {
        const li = document.createElement('li');
        li.textContent = `${s} (svg pack — driven by pack.css)`;
        li.classList.add('ok');
        insStates.appendChild(li);
      }
    }
  }

  async function runValidation() {
    if (!selectedPackId) return;
    insErrors.innerHTML = '';
    insFiles.innerHTML = '';
    let result;
    try {
      result = await window.api.preview.validatePack(selectedPackId);
    } catch (err) {
      validatePill.dataset.status = 'error';
      validatePill.textContent = 'Error';
      const li = document.createElement('li');
      li.className = 'error';
      li.textContent = err.message || String(err);
      insErrors.appendChild(li);
      return;
    }
    if (result.errors.length) {
      validatePill.dataset.status = 'error';
      validatePill.textContent = `Error · ${result.errors.length}`;
    } else if (result.warnings.length) {
      validatePill.dataset.status = 'warn';
      validatePill.textContent = `OK · ${result.warnings.length} warn`;
    } else {
      validatePill.dataset.status = 'ok';
      validatePill.textContent = 'OK';
    }
    for (const e of result.errors) {
      const li = document.createElement('li');
      li.className = 'error';
      li.textContent = e;
      insErrors.appendChild(li);
    }
    for (const w of result.warnings) {
      const li = document.createElement('li');
      li.className = 'warn';
      li.textContent = w;
      insErrors.appendChild(li);
    }
    if (!result.errors.length && !result.warnings.length) {
      const li = document.createElement('li');
      li.className = 'ok';
      li.textContent = 'No issues found.';
      insErrors.appendChild(li);
    }
    for (const f of (result.files || [])) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = f.path;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = formatBytes(f.size);
      li.appendChild(name);
      li.appendChild(meta);
      insFiles.appendChild(li);
    }
  }

  function formatBytes(n) {
    if (typeof n !== 'number') return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  // ---- Guides ---------------------------------------------------------------

  // Mirrors styles.css: stage padding-bottom 8 + mascot-wrap 200x200 inside a
  // 280x240 stage. Floor sits 8px above the stage bottom (= y 232).
  function drawGuides() {
    guidesEl.innerHTML = '';
    if (!activeManifest) return;
    const flags = {
      bubble: $('guide-bubble').checked,
      label: $('guide-label').checked,
      frame: $('guide-frame').checked,
      floor: $('guide-floor').checked,
    };
    if (flags.floor) {
      const el = document.createElement('div');
      el.className = 'guide guide-floor';
      // 280x240 stage -> floor at 232 (240 - 8 padding).
      el.style.top = '232px';
      guidesEl.appendChild(el);
    }
    if (flags.frame) {
      // mascot-wrap is 200x200 centered horizontally with bottom padding 8.
      // origin is left:(280-200)/2=40, top:(240-8-200)=32
      const el = document.createElement('div');
      el.className = 'guide guide-frame';
      el.style.left = '40px';
      el.style.top = '32px';
      el.style.width = '200px';
      el.style.height = '200px';
      const w = activeManifest.size && activeManifest.size.width;
      const h = activeManifest.size && activeManifest.size.height;
      const vb = activeManifest.viewBox || '';
      el.dataset.label = `frame 200x200 · size ${w || '?'}x${h || '?'}${vb ? ' · vb ' + vb : ''}`;
      guidesEl.appendChild(el);
    }
    if (flags.bubble) {
      // Crosshair at the bubble's anchor point inside mascot-wrap. Stage
      // coordinates: mascot-wrap top-left is (40, 32) in a 280x240 window.
      const anchor = (activeManifest.bubble && activeManifest.bubble.anchor) || 'top-right';
      const anchorPos = bubbleAnchorPos(anchor);
      const el = document.createElement('div');
      el.className = 'guide guide-bubble-anchor';
      el.style.left = `${40 + anchorPos.x}px`;
      el.style.top = `${32 + anchorPos.y}px`;
      guidesEl.appendChild(el);
    }
    if (flags.label) {
      // session-label is bottom-center of mascot-wrap (200x200), 16px below.
      // mascot-wrap top-left = (40, 32). Bottom-center y = 32 + 200 = 232.
      const el = document.createElement('div');
      el.className = 'guide guide-label';
      const w = 100;
      const h = 16;
      el.style.left = `${40 + 100 - w / 2}px`;
      el.style.top = `${232 + 16 - h / 2}px`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      guidesEl.appendChild(el);
    }
  }

  // Mirror of styles.css anchor placements.
  function bubbleAnchorPos(anchor) {
    if (anchor === 'top-left')  return { x: 200 - 105, y: 0 };
    if (anchor === 'top')       return { x: 100, y: -8 };
    return { x: 105, y: 0 };
  }

  // ---- Wiring ---------------------------------------------------------------

  function buildStateButtons() {
    rowBase.innerHTML = '';
    for (const s of BASE_STATES) {
      const b = document.createElement('button');
      b.className = 'seg';
      b.dataset.state = s;
      b.textContent = s;
      b.addEventListener('click', () => {
        stopAutoplay();
        stopOverlaySequence();
        setOverlayState(null);
        setBaseState(s);
      });
      rowBase.appendChild(b);
    }
    rowOverlay.innerHTML = '';
    const off = document.createElement('button');
    off.className = 'seg';
    off.dataset.state = '';
    off.textContent = 'off';
    off.addEventListener('click', () => {
      stopOverlaySequence();
      setOverlayState(null);
    });
    rowOverlay.appendChild(off);
    for (const s of OVERLAY_STATES) {
      const b = document.createElement('button');
      b.className = 'seg';
      b.dataset.state = s;
      b.textContent = s;
      b.addEventListener('click', () => {
        stopOverlaySequence();
        setOverlayState(s);
      });
      rowOverlay.appendChild(b);
    }
  }

  function wireControls() {
    document.querySelectorAll('input[name="bg"]').forEach((r) => {
      r.addEventListener('change', () => {
        if (r.checked) stageWindow.dataset.bg = r.value;
      });
    });
    ['guide-bubble', 'guide-label', 'guide-frame', 'guide-floor'].forEach((id) => {
      $(id).addEventListener('change', drawGuides);
    });
    btnReload.addEventListener('click', async () => {
      await refreshPacks();
      if (selectedPackId) {
        await reloadActivePack({ silent: true });
      }
      showToast('Packs rescanned');
    });
    btnOpenDir.addEventListener('click', () => {
      if (selectedPackId) window.api.preview.revealInFinder(selectedPackId);
    });
    btnAutoplay.addEventListener('click', () => {
      if (autoplayTimer) stopAutoplay();
      else startAutoplay();
    });
    btnOverlaySeq.addEventListener('click', () => {
      if (overlaySeqTimer) stopOverlaySequence();
      else startOverlaySequence();
    });
  }

  // ---- Boot ----
  buildStateButtons();
  wireControls();
  refreshPacks().then(() => {
    setBaseState('idle');
  });
})();
