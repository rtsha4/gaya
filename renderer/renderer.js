(function () {
  const VALID_STATES = ['idle', 'thinking', 'working', 'waiting', 'done', 'error'];
  // Overlay-only states the renderer may apply but main.js never POSTs as a
  // realState. Driven entirely by the per-window 'overlay' IPC and replaces
  // realState while non-null:
  //   dragging — user is holding the window; replaces realState until release
  //   falling  — released above the floor; renderer plays a fall pose while
  //              the tick loop eases posY back to the floor
  //   landed   — squash pose immediately after touching the floor; cleared
  //              by main.js after LANDED_DURATION_MS
  const OVERLAY_STATES = ['dragging', 'falling', 'landed'];
  const VALID_OVERLAYS = new Set(OVERLAY_STATES);
  // Default-first preference list. If neither pack exists, loadPack falls back
  // to whatever the first manifest fetch happens to succeed for.
  const PREFERRED_PACKS = ['pop', 'classic'];
  const STATE_LABELS = {
    idle: '待機中',
    thinking: '考え中…',
    working: '作業中',
    waiting: '確認待ち',
    done: '完了！',
    error: 'エラー',
  };

  const mascotWrap = document.getElementById('mascot-wrap');
  const bubble = document.getElementById('bubble');
  const bubbleText = document.getElementById('bubble-text');
  // Per-session label: visible on every non-default session so the user can
  // tell stacked mascots apart. Set by the session-info IPC.
  const sessionLabel = document.getElementById('session-label');
  const SESSION_LABEL_MAX = 16;

  let currentPackId = null;
  // The active MascotRenderer instance (one of SvgRenderer / ImageRenderer /
  // LottieRenderer). Recreated on every pack swap.
  let activeRenderer = null;
  // realState is the state main.js POSTed (idle/thinking/working/...). When
  // an overlay is active (dragging / falling / landed), we render that on
  // top of realState — but realState keeps progressing in the background
  // (e.g. the done -> idle 2.5s timer keeps running) so the moment the
  // overlay clears we snap back to whatever realState has become.
  let realState = 'idle';
  let overlayState = null;
  let currentMessage = '';
  let doneResetTimer = null;

  // ------------------------------------------------------------------------
  // Pack CSS plumbing — shared by every renderer. Each pack ships an optional
  // pack.css and we mirror it into a single <style id="pack-css"> so a swap
  // is just a textContent assignment (no <link> reload, no fetch).
  // ------------------------------------------------------------------------
  function applyPackCss(cssText) {
    let styleEl = document.getElementById('pack-css');
    // If a stale <link id="pack-css"> exists from older builds, replace it
    // with a <style> so the id stays unique.
    if (styleEl && styleEl.tagName !== 'STYLE') {
      styleEl.parentNode.removeChild(styleEl);
      styleEl = null;
    }
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'pack-css';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = cssText || '';
  }

  // Replace classes on the given element so only `state-<state>` is present.
  // Used by every renderer so styles.css / pack.css selectors like
  // `.mascot.state-working` apply uniformly to img / div / svg roots.
  // Strips any state class — including overlay-only ones like
  // `state-dragging` — before applying the new one, so toggling between
  // realState and dragging never leaves stale classes attached.
  function setStateClass(el, state) {
    if (!el) return;
    VALID_STATES.forEach((s) => el.classList.remove(`state-${s}`));
    OVERLAY_STATES.forEach((s) => el.classList.remove(`state-${s}`));
    el.classList.add(`state-${state}`);
  }

  // ------------------------------------------------------------------------
  // SvgRenderer — original behavior. Pack ships a single mascot.svg whose
  // root <svg> gets `data-pack` so pack.css can scope rules to it.
  // ------------------------------------------------------------------------
  class SvgRenderer {
    constructor() {
      this.svgEl = null;
    }
    async mount(container, packData) {
      const { manifest, svg, css } = packData;
      if (!svg) throw new Error('svg renderer requires manifest+svg');
      applyPackCss(css);
      // Remove any previous mascot element. Bubble lives in this container
      // too and must NOT be removed.
      const prev = container.querySelector('.mascot');
      if (prev) prev.remove();
      container.insertAdjacentHTML('beforeend', svg);
      // The newly appended <svg> is the last <svg> child.
      const svgs = container.querySelectorAll('svg');
      const svgEl = svgs[svgs.length - 1];
      if (!svgEl) throw new Error('mascot.svg has no root <svg>');
      svgEl.classList.add('mascot');
      svgEl.setAttribute('data-pack', manifest.id);
      this.svgEl = svgEl;
    }
    setState(state) {
      setStateClass(this.svgEl, state);
    }
    destroy() {
      if (this.svgEl && this.svgEl.parentNode) this.svgEl.parentNode.removeChild(this.svgEl);
      this.svgEl = null;
      // Clear the pack stylesheet so leftover @keyframes / selectors from a
      // previous pack don't accidentally match the next pack's elements.
      applyPackCss('');
    }
  }

  // ------------------------------------------------------------------------
  // ImageRenderer — manifest.states maps state -> path inside the pack folder.
  // We render with a single <img class="mascot"> and just swap its src on
  // setState. Works for GIF/APNG/PNG/WEBP/SVG (anything <img> can decode).
  //
  // Path note: index.html lives at renderer/index.html, so the relative URL
  // back to assets/characters/<id>/<rel> is `../assets/characters/<id>/<rel>`.
  // file:// resolves it without any fetch involvement, which is exactly why
  // we don't pre-read the bytes in main.js.
  // ------------------------------------------------------------------------
  class ImageRenderer {
    constructor() {
      this.imgEl = null;
      this.packId = null;
      this.states = {};
      this.fallbackState = 'idle';
    }
    async mount(container, packData) {
      const { manifest, css } = packData;
      applyPackCss(css);
      this.packId = manifest.id;
      this.states = (manifest.states && typeof manifest.states === 'object') ? manifest.states : {};
      this.fallbackState = manifest.fallbackState || 'idle';

      const prev = container.querySelector('.mascot');
      if (prev) prev.remove();

      const img = document.createElement('img');
      img.className = 'mascot';
      img.setAttribute('data-pack', manifest.id);
      img.setAttribute('alt', '');
      // draggable=false stops the browser native drag-and-drop from
      // intercepting -webkit-app-region:drag on mascot-wrap.
      img.setAttribute('draggable', 'false');
      container.appendChild(img);
      this.imgEl = img;
    }
    _resolveStatePath(state) {
      const states = this.states || {};
      if (states[state]) return states[state];
      if (states[this.fallbackState]) return states[this.fallbackState];
      // Last resort: any state at all.
      const keys = Object.keys(states);
      return keys.length ? states[keys[0]] : null;
    }
    setState(state) {
      if (!this.imgEl) return;
      setStateClass(this.imgEl, state);
      const rel = this._resolveStatePath(state);
      if (!rel) {
        // No image to show; clear src so we don't display a broken icon.
        this.imgEl.removeAttribute('src');
        return;
      }
      // index.html -> ../assets/characters/<id>/<rel>
      // encodeURI keeps spaces / unicode chars valid without breaking '/'.
      const next = `../assets/characters/${encodeURIComponent(this.packId)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
      // Avoid reloading the same animation mid-stream when the state didn't
      // actually change which file we display (e.g. setState('idle') called
      // back-to-back).
      if (this.imgEl.getAttribute('src') !== next) {
        this.imgEl.setAttribute('src', next);
      }
    }
    destroy() {
      if (this.imgEl && this.imgEl.parentNode) this.imgEl.parentNode.removeChild(this.imgEl);
      this.imgEl = null;
      applyPackCss('');
    }
  }

  // ------------------------------------------------------------------------
  // LottieRenderer — manifest.states maps state -> json path; main.js parses
  // every animation JSON and ships them to us in packData.animations.
  //
  // We host one `lottie.loadAnimation` instance at a time. setState destroys
  // the previous instance and creates a new one because lottie's
  // `goToAndPlay` only works on segments inside a single animation; switching
  // bodyMovin compositions cleanly is what `destroy()` is for.
  // ------------------------------------------------------------------------
  class LottieRenderer {
    constructor() {
      this.hostEl = null;
      this.anim = null;
      this.animations = {};
      this.fallbackState = 'idle';
      this.packId = null;
    }
    async mount(container, packData) {
      const { manifest, css, animations } = packData;
      applyPackCss(css);
      this.animations = animations && typeof animations === 'object' ? animations : {};
      this.fallbackState = manifest.fallbackState || 'idle';
      this.packId = manifest.id;

      const prev = container.querySelector('.mascot');
      if (prev) prev.remove();

      const host = document.createElement('div');
      host.className = 'mascot lottie-host';
      host.setAttribute('data-pack', manifest.id);
      container.appendChild(host);
      this.hostEl = host;

      if (!window.lottie) {
        // Surface the failure clearly in the bubble — the renderer's normal
        // bubbleText is set later by setState/updateBubble, but this is the
        // most visible place for a setup error.
        bubbleText.textContent = 'lottie 未読込';
        console.warn('[desktopi] lottie unavailable — install lottie-web and run npm install');
      }
    }
    _resolveAnimation(state) {
      const map = this.animations || {};
      if (map[state]) return map[state];
      if (map[this.fallbackState]) return map[this.fallbackState];
      const keys = Object.keys(map);
      return keys.length ? map[keys[0]] : null;
    }
    setState(state) {
      if (!this.hostEl) return;
      setStateClass(this.hostEl, state);
      if (!window.lottie) return;
      const data = this._resolveAnimation(state);
      if (!data) return;
      // Tear down the previous animation; lottie keeps an internal RAF loop
      // and DOM nodes that we don't want to leak across state swaps.
      if (this.anim) {
        try { this.anim.destroy(); } catch {}
        this.anim = null;
      }
      // Lottie clones whatever it appends inside the host element. We clear
      // hostEl ourselves to be sure it starts empty (anim.destroy() should
      // already have done this, but defensive).
      while (this.hostEl.firstChild) this.hostEl.removeChild(this.hostEl.firstChild);
      try {
        this.anim = window.lottie.loadAnimation({
          container: this.hostEl,
          renderer: 'svg',
          loop: true,
          autoplay: true,
          animationData: data,
        });
      } catch (err) {
        console.error('[desktopi] lottie loadAnimation failed:', err);
      }
    }
    destroy() {
      if (this.anim) {
        try { this.anim.destroy(); } catch {}
        this.anim = null;
      }
      if (this.hostEl && this.hostEl.parentNode) this.hostEl.parentNode.removeChild(this.hostEl);
      this.hostEl = null;
      applyPackCss('');
    }
  }

  const RENDERER_REGISTRY = {
    svg: SvgRenderer,
    image: ImageRenderer,
    lottie: LottieRenderer,
  };

  // ------------------------------------------------------------------------
  // Bubble + state plumbing (renderer-agnostic).
  // ------------------------------------------------------------------------
  function updateBubble(state, message) {
    const label = message && message.trim() ? message : (STATE_LABELS[state] || state);
    bubbleText.textContent = label;
    bubble.classList.toggle('is-idle', state === 'idle');
    bubble.classList.remove('is-hidden');
  }

  function setBubbleAnchor(anchor) {
    const allowed = ['top-right', 'top-left', 'top'];
    bubble.dataset.anchor = allowed.includes(anchor) ? anchor : 'top-right';
  }

  // setState updates the realState (state from main.js) and re-evaluates
  // which visual to actually show. While an overlay is active, the renderer
  // shows the overlay instead, but realState keeps progressing (including
  // the done -> idle auto-reset timer) so the moment the overlay clears we
  // snap to whatever realState has become.
  function setState(state, message) {
    if (!VALID_STATES.includes(state)) return;
    realState = state;
    currentMessage = typeof message === 'string' ? message : '';

    if (doneResetTimer) {
      clearTimeout(doneResetTimer);
      doneResetTimer = null;
    }
    // done -> idle auto-reset operates on realState. We don't suspend it
    // during a drag — by the time the drag ends, realState may already be
    // back to 'idle' and that's fine.
    if (state === 'done') {
      doneResetTimer = setTimeout(() => {
        setState('idle', '');
      }, 2500);
    }

    applyEffectiveState();
  }

  // Apply realState OR the active overlay (dragging / falling / landed),
  // whichever is currently in effect, to the active renderer. Bubble text
  // always reflects realState — we intentionally don't change the bubble
  // during the drag/fall/land sequence (would be noisy and the visual
  // itself communicates "tummy held up / falling / squashed").
  function applyEffectiveState() {
    const effective = overlayState ?? realState;
    if (activeRenderer) activeRenderer.setState(effective);
    updateBubble(realState, currentMessage);
  }

  function setOverlay(next) {
    // null clears the overlay; any other value must be a known overlay.
    const value = next == null ? null : (VALID_OVERLAYS.has(next) ? next : null);
    if (value === overlayState) return;
    overlayState = value;
    applyEffectiveState();
  }

  async function loadPack(packId) {
    if (!window.api || typeof window.api.loadPack !== 'function') {
      throw new Error('window.api.loadPack unavailable (preload not loaded?)');
    }
    const packData = await window.api.loadPack(packId);
    const { manifest } = packData;
    if (!manifest || !manifest.id) {
      throw new Error(`invalid manifest for pack '${packId}'`);
    }
    const rendererType = manifest.renderer || 'svg';
    const RendererClass = RENDERER_REGISTRY[rendererType];
    if (!RendererClass) {
      throw new Error(`unsupported renderer '${rendererType}' for pack '${packId}'`);
    }

    // Tear down the previous renderer before mounting the new one. This is
    // important especially for LottieRenderer (frees its RAF loop) and keeps
    // pack.css from the previous pack out of the way.
    if (activeRenderer) {
      try { activeRenderer.destroy(); } catch (err) {
        console.warn('[desktopi] previous renderer destroy() failed:', err);
      }
      activeRenderer = null;
    }

    const inst = new RendererClass();
    await inst.mount(mascotWrap, packData);
    activeRenderer = inst;

    const anchor = (manifest.bubble && manifest.bubble.anchor) || 'top-right';
    setBubbleAnchor(anchor);

    currentPackId = manifest.id;
    // Re-apply the effective state (realState or dragging overlay) on the
    // freshly mounted renderer so a pack swap mid-drag still looks right.
    applyEffectiveState();
    console.log('[desktopi] loaded pack:', manifest.id, `(renderer=${rendererType})`);
  }

  async function loadInitialPack() {
    const tryOrder = [...PREFERRED_PACKS];
    if (window.api && typeof window.api.listPacks === 'function') {
      try {
        const packs = await window.api.listPacks();
        if (Array.isArray(packs)) {
          for (const p of packs) {
            if (p && p.id && !tryOrder.includes(p.id)) tryOrder.push(p.id);
          }
        }
      } catch (err) {
        console.warn('[desktopi] listPacks failed:', err);
      }
    }
    for (const id of tryOrder) {
      try {
        await loadPack(id);
        return;
      } catch (err) {
        console.error('[desktopi] loadPack failed:', id, err);
      }
    }
    bubbleText.textContent = 'パック読込失敗';
  }

  async function switchPack(id) {
    if (!id || id === currentPackId) return;
    try {
      await loadPack(id);
    } catch (err) {
      console.error('[desktopi] loadPack failed:', id, err);
    }
  }

  // ------------------------------------------------------------------------
  // Per-session label. Truncate long names (e.g. very long folder names) to
  // keep the label visually compact — full path lives in cwd if needed.
  // ------------------------------------------------------------------------
  function applySessionInfo(payload) {
    if (!sessionLabel) return;
    const name = payload && typeof payload.displayName === 'string' ? payload.displayName : '';
    const isDefault = !!(payload && payload.isDefault);
    if (!name || isDefault || name === '__default__') {
      sessionLabel.textContent = '';
      sessionLabel.setAttribute('hidden', '');
      return;
    }
    const trimmed = name.length > SESSION_LABEL_MAX
      ? name.slice(0, SESSION_LABEL_MAX - 1) + '…'
      : name;
    sessionLabel.textContent = trimmed;
    if (payload && typeof payload.cwd === 'string' && payload.cwd) {
      sessionLabel.setAttribute('title', payload.cwd);
    } else {
      sessionLabel.removeAttribute('title');
    }
    sessionLabel.removeAttribute('hidden');
  }

  // ---- Wire IPC ----
  if (window.api && typeof window.api.onState === 'function') {
    window.api.onState((payload) => {
      if (!payload || typeof payload !== 'object') return;
      setState(payload.state, payload.message || '');
    });
  }
  if (window.api && typeof window.api.onSwitchPack === 'function') {
    window.api.onSwitchPack((id) => switchPack(id));
  }
  // Walking visualization: main drives walking on/off and facing direction.
  // Toggling the wrap classes is independent of renderer type — the
  // `transform: scaleX(-1)` rule in styles.css targets `.mascot` so it works
  // for img / div / svg uniformly.
  if (window.api && typeof window.api.onMovement === 'function') {
    window.api.onMovement((payload) => {
      if (!payload || typeof payload !== 'object') return;
      const walking = !!payload.walking;
      const dir = payload.direction === 'left' ? 'left' : 'right';
      mascotWrap.classList.toggle('walking', walking);
      mascotWrap.classList.toggle('facing-left', dir === 'left');
      mascotWrap.classList.toggle('facing-right', dir === 'right');
    });
  }
  // Per-window identity. Sent once after main receives renderer-ready, and
  // re-sent if cwd is updated later (e.g. when a hook supplies it after the
  // first state POST). Hide the label entirely for __default__.
  if (window.api && typeof window.api.onSessionInfo === 'function') {
    window.api.onSessionInfo((payload) => {
      if (!payload || typeof payload !== 'object') return;
      applySessionInfo(payload);
    });
  }
  // Overlay: main pushes the current overlay state for this window.
  // payload.overlay is one of 'dragging' | 'falling' | 'landed' | null.
  // Non-null values override realState; null snaps back to whatever
  // realState has become in the meantime.
  if (window.api && typeof window.api.onOverlay === 'function') {
    window.api.onOverlay((payload) => {
      if (!payload || typeof payload !== 'object') return;
      setOverlay(payload.overlay == null ? null : payload.overlay);
    });
  }

  // Boot: load the initial pack, then announce ready so main can replay state.
  loadInitialPack().then(() => {
    setState('idle', '');
    if (window.api && typeof window.api.rendererReady === 'function') {
      window.api.rendererReady();
    }
  });
})();
