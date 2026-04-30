// Shared MascotRenderer classes used by both the mascot window (renderer.js)
// and the pack preview window (preview.js). Loaded via a plain <script> tag
// so it works under sandbox:true file:// without ES module plumbing.
//
// Exposes window.PackRenderers = {
//   VALID_STATES, OVERLAY_STATES, RENDERER_REGISTRY,
//   applyPackCss(cssText, root?),
//   setStateClass(el, state),
//   SvgRenderer, ImageRenderer, LottieRenderer,
// }.
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

  // Pack CSS plumbing — shared by every renderer. Each pack ships an optional
  // pack.css and we mirror it into a single <style id="pack-css"> so a swap
  // is just a textContent assignment (no <link> reload, no fetch).
  //
  // The optional `root` parameter scopes the <style> id so the preview window
  // (which wants its pack.css applied only inside the stage <iframe>-like
  // wrapper) can have its own slot independent of the main mascot window.
  function applyPackCss(cssText, opts) {
    const id = (opts && opts.styleId) || 'pack-css';
    const target = (opts && opts.root) || document.head;
    let styleEl = (opts && opts.root)
      ? opts.root.querySelector(`style[data-pack-css="${id}"]`)
      : document.getElementById(id);
    // If a stale <link id="pack-css"> exists from older builds, replace it
    // with a <style> so the id stays unique.
    if (styleEl && styleEl.tagName !== 'STYLE') {
      styleEl.parentNode.removeChild(styleEl);
      styleEl = null;
    }
    if (!styleEl) {
      styleEl = document.createElement('style');
      if (opts && opts.root) {
        styleEl.setAttribute('data-pack-css', id);
      } else {
        styleEl.id = id;
      }
      target.appendChild(styleEl);
    }
    styleEl.textContent = cssText || '';
  }

  // Replace classes on the given element so only `state-<state>` is present.
  // Used by every renderer so styles.css / pack.css selectors like
  // `.mascot.state-working` apply uniformly to img / div / svg roots.
  function setStateClass(el, state) {
    if (!el) return;
    VALID_STATES.forEach((s) => el.classList.remove(`state-${s}`));
    OVERLAY_STATES.forEach((s) => el.classList.remove(`state-${s}`));
    el.classList.add(`state-${state}`);
  }

  // ------------------------------------------------------------------------
  // SvgRenderer — pack ships a single mascot.svg whose root <svg> gets
  // `data-pack` so pack.css can scope rules to it.
  // ------------------------------------------------------------------------
  class SvgRenderer {
    constructor(opts) {
      this.svgEl = null;
      this.cssOpts = opts && opts.cssOpts ? opts.cssOpts : null;
    }
    async mount(container, packData) {
      const { manifest, svg, css } = packData;
      if (!svg) throw new Error('svg renderer requires manifest+svg');
      applyPackCss(css, this.cssOpts);
      const prev = container.querySelector('.mascot');
      if (prev) prev.remove();
      container.insertAdjacentHTML('beforeend', svg);
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
      applyPackCss('', this.cssOpts);
    }
  }

  // ------------------------------------------------------------------------
  // ImageRenderer — manifest.states maps state -> path inside the pack folder.
  // Renders a single <img class="mascot"> and swaps `src` on setState.
  // index.html lives at renderer/index.html, so the relative URL back to
  // assets/characters/<id>/<rel> is `../assets/characters/<id>/<rel>`.
  // ------------------------------------------------------------------------
  class ImageRenderer {
    constructor(opts) {
      this.imgEl = null;
      this.packId = null;
      this.states = {};
      this.fallbackState = 'idle';
      this.cssOpts = opts && opts.cssOpts ? opts.cssOpts : null;
    }
    async mount(container, packData) {
      const { manifest, css } = packData;
      applyPackCss(css, this.cssOpts);
      this.packId = manifest.id;
      this.states = (manifest.states && typeof manifest.states === 'object') ? manifest.states : {};
      this.fallbackState = manifest.fallbackState || 'idle';

      const prev = container.querySelector('.mascot');
      if (prev) prev.remove();

      const img = document.createElement('img');
      img.className = 'mascot';
      img.setAttribute('data-pack', manifest.id);
      img.setAttribute('alt', '');
      img.setAttribute('draggable', 'false');
      container.appendChild(img);
      this.imgEl = img;
    }
    _resolveStatePath(state) {
      const states = this.states || {};
      if (states[state]) return states[state];
      if (states[this.fallbackState]) return states[this.fallbackState];
      const keys = Object.keys(states);
      return keys.length ? states[keys[0]] : null;
    }
    setState(state) {
      if (!this.imgEl) return;
      setStateClass(this.imgEl, state);
      const rel = this._resolveStatePath(state);
      if (!rel) {
        this.imgEl.removeAttribute('src');
        return;
      }
      const next = `../assets/characters/${encodeURIComponent(this.packId)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
      if (this.imgEl.getAttribute('src') !== next) {
        this.imgEl.setAttribute('src', next);
      }
    }
    destroy() {
      if (this.imgEl && this.imgEl.parentNode) this.imgEl.parentNode.removeChild(this.imgEl);
      this.imgEl = null;
      applyPackCss('', this.cssOpts);
    }
  }

  // ------------------------------------------------------------------------
  // LottieRenderer — manifest.states maps state -> json path; main.js parses
  // every animation JSON and ships them in packData.animations. We host one
  // `lottie.loadAnimation` instance at a time and tear it down on each
  // setState because bodyMovin's goToAndPlay only works inside a single
  // animation.
  // ------------------------------------------------------------------------
  class LottieRenderer {
    constructor(opts) {
      this.hostEl = null;
      this.anim = null;
      this.animations = {};
      this.fallbackState = 'idle';
      this.packId = null;
      this.cssOpts = opts && opts.cssOpts ? opts.cssOpts : null;
      this.onMissingLottie = (opts && typeof opts.onMissingLottie === 'function') ? opts.onMissingLottie : null;
    }
    async mount(container, packData) {
      const { manifest, css, animations } = packData;
      applyPackCss(css, this.cssOpts);
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
        if (this.onMissingLottie) {
          try { this.onMissingLottie(); } catch {}
        }
        console.warn('[gaya] lottie unavailable — install lottie-web and run npm install');
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
      if (this.anim) {
        try { this.anim.destroy(); } catch {}
        this.anim = null;
      }
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
        console.error('[gaya] lottie loadAnimation failed:', err);
      }
    }
    destroy() {
      if (this.anim) {
        try { this.anim.destroy(); } catch {}
        this.anim = null;
      }
      if (this.hostEl && this.hostEl.parentNode) this.hostEl.parentNode.removeChild(this.hostEl);
      this.hostEl = null;
      applyPackCss('', this.cssOpts);
    }
  }

  const RENDERER_REGISTRY = {
    svg: SvgRenderer,
    image: ImageRenderer,
    lottie: LottieRenderer,
  };

  window.PackRenderers = {
    VALID_STATES,
    OVERLAY_STATES,
    RENDERER_REGISTRY,
    applyPackCss,
    setStateClass,
    SvgRenderer,
    ImageRenderer,
    LottieRenderer,
  };
})();
