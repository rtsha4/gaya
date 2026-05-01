(function () {
  const { VALID_STATES: VALID_STATES_ARR, OVERLAY_STATES, RENDERER_REGISTRY } = window.PackRenderers;
  const VALID_STATES = VALID_STATES_ARR;
  const VALID_OVERLAYS = new Set(OVERLAY_STATES);
  // Default-first preference list. If neither pack exists, loadPack falls back
  // to whatever the first manifest fetch happens to succeed for.
  const PREFERRED_PACKS = ['grave-ghost', 'pop', 'classic'];
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
  // Session displayName: shown inside the bubble while the mouse hovers the
  // mascot, so stacked mascots can be told apart without a permanent label.
  // Empty string (default / nameless sessions) means hover does nothing.
  let sessionDisplayName = '';
  let isHovered = false;
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

  // Bubble + state plumbing (renderer-agnostic).
  // While the mascot is hovered AND we have a displayName for this session,
  // the bubble text is overridden with the session name so the user can
  // identify stacked mascots. The is-idle dimming still tracks realState so
  // a hover doesn't visually mute a non-idle bubble.
  function updateBubble(state, message) {
    const showSession = isHovered && sessionDisplayName;
    const label = showSession
      ? sessionDisplayName
      : (message && message.trim() ? message : (STATE_LABELS[state] || state));
    bubbleText.textContent = label;
    bubble.classList.toggle('is-idle', state === 'idle');
    bubble.classList.remove('is-hidden');
  }

  // The pack's manifest-supplied anchor (default: 'top-right'). Stored so we
  // can fall back to it when the user-level override is 'auto'.
  let packBubbleAnchor = 'top-right';
  // User override from main.js. 'auto' means "use whatever the pack asked for".
  let userBubblePosition = 'auto';
  const ALLOWED_BUBBLE_ANCHORS = ['top-right', 'top-left', 'top'];

  function applyBubbleAnchor() {
    const candidate = userBubblePosition !== 'auto' ? userBubblePosition : packBubbleAnchor;
    bubble.dataset.anchor = ALLOWED_BUBBLE_ANCHORS.includes(candidate) ? candidate : 'top-right';
  }

  function setPackBubbleAnchor(anchor) {
    packBubbleAnchor = ALLOWED_BUBBLE_ANCHORS.includes(anchor) ? anchor : 'top-right';
    applyBubbleAnchor();
  }

  function setUserBubblePosition(position) {
    userBubblePosition = position === 'auto' || ALLOWED_BUBBLE_ANCHORS.includes(position)
      ? position
      : 'auto';
    applyBubbleAnchor();
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
        console.warn('[gaya] previous renderer destroy() failed:', err);
      }
      activeRenderer = null;
    }

    const inst = new RendererClass({
      onMissingLottie: () => { bubbleText.textContent = 'lottie 未読込'; },
    });
    await inst.mount(mascotWrap, packData);
    activeRenderer = inst;

    const anchor = (manifest.bubble && manifest.bubble.anchor) || 'top-right';
    setPackBubbleAnchor(anchor);

    currentPackId = manifest.id;
    // Re-apply the effective state (realState or dragging overlay) on the
    // freshly mounted renderer so a pack swap mid-drag still looks right.
    applyEffectiveState();
    console.log('[gaya] loaded pack:', manifest.id, `(renderer=${rendererType})`);
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
        console.warn('[gaya] listPacks failed:', err);
      }
    }
    for (const id of tryOrder) {
      try {
        await loadPack(id);
        return;
      } catch (err) {
        console.error('[gaya] loadPack failed:', id, err);
      }
    }
    bubbleText.textContent = 'パック読込失敗';
  }

  async function switchPack(id) {
    if (!id || id === currentPackId) return;
    try {
      await loadPack(id);
    } catch (err) {
      console.error('[gaya] loadPack failed:', id, err);
    }
  }

  // Cache the session's displayName for the hover-to-reveal swap. Truncate
  // long names so they don't overflow the bubble; full cwd remains in main.
  // If the name is empty (no cwd, no usable id prefix) we leave
  // sessionDisplayName empty so hovering doesn't replace the state text with
  // anything misleading.
  function applySessionInfo(payload) {
    const name = payload && typeof payload.displayName === 'string' ? payload.displayName : '';
    if (!name) {
      sessionDisplayName = '';
    } else {
      sessionDisplayName = name.length > SESSION_LABEL_MAX
        ? name.slice(0, SESSION_LABEL_MAX - 1) + '…'
        : name;
    }
    // If the user is hovering right now, refresh the bubble immediately so
    // the swapped text reflects the latest session info.
    if (isHovered) updateBubble(realState, currentMessage);
  }

  // Hover swap: only flip the bubble when we actually have a name to show
  // (otherwise leave the state text alone). Re-render via updateBubble so
  // the is-idle class and message handling stay in one place.
  mascotWrap.addEventListener('mouseenter', () => {
    isHovered = true;
    if (sessionDisplayName) updateBubble(realState, currentMessage);
  });
  mascotWrap.addEventListener('mouseleave', () => {
    if (!isHovered) return;
    isHovered = false;
    updateBubble(realState, currentMessage);
  });

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
  // first state POST).
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
  // Global bubble-position override pushed from main (Tray → Bubble Position).
  // payload.position is one of 'auto' | 'top-right' | 'top-left' | 'top'.
  if (window.api && typeof window.api.onBubblePosition === 'function') {
    window.api.onBubblePosition((payload) => {
      if (!payload || typeof payload !== 'object') return;
      setUserBubblePosition(payload.position);
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
