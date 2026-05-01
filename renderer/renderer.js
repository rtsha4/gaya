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

  const stage = document.getElementById('stage');
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
  // NOTE: visibility (the is-hidden class) is owned by bumpAutoHide /
  // hideBubbleIfIdle / the hover handlers — updateBubble must not toggle it,
  // otherwise every state/message refresh would briefly un-hide a bubble
  // that's supposed to be invisible.
  function updateBubble(state, message) {
    const showSession = isHovered && sessionDisplayName;
    const label = showSession
      ? sessionDisplayName
      : (message && message.trim() ? message : (STATE_LABELS[state] || state));
    bubbleText.textContent = label;
    bubble.classList.toggle('is-idle', state === 'idle');
  }

  // Bubble auto-hide: by default the bubble is hidden. It pops in for ~6s
  // each time state OR message changes, then fades back out. Hovering the
  // mascot keeps it visible (and swaps to session displayName).
  const BUBBLE_AUTO_HIDE_MS = 6000;
  let autoHideTimer = null;
  function clearAutoHide() {
    if (autoHideTimer) {
      clearTimeout(autoHideTimer);
      autoHideTimer = null;
    }
  }
  function showBubble() {
    bubble.classList.remove('is-hidden');
  }
  function hideBubbleIfIdle() {
    if (isHovered) return;
    bubble.classList.add('is-hidden');
  }
  function bumpAutoHide() {
    showBubble();
    clearAutoHide();
    autoHideTimer = setTimeout(() => {
      autoHideTimer = null;
      hideBubbleIfIdle();
    }, BUBBLE_AUTO_HIDE_MS);
  }

  // The pack's manifest-supplied anchor (default: 'top-right'). Stored so we
  // can fall back to it when the user-level override is 'auto'.
  let packBubbleAnchor = 'top-right';
  // User override from main.js. 'auto' means "use whatever the pack asked for".
  let userBubblePosition = 'auto';
  const ALLOWED_BUBBLE_ANCHORS = ['top-right', 'top-left', 'top', 'right', 'left'];

  function applyBubbleAnchor() {
    const candidate = userBubblePosition !== 'auto' ? userBubblePosition : packBubbleAnchor;
    const final = ALLOWED_BUBBLE_ANCHORS.includes(candidate) ? candidate : 'top-right';
    bubble.dataset.anchor = final;
    // Mirror the anchor onto the stage so the mascot can be biased to one
    // side when the bubble is sideways (right/left). Top-anchored bubbles
    // leave the stage's default centered layout untouched.
    if (stage) stage.dataset.bubbleAnchor = final;
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
  //
  // opts.silent (default: false) suppresses the auto-show bubble bump. Used
  // by the internal done -> idle timer so a finished session quietly fades
  // its bubble out without re-popping it 2.5s later.
  function setState(state, message, opts) {
    if (!VALID_STATES.includes(state)) return;
    const newMessage = typeof message === 'string' ? message : '';
    // Compute change flags BEFORE mutating, so bumpAutoHide can be conditional
    // on actual change (avoids a noisy "every POST resurrects the bubble").
    const stateChanged = state !== realState;
    const messageChanged = newMessage !== currentMessage;
    realState = state;
    currentMessage = newMessage;

    if (doneResetTimer) {
      clearTimeout(doneResetTimer);
      doneResetTimer = null;
    }
    // done -> idle auto-reset operates on realState. We don't suspend it
    // during a drag — by the time the drag ends, realState may already be
    // back to 'idle' and that's fine. The reset is silent: the bubble
    // shouldn't pop back up just because 2.5s passed.
    if (state === 'done') {
      doneResetTimer = setTimeout(() => {
        setState('idle', '', { silent: true });
      }, 2500);
    }

    applyEffectiveState();

    if (!opts?.silent && (stateChanged || messageChanged)) {
      bumpAutoHide();
    }
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

  // Hover swap: only flip the bubble text when we actually have a name to
  // show (otherwise leave the state text alone). Hover ALSO holds the bubble
  // visible — it cancels any pending auto-hide and shows the bubble even if
  // it was hidden a moment ago. On leave we don't immediately hide; if a
  // bump timer is in flight we let it expire naturally, otherwise we hide.
  //
  // Listener lives on `stage` (the whole window) rather than `mascotWrap`
  // because `-webkit-app-region: drag` on mascotWrap routes mouse events to
  // the OS for window dragging, which makes mouseenter/mouseleave on the
  // mascot's body unreliable. The stage element fills the whole window and
  // is not a drag region itself, so hover fires consistently anywhere over
  // the mascot — including the bubble area that overflows mascot-wrap.
  const hoverTarget = stage || mascotWrap;
  hoverTarget.addEventListener('mouseenter', () => {
    isHovered = true;
    clearAutoHide();
    showBubble();
    if (sessionDisplayName) updateBubble(realState, currentMessage);
  });
  hoverTarget.addEventListener('mouseleave', () => {
    if (!isHovered) return;
    isHovered = false;
    updateBubble(realState, currentMessage);
    if (!autoHideTimer) hideBubbleIfIdle();
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

  // Boot: hide the bubble by default. The first setState('idle','') below
  // is a no-op for change tracking (state and message both equal their
  // initial values) so it does NOT bump the auto-hide — the bubble stays
  // invisible until a real state change or message arrives.
  bubble.classList.add('is-hidden');

  loadInitialPack().then(() => {
    setState('idle', '');
    if (window.api && typeof window.api.rendererReady === 'function') {
      window.api.rendererReady();
    }
  });
})();
