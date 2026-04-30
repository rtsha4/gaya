// Electron main process for gaya — a small desktop mascot that reacts to
// Claude Code hook events posted to a local HTTP server.
//
// Multi-session: a single Electron app hosts one mascot window per active
// Claude Code session. The HTTP server multiplexes POST /state by session_id
// and routes each update to the right window. A built-in `__default__`
// session always exists so older curl tests (no session_id) keep working.

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const PORT_START = 39999;
const PORT_END = 40010;
const VALID_STATES = new Set(['idle', 'thinking', 'working', 'waiting', 'done', 'error']);

// Tray title emoji per state. Reflected even while the window is hidden so the
// menu bar conveys the mascot's current activity at a glance.
const STATE_EMOJI = {
  idle: '🤖',
  thinking: '💭',
  working: '⚙️',
  waiting: '⚠️',
  done: '✅',
  error: '❌',
};
// Aggregation priority for the Tray title across multiple sessions.
// Highest priority first.
const STATE_PRIORITY = ['error', 'waiting', 'working', 'thinking', 'done', 'idle'];

// Pack discovery: the renderer also reads packs (via fetch), but main scans
// the directory for the Tray "Character" submenu so the user can swap visuals.
const CHARACTERS_DIR = path.join(__dirname, 'assets', 'characters');
// Default pack precedence: 'pop' wins, then 'classic', then anything else.
const PREFERRED_DEFAULTS = ['pop', 'classic'];

// Sentinel session id used when a POST has no session_id. Always exists.
const DEFAULT_SESSION_ID = '__default__';
// Hard cap on concurrent session windows (the __default__ session does not
// count against eviction, but does count against this number for layout).
const MAX_SESSIONS = 6;
// Auto-evict idle sessions after this many ms with no POST activity.
const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
// Periodic timer interval for evict checks.
const SESSION_REAP_INTERVAL_MS = 60 * 1000; // 1 minute
// Delay before destroying a window after SessionEnd (the "farewell" beat).
const SESSION_END_LINGER_MS = 2500;

let tray = null;
let clickThrough = false;
let httpServer = null;
let boundPort = null;
// Available packs ([{id, name}]) and the currently active id for the Tray menu.
let availablePacks = [];
let activePackId = null;

// ---- Persistent settings ----
// Stored under app.getPath('userData')/settings.json. Only specific keys are
// persisted; pack selection is intentionally NOT persisted (existing behavior).
const VALID_MOVEMENT_WHEN = new Set(['always', 'idle', 'off']);
const VALID_MOVEMENT_STYLE = new Set(['random', 'pacing']);
let movementWhen = 'idle';
let movementStyle = 'random';
let settingsPath = null;

function getSettingsPath() {
  if (!settingsPath) {
    settingsPath = path.join(app.getPath('userData'), 'settings.json');
  }
  return settingsPath;
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (VALID_MOVEMENT_WHEN.has(parsed.movementWhen)) movementWhen = parsed.movementWhen;
      if (VALID_MOVEMENT_STYLE.has(parsed.movementStyle)) movementStyle = parsed.movementStyle;
      if (typeof parsed.clickThrough === 'boolean') clickThrough = parsed.clickThrough;
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn('[gaya] failed to read settings.json:', err.message);
    }
    // Otherwise: first run; defaults stand.
  }
}

function saveSettings() {
  const payload = {
    movementWhen,
    movementStyle,
    clickThrough,
  };
  try {
    fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
    fs.writeFileSync(getSettingsPath(), JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.warn('[gaya] failed to write settings.json:', err.message);
  }
}

// ---- Movement constants ----
// Driven by a single global 50ms setInterval; window position is stepped
// each tick for *every* visible session.
const MOVE_TICK_MS = 50;
const FLOOR_EASE = 0.18; // y eases toward target by this fraction each tick
const PACING_SPEED = 50; // px/sec
const RANDOM_SPEED_MIN = 30;
const RANDOM_SPEED_MAX = 70;
// User drag pause: ms to hold off automatic movement after the user moves
// the window. Refreshed on each non-internal 'move' event.
const USER_DRAG_PAUSE_MS = 1500;
// User drag detection: a non-internal move starts a drag. If no further
// move arrives for this many ms we consider the drag finished.
const DRAG_END_DEBOUNCE_MS = 200;
// Floor proximity tolerance (px). When |posY - targetY| is within this we
// treat the mascot as already standing on the floor — used to decide whether
// a drag-release should play the falling overlay or skip straight to landed.
const FLOOR_THRESHOLD = 1.5;
// How long the squashed "landed" pose lingers before the overlay is cleared
// and the mascot returns to its realState animation. Tuned to match
// pop / classic landing keyframes.
const LANDED_DURATION_MS = 280;
// Random walk: idle/pause durations and direction-change cadence
const RW_PAUSE_MIN_MS = 1000;
const RW_PAUSE_MAX_MS = 3000;
const RW_TURN_MIN_MS = 1500;
const RW_TURN_MAX_MS = 4000;

// Width/height for new mascot windows (legacy default).
const WIN_WIDTH = 280;
const WIN_HEIGHT = 240;
// Per-session horizontal offset so multiple mascots don't stack on top of each
// other. Empirical value: each is 280px wide, 220px stride keeps a small
// overlap (helpful on narrow displays) while still distinguishing them.
const SESSION_X_STRIDE = 220;
const WIN_MARGIN = 24;

// Single global movement timer / drag/visibility state shared across sessions.
let moveTimer = null;
let lastTickAt = 0;
// True iff the user has chosen to hide all mascots via Tray. Independent of
// per-window isVisible() (which can also be false during a fade-out, etc.).
let mascotsHiddenByUser = false;

// All active sessions, keyed by session_id. Always contains DEFAULT_SESSION_ID.
//
// SessionData shape:
// {
//   id: string,
//   isDefault: boolean,           // __default__ never evicted, no label
//   cwd: string,
//   displayName: string,          // basename(cwd) or short id
//   state: string,
//   message: string,
//   lastActivity: number,         // Date.now() of last POST
//   window: BrowserWindow,
//   posX: number,
//   posY: number,
//   targetY: number,
//   direction: 1 | -1,
//   speed: number,
//   rwNextDecisionAt: number,
//   rwPaused: boolean,
//   internalMoveLock: boolean,
//   userDragHoldUntil: number,
//   lastSentWalking: boolean,
//   lastSentDirection: 'left' | 'right',
//   doneResetTimer: NodeJS.Timeout | null,
//   endLingerTimer: NodeJS.Timeout | null,
//   readyForState: boolean,       // becomes true after renderer-ready arrives
//   pendingState: { state, message } | null,  // queued send before ready
//   overlay: 'dragging' | 'falling' | 'landed' | null,
//                                  // overlay state shown on top of realState. Drives the
//                                  // dragging→falling→landed→null sequence (see overlay
//                                  // helpers below). Replaces the previous isDragging flag.
//   dragEndTimer: NodeJS.Timeout | null,  // debounce timer that fires DRAG_END_DEBOUNCE_MS after the last user-driven move
//   landedTimer: NodeJS.Timeout | null,  // clears the 'landed' overlay after LANDED_DURATION_MS
// }
const sessions = new Map();
let sessionReapTimer = null;

// Keep insertion order of sessions for layout (right-to-left). Map preserves
// insertion order, so we iterate it directly when laying out.

// ---- Pack discovery ----

function discoverPacks() {
  // Read directory synchronously at startup; packs are static on disk.
  let entries = [];
  try {
    entries = fs.readdirSync(CHARACTERS_DIR, { withFileTypes: true });
  } catch (err) {
    console.warn('[gaya] characters directory missing:', err.message);
    return [];
  }
  const packs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(CHARACTERS_DIR, entry.name, 'manifest.json');
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(raw);
      if (!manifest || !manifest.id) {
        console.warn(`[gaya] pack '${entry.name}' has no id, skipping`);
        continue;
      }
      packs.push({ id: manifest.id, name: manifest.name || manifest.id });
    } catch (err) {
      console.warn(`[gaya] could not load pack '${entry.name}':`, err.message);
    }
  }
  return packs;
}

function pickDefaultPack(packs) {
  if (!packs.length) return null;
  for (const id of PREFERRED_DEFAULTS) {
    if (packs.find((p) => p.id === id)) return id;
  }
  return packs[0].id;
}

// ---- Display name derivation ----

function deriveDisplayName(sessionId, cwd) {
  if (cwd && typeof cwd === 'string' && cwd.length) {
    const base = path.basename(cwd);
    if (base) return base;
  }
  if (sessionId === DEFAULT_SESSION_ID) return '';
  // Short prefix of session id (8 chars) keeps the label compact when cwd
  // is unavailable.
  return sessionId.slice(0, 8);
}

// ---- Layout / per-session window creation ----

// Compute initial position for a brand-new session window. We lay the
// non-default sessions out from right to left, with __default__ pinned at
// slot 0 (right-most). On wrap, drop a row up.
function computeInitialPositionForSession(sessionList, isDefault) {
  const { workArea } = screen.getPrimaryDisplay();
  // Slot 0 is reserved for __default__ at far right.
  // Other sessions occupy slot 1, 2, ... in arrival order.
  let slot;
  if (isDefault) {
    slot = 0;
  } else {
    // Count existing non-default sessions; assign next slot.
    let count = 0;
    for (const s of sessionList.values()) {
      if (!s.isDefault && !s.endLingerTimer) count += 1;
    }
    slot = count + 1; // +1 so __default__ keeps slot 0
  }
  // How many slots fit horizontally? Wrap once we run out of room.
  const usable = workArea.width - WIN_MARGIN * 2;
  const perRow = Math.max(1, Math.floor(usable / SESSION_X_STRIDE));
  const row = Math.floor(slot / perRow);
  const col = slot % perRow;

  const x = workArea.x + workArea.width - WIN_WIDTH - WIN_MARGIN - col * SESSION_X_STRIDE;
  const y = workArea.y + workArea.height - WIN_HEIGHT - WIN_MARGIN - row * (WIN_HEIGHT + 8);
  return { x, y };
}

function createSessionWindow(session) {
  const { x, y } = computeInitialPositionForSession(sessions, session.isDefault);
  session.posX = x;
  session.posY = y;
  const win = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false, // we'll show after ready-to-show to avoid flicker
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Drag detection: distinguish setPosition (internal) from a user drag.
  // The 'move' event fires once per OS-driven window position change while
  // the user holds the mouse. We treat the first non-internal move as the
  // start of a drag, and a 200ms gap with no further moves as drag-end.
  win.on('move', () => {
    if (session.internalMoveLock) return;
    if (!win || win.isDestroyed()) return;
    const [bx, by] = win.getPosition();
    session.posX = bx;
    session.posY = by;
    session.userDragHoldUntil = Date.now() + USER_DRAG_PAUSE_MS;
    sendMovement(session, false, session.direction === -1 ? 'left' : 'right');
    handleUserDragMove(session);
  });

  win.on('closed', () => {
    session.window = null;
  });

  win.once('ready-to-show', () => {
    if (mascotsHiddenByUser) return; // user pressed Hide before this finished
    if (!session.window || session.window.isDestroyed()) return;
    win.show();
    if (clickThrough) {
      win.setIgnoreMouseEvents(true, { forward: true });
    }
  });

  session.window = win;
}

// ---- Session lifecycle ----

function ensureSession(sessionId, cwd) {
  let s = sessions.get(sessionId);
  if (s) {
    // Update display info if newly known.
    if (cwd && !s.cwd) {
      s.cwd = cwd;
      s.displayName = deriveDisplayName(sessionId, cwd);
      // Resend session-info so the renderer label updates.
      sendSessionInfo(s);
    }
    s.lastActivity = Date.now();
    return s;
  }
  // Capacity check: evict the oldest non-default session if we'd exceed cap.
  // We count active (non-lingering) sessions toward the cap.
  const activeCount = countActiveSessions();
  if (activeCount >= MAX_SESSIONS) {
    evictOldestSession();
  }
  s = createSession(sessionId, cwd);
  sessions.set(sessionId, s);
  rebuildTrayMenu();
  return s;
}

function createSession(sessionId, cwd) {
  const isDefault = sessionId === DEFAULT_SESSION_ID;
  const session = {
    id: sessionId,
    isDefault,
    cwd: cwd || '',
    displayName: deriveDisplayName(sessionId, cwd || ''),
    state: 'idle',
    message: '',
    lastActivity: Date.now(),
    window: null,
    posX: 0,
    posY: 0,
    targetY: 0,
    direction: 1,
    speed: PACING_SPEED,
    rwNextDecisionAt: 0,
    rwPaused: false,
    internalMoveLock: false,
    userDragHoldUntil: 0,
    lastSentWalking: false,
    lastSentDirection: 'right',
    doneResetTimer: null,
    endLingerTimer: null,
    readyForState: false,
    pendingState: null,
    overlay: null,
    dragEndTimer: null,
    landedTimer: null,
  };
  createSessionWindow(session);
  return session;
}

function countActiveSessions() {
  let n = 0;
  for (const s of sessions.values()) {
    if (s.endLingerTimer) continue;
    n += 1;
  }
  return n;
}

function evictOldestSession() {
  // Find the oldest non-default session by lastActivity. __default__ is
  // exempt from eviction.
  let victim = null;
  for (const s of sessions.values()) {
    if (s.isDefault) continue;
    if (s.endLingerTimer) continue;
    if (!victim || s.lastActivity < victim.lastActivity) victim = s;
  }
  if (victim) {
    console.log('[gaya] evicting session for capacity:', victim.id);
    destroySession(victim);
  }
}

function destroySession(session) {
  if (session.doneResetTimer) {
    clearTimeout(session.doneResetTimer);
    session.doneResetTimer = null;
  }
  if (session.endLingerTimer) {
    clearTimeout(session.endLingerTimer);
    session.endLingerTimer = null;
  }
  if (session.dragEndTimer) {
    clearTimeout(session.dragEndTimer);
    session.dragEndTimer = null;
  }
  if (session.landedTimer) {
    clearTimeout(session.landedTimer);
    session.landedTimer = null;
  }
  session.overlay = null;
  if (session.window && !session.window.isDestroyed()) {
    try { session.window.destroy(); } catch {}
  }
  session.window = null;
  sessions.delete(session.id);
  rebuildTrayMenu();
}

function scheduleSessionEnd(session) {
  // SessionEnd: keep the mascot visible for a short beat, then destroy.
  if (session.isDefault) {
    // __default__ never goes away on SessionEnd; just mark idle.
    setSessionState(session, 'idle', '');
    return;
  }
  if (session.endLingerTimer) return; // already ending
  setSessionState(session, 'idle', '');
  session.endLingerTimer = setTimeout(() => {
    destroySession(session);
  }, SESSION_END_LINGER_MS);
}

function reapIdleSessions() {
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (s.isDefault) continue;
    if (s.endLingerTimer) continue;
    if (now - s.lastActivity >= SESSION_IDLE_TIMEOUT_MS) {
      console.log('[gaya] reaping idle session:', s.id);
      destroySession(s);
    }
  }
}

function startSessionReaper() {
  if (sessionReapTimer) return;
  sessionReapTimer = setInterval(reapIdleSessions, SESSION_REAP_INTERVAL_MS);
}

function stopSessionReaper() {
  if (sessionReapTimer) {
    clearInterval(sessionReapTimer);
    sessionReapTimer = null;
  }
}

// ---- Per-session helpers ----

function getDefaultSession() {
  return sessions.get(DEFAULT_SESSION_ID) || null;
}

// Y target = workArea bottom (mascot stands on the dock/edge).
function computeFloorY(session) {
  const win = session.window;
  if (!win || win.isDestroyed()) return session.posY;
  const { workArea } = screen.getPrimaryDisplay();
  const [, h] = win.getSize();
  return workArea.y + workArea.height - h;
}

function getXBounds(session) {
  const win = session.window;
  if (!win || win.isDestroyed()) return { min: 0, max: 0 };
  const { workArea } = screen.getPrimaryDisplay();
  const [w] = win.getSize();
  return { min: workArea.x, max: workArea.x + workArea.width - w };
}

function syncPositionFromWindow(session) {
  const win = session.window;
  if (!win || win.isDestroyed()) return;
  const [bx, by] = win.getPosition();
  session.posX = bx;
  session.posY = by;
  session.targetY = computeFloorY(session);
}

function setRandomSpeed(session) {
  session.speed = RANDOM_SPEED_MIN + Math.random() * (RANDOM_SPEED_MAX - RANDOM_SPEED_MIN);
}

function scheduleNextRwDecision(session) {
  const now = Date.now();
  session.rwNextDecisionAt = now + RW_TURN_MIN_MS + Math.random() * (RW_TURN_MAX_MS - RW_TURN_MIN_MS);
}

function shouldSessionMove(session) {
  // Any active overlay (dragging / falling / landed) freezes auto-movement
  // so the visual sequence isn't fighting walk animations.
  if (session.overlay !== null) return false;
  if (movementWhen === 'off') return false;
  if (movementWhen === 'always') return true;
  // 'idle' only walks when state is exactly 'idle'.
  return session.state === 'idle';
}

function sendMovement(session, walking, dir) {
  const win = session.window;
  if (!win || win.isDestroyed()) return;
  if (walking === session.lastSentWalking && dir === session.lastSentDirection) return;
  session.lastSentWalking = walking;
  session.lastSentDirection = dir;
  win.webContents.send('movement', { walking, direction: dir });
}

// Send the current overlay state to the renderer. payload.overlay is one of
// 'dragging' | 'falling' | 'landed' | null. The renderer mirrors this onto
// its overlayState and applies it on top of realState.
function sendOverlay(session, overlay) {
  session.overlay = overlay;
  const win = session.window;
  if (!win || win.isDestroyed()) return;
  win.webContents.send('overlay', { overlay });
}

// True when posY is within FLOOR_THRESHOLD of the floor target. When this is
// true at drag-release we skip 'falling' and go straight to 'landed'.
function isOnFloor(session) {
  return Math.abs(session.posY - session.targetY) <= FLOOR_THRESHOLD;
}

// Schedule the LANDED_DURATION_MS pose, after which the overlay is cleared
// and the mascot returns to realState. Replaces any in-flight landed timer.
function scheduleLandedClear(session) {
  if (session.landedTimer) {
    clearTimeout(session.landedTimer);
  }
  session.landedTimer = setTimeout(() => {
    session.landedTimer = null;
    // Defensive: only clear when still in 'landed' (a re-drag may have
    // already moved us back to 'dragging').
    if (session.overlay === 'landed') {
      sendOverlay(session, null);
    }
  }, LANDED_DURATION_MS);
}

// Called from BrowserWindow 'move' (non-internal moves only). Starts a drag
// on the first event of a burst, and (re)arms a 200ms debounce timer that
// will declare the drag finished once the user stops dragging.
function handleUserDragMove(session) {
  // Re-drag: cancel any pending landed-clear so the timer can't fire and
  // wipe the overlay out from under the new dragging state.
  if (session.landedTimer) {
    clearTimeout(session.landedTimer);
    session.landedTimer = null;
  }
  if (session.overlay !== 'dragging') {
    // Stop the walk animation immediately so it doesn't fight the dragging
    // visual. lastSentWalking tracking inside sendMovement collapses repeats.
    sendMovement(session, false, session.direction === -1 ? 'left' : 'right');
    sendOverlay(session, 'dragging');
  }
  if (session.dragEndTimer) {
    clearTimeout(session.dragEndTimer);
  }
  session.dragEndTimer = setTimeout(() => {
    finishSessionDrag(session);
  }, DRAG_END_DEBOUNCE_MS);
}

function finishSessionDrag(session) {
  session.dragEndTimer = null;
  // If we're not currently in 'dragging' (e.g. drag was already replaced
  // by something else), nothing to wrap up.
  if (session.overlay !== 'dragging') return;

  // Refresh the floor target for an accurate floor check at release time.
  session.targetY = computeFloorY(session);

  if (isOnFloor(session)) {
    // Snap directly to landed: there's no fall to play.
    sendOverlay(session, 'landed');
    scheduleLandedClear(session);
  } else {
    // Hand off to the tick loop, which will ease posY toward targetY and
    // promote 'falling' -> 'landed' the moment we reach the floor.
    sendOverlay(session, 'falling');
  }
}

function sendStateToSession(session) {
  const win = session.window;
  if (!win || win.isDestroyed()) return;
  const payload = { state: session.state, message: session.message };
  if (!session.readyForState) {
    // Renderer hasn't announced ready yet — queue the latest payload so it
    // arrives on the very next renderer-ready ping. Coalesce: only the most
    // recent state matters.
    session.pendingState = payload;
    return;
  }
  win.webContents.send('state', payload);
}

function sendSessionInfo(session) {
  const win = session.window;
  if (!win || win.isDestroyed()) return;
  const payload = {
    sessionId: session.id,
    isDefault: session.isDefault,
    displayName: session.displayName || '',
    cwd: session.cwd || '',
  };
  // Safe to send before renderer-ready: renderer attaches the listener
  // synchronously via the preload bridge during script evaluation. But to be
  // robust against race conditions, also stash for replay on renderer-ready.
  session.pendingSessionInfo = payload;
  win.webContents.send('session-info', payload);
}

// ---- Movement loop (single global timer) ----

function tickAllSessions() {
  if (mascotsHiddenByUser) return;
  const now = Date.now();
  const dt = lastTickAt ? Math.min(0.2, (now - lastTickAt) / 1000) : MOVE_TICK_MS / 1000;
  lastTickAt = now;

  for (const session of sessions.values()) {
    tickSession(session, now, dt);
  }
}

function tickSession(session, now, dt) {
  const win = session.window;
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) return;

  // User just dragged: hold off for the pause window. Don't walk visually.
  if (now < session.userDragHoldUntil) {
    sendMovement(session, false, session.direction === -1 ? 'left' : 'right');
    return;
  }

  const moving = shouldSessionMove(session);
  session.targetY = computeFloorY(session);
  const { min: minX, max: maxX } = getXBounds(session);

  // Ease y toward floor regardless (smooth landing after a drag).
  if (Math.abs(session.posY - session.targetY) > 0.5) {
    session.posY += (session.targetY - session.posY) * FLOOR_EASE;
  } else {
    session.posY = session.targetY;
  }

  // Falling overlay: wait until posY reaches the floor, then promote to
  // 'landed' and schedule the overlay clear. The dragging case never lands
  // through this path — it stays in 'dragging' until the user releases.
  if (session.overlay === 'falling' && isOnFloor(session)) {
    sendOverlay(session, 'landed');
    scheduleLandedClear(session);
  }

  let walkingNow = false;

  if (moving) {
    if (movementStyle === 'pacing') {
      session.speed = PACING_SPEED;
      session.posX += session.direction * session.speed * dt;
      if (session.posX <= minX) {
        session.posX = minX;
        session.direction = 1;
      } else if (session.posX >= maxX) {
        session.posX = maxX;
        session.direction = -1;
      }
      walkingNow = true;
    } else {
      // random walk
      if (session.rwNextDecisionAt === 0) {
        setRandomSpeed(session);
        scheduleNextRwDecision(session);
      }
      if (now >= session.rwNextDecisionAt) {
        if (!session.rwPaused && Math.random() < 0.3) {
          session.rwPaused = true;
          session.rwNextDecisionAt = now + RW_PAUSE_MIN_MS + Math.random() * (RW_PAUSE_MAX_MS - RW_PAUSE_MIN_MS);
        } else if (session.rwPaused) {
          session.rwPaused = false;
          if (Math.random() < 0.5) session.direction = -session.direction;
          setRandomSpeed(session);
          scheduleNextRwDecision(session);
        } else {
          session.direction = -session.direction;
          setRandomSpeed(session);
          scheduleNextRwDecision(session);
        }
      }
      if (!session.rwPaused) {
        session.posX += session.direction * session.speed * dt;
        if (session.posX <= minX) {
          session.posX = minX;
          session.direction = 1;
          setRandomSpeed(session);
          scheduleNextRwDecision(session);
        } else if (session.posX >= maxX) {
          session.posX = maxX;
          session.direction = -1;
          setRandomSpeed(session);
          scheduleNextRwDecision(session);
        }
        walkingNow = true;
      } else {
        walkingNow = false;
      }
    }
  }

  // Apply position to window (round + only when changed).
  const [curX, curY] = win.getPosition();
  const nx = Math.round(session.posX);
  const ny = Math.round(session.posY);
  if (nx !== curX || ny !== curY) {
    session.internalMoveLock = true;
    try {
      win.setPosition(nx, ny);
    } finally {
      session.internalMoveLock = false;
    }
  }

  sendMovement(session, walkingNow, session.direction === -1 ? 'left' : 'right');
}

function startMovementLoopIfNeeded() {
  if (moveTimer) return;
  if (mascotsHiddenByUser) return;
  // Re-sync each session's cached position before the loop resumes, e.g.
  // after a Reset Position while hidden.
  for (const s of sessions.values()) {
    syncPositionFromWindow(s);
    s.rwNextDecisionAt = 0;
    s.rwPaused = false;
  }
  lastTickAt = 0;
  moveTimer = setInterval(tickAllSessions, MOVE_TICK_MS);
}

function stopMovementLoop() {
  if (moveTimer) {
    clearInterval(moveTimer);
    moveTimer = null;
  }
  for (const s of sessions.values()) {
    sendMovement(s, false, s.direction === -1 ? 'left' : 'right');
  }
}

// ---- Show / Hide all mascots ----

function isAnyMascotVisible() {
  if (mascotsHiddenByUser) return false;
  for (const s of sessions.values()) {
    if (s.window && !s.window.isDestroyed() && s.window.isVisible()) return true;
  }
  return false;
}

function showAllMascots() {
  mascotsHiddenByUser = false;
  for (const s of sessions.values()) {
    const win = s.window;
    if (!win || win.isDestroyed()) continue;
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
    if (clickThrough) win.setIgnoreMouseEvents(true, { forward: true });
    sendStateToSession(s);
    syncPositionFromWindow(s);
  }
  startMovementLoopIfNeeded();
  rebuildTrayMenu();
}

function hideAllMascots() {
  mascotsHiddenByUser = true;
  for (const s of sessions.values()) {
    const win = s.window;
    if (!win || win.isDestroyed()) continue;
    win.hide();
  }
  stopMovementLoop();
  rebuildTrayMenu();
}

function toggleAllMascots() {
  if (isAnyMascotVisible()) hideAllMascots();
  else showAllMascots();
}

// ---- Reset positions ----

function resetAllWindowPositions() {
  // Re-lay out every active session from the right edge, in insertion order.
  // __default__ sits at slot 0 (right-most), then non-default sessions.
  const { workArea } = screen.getPrimaryDisplay();
  const usable = workArea.width - WIN_MARGIN * 2;
  const perRow = Math.max(1, Math.floor(usable / SESSION_X_STRIDE));

  // Layout order: __default__ first, then others by lastActivity desc (newest first).
  const ordered = [];
  const def = getDefaultSession();
  if (def && !def.endLingerTimer) ordered.push(def);
  const others = [...sessions.values()].filter((s) => !s.isDefault && !s.endLingerTimer);
  others.sort((a, b) => b.lastActivity - a.lastActivity);
  for (const s of others) ordered.push(s);

  ordered.forEach((s, slot) => {
    const win = s.window;
    if (!win || win.isDestroyed()) return;
    const [w, h] = win.getSize();
    const row = Math.floor(slot / perRow);
    const col = slot % perRow;
    const nx = workArea.x + workArea.width - w - WIN_MARGIN - col * SESSION_X_STRIDE;
    const ny = workArea.y + workArea.height - h - WIN_MARGIN - row * (h + 8);
    s.internalMoveLock = true;
    try {
      win.setPosition(Math.round(nx), Math.round(ny));
    } finally {
      s.internalMoveLock = false;
    }
    s.posX = nx;
    s.posY = ny;
    s.targetY = computeFloorY(s);
  });
}

// ---- Click-through ----

function setClickThrough(enabled) {
  clickThrough = enabled;
  for (const s of sessions.values()) {
    const win = s.window;
    if (!win || win.isDestroyed()) continue;
    win.setIgnoreMouseEvents(enabled, { forward: true });
  }
  saveSettings();
  rebuildTrayMenu();
}

// ---- State updates ----

function setSessionState(session, state, message) {
  const prevState = session.state;
  session.state = state;
  session.message = typeof message === 'string' ? message : '';
  session.lastActivity = Date.now();

  if (session.doneResetTimer) {
    clearTimeout(session.doneResetTimer);
    session.doneResetTimer = null;
  }
  // Mirror the renderer's done -> idle auto-reset (~2.5s) so Tray emoji
  // follows back to idle even when the window is hidden.
  if (state === 'done') {
    session.doneResetTimer = setTimeout(() => {
      session.state = 'idle';
      session.message = '';
      sendStateToSession(session);
      updateTrayForAggregate();
    }, 2500);
  }

  // In 'idle only' mode, transitioning into a non-idle state stops the walk
  // immediately for this session.
  if (movementWhen === 'idle' && prevState !== state && state !== 'idle') {
    sendMovement(session, false, session.direction === -1 ? 'left' : 'right');
  }

  sendStateToSession(session);
  updateTrayForAggregate();
}

// ---- Tray ----

function buildTrayIcon() {
  const img = nativeImage.createEmpty();
  return img;
}

function aggregateState() {
  // Pick the highest-priority state across all active (non-lingering) sessions.
  // If sessions is empty, return 'idle'.
  let best = 'idle';
  let bestRank = STATE_PRIORITY.indexOf(best);
  for (const s of sessions.values()) {
    if (s.endLingerTimer) continue;
    const rank = STATE_PRIORITY.indexOf(s.state);
    if (rank >= 0 && rank < bestRank) {
      bestRank = rank;
      best = s.state;
    }
  }
  return best;
}

function updateTrayForAggregate() {
  if (!tray) return;
  const agg = aggregateState();
  const emoji = STATE_EMOJI[agg] || STATE_EMOJI.idle;
  // Count active sessions for the title suffix.
  const activeCount = countActiveSessions();
  const title = activeCount > 1 ? `${emoji}×${activeCount}` : emoji;
  tray.setTitle(title);
  const tip = activeCount === 1
    ? `gaya · ${agg}`
    : `gaya · ${activeCount} sessions · ${agg}`;
  tray.setToolTip(tip);
}

function switchPack(id) {
  if (!availablePacks.find((p) => p.id === id)) return;
  activePackId = id;
  for (const s of sessions.values()) {
    const win = s.window;
    if (!win || win.isDestroyed()) continue;
    win.webContents.send('switch-pack', id);
  }
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const visible = isAnyMascotVisible();
  const characterSubmenu = availablePacks.length
    ? availablePacks.map((p) => ({
        label: p.name,
        type: 'radio',
        checked: p.id === activePackId,
        click: () => switchPack(p.id),
      }))
    : [{ label: '(no packs found)', enabled: false }];

  const movementSubmenu = [
    {
      label: 'When',
      submenu: [
        { label: 'Always', type: 'radio', checked: movementWhen === 'always', click: () => setMovementWhen('always') },
        { label: 'Idle only', type: 'radio', checked: movementWhen === 'idle', click: () => setMovementWhen('idle') },
        { label: 'Off', type: 'radio', checked: movementWhen === 'off', click: () => setMovementWhen('off') },
      ],
    },
    {
      label: 'Style',
      submenu: [
        { label: 'Random walk', type: 'radio', checked: movementStyle === 'random', click: () => setMovementStyle('random') },
        { label: 'Pacing', type: 'radio', checked: movementStyle === 'pacing', click: () => setMovementStyle('pacing') },
      ],
    },
  ];

  // Sessions submenu: list all active sessions as info-only items.
  const sessionEntries = [];
  // __default__ first if present.
  const def = getDefaultSession();
  if (def && !def.endLingerTimer) {
    const label = def.displayName ? `${def.displayName} · ${def.state}` : `(default) · ${def.state}`;
    sessionEntries.push({ label, enabled: false });
  }
  // Then other active sessions, newest first.
  const others = [...sessions.values()].filter((s) => !s.isDefault && !s.endLingerTimer);
  others.sort((a, b) => b.lastActivity - a.lastActivity);
  for (const s of others) {
    const name = s.displayName || s.id.slice(0, 8);
    sessionEntries.push({ label: `${name} · ${s.state}`, enabled: false });
  }
  if (!sessionEntries.length) sessionEntries.push({ label: '(no sessions)', enabled: false });

  const menu = Menu.buildFromTemplate([
    {
      label: visible ? 'Hide Mascots' : 'Show Mascots',
      click: () => toggleAllMascots(),
    },
    { type: 'separator' },
    { label: 'Sessions', submenu: sessionEntries },
    { type: 'separator' },
    { label: `gaya (port ${boundPort ?? '—'})`, enabled: false },
    { type: 'separator' },
    { label: 'Character', submenu: characterSubmenu },
    { label: 'Movement', submenu: movementSubmenu },
    { label: 'Reset Position', click: () => resetAllWindowPositions() },
    {
      label: `Click-through: ${clickThrough ? 'ON' : 'OFF'}`,
      click: () => setClickThrough(!clickThrough),
    },
    { type: 'separator' },
    {
      label: 'Toggle DevTools',
      click: () => {
        const target = getDefaultSession();
        if (!target || !target.window || target.window.isDestroyed()) return;
        const wc = target.window.webContents;
        if (wc.isDevToolsOpened()) wc.closeDevTools();
        else wc.openDevTools({ mode: 'detach' });
      },
    },
    { label: 'Quit', click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  tray = new Tray(buildTrayIcon());
  updateTrayForAggregate();
  rebuildTrayMenu();
}

// ---- Movement settings (apply to all sessions via shared state) ----

function setMovementWhen(value) {
  if (!VALID_MOVEMENT_WHEN.has(value)) return;
  movementWhen = value;
  saveSettings();
  for (const s of sessions.values()) {
    s.rwNextDecisionAt = 0;
    s.rwPaused = false;
  }
  rebuildTrayMenu();
}

function setMovementStyle(value) {
  if (!VALID_MOVEMENT_STYLE.has(value)) return;
  movementStyle = value;
  saveSettings();
  for (const s of sessions.values()) {
    s.rwNextDecisionAt = 0;
    s.rwPaused = false;
  }
  rebuildTrayMenu();
}

// ---- HTTP server ----

function startHttpServer() {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > PORT_END) {
        reject(new Error(`No free port in range ${PORT_START}-${PORT_END}`));
        return;
      }
      const server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, sessions: countActiveSessions() }));
          return;
        }
        if (req.method === 'POST' && req.url === '/state') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; if (body.length > 64 * 1024) req.destroy(); });
          req.on('end', () => {
            let parsed;
            try { parsed = JSON.parse(body || '{}'); } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
              return;
            }
            const state = parsed && parsed.state;
            if (!state || !VALID_STATES.has(state)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'invalid state' }));
              return;
            }
            const message = typeof parsed.message === 'string' ? parsed.message : '';
            const rawSessionId = typeof parsed.session_id === 'string' && parsed.session_id.trim()
              ? parsed.session_id.trim()
              : DEFAULT_SESSION_ID;
            const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : '';

            const isSessionEnd = !!parsed.session_end || parsed.event === 'SessionEnd';

            const session = ensureSession(rawSessionId, cwd);

            if (isSessionEnd) {
              scheduleSessionEnd(session);
            } else {
              setSessionState(session, state, message);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, sessionId: rawSessionId }));
          });
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not found' }));
      });

      server.once('error', (err) => {
        if (err && err.code === 'EADDRINUSE') {
          tryPort(port + 1);
        } else {
          reject(err);
        }
      });
      server.listen(port, '127.0.0.1', () => {
        httpServer = server;
        boundPort = port;
        resolve(port);
      });
    };
    tryPort(PORT_START);
  });
}

// ---- App lifecycle ----

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }
  loadSettings();
  availablePacks = discoverPacks();
  activePackId = pickDefaultPack(availablePacks);
  createTray();

  // Always create the default session so single-curl tests still work.
  const def = createSession(DEFAULT_SESSION_ID, '');
  sessions.set(DEFAULT_SESSION_ID, def);

  // Start the movement loop after the default window is shown.
  if (def.window) {
    def.window.once('ready-to-show', () => {
      startMovementLoopIfNeeded();
    });
  } else {
    // Defensive: window creation failed; still start the loop (no-op).
    startMovementLoopIfNeeded();
  }

  startSessionReaper();

  try {
    const port = await startHttpServer();
    console.log(`[gaya] state server listening on http://127.0.0.1:${port}`);
    rebuildTrayMenu();
  } catch (err) {
    console.error('[gaya] failed to start HTTP server:', err);
  }
});

app.on('window-all-closed', (e) => {
  // Stay alive even with no visible windows; tray owns the lifecycle.
  e.preventDefault();
});

app.on('before-quit', () => {
  if (httpServer) {
    try { httpServer.close(); } catch {}
  }
  stopMovementLoop();
  stopSessionReaper();
  for (const s of sessions.values()) {
    if (s.doneResetTimer) clearTimeout(s.doneResetTimer);
    if (s.endLingerTimer) clearTimeout(s.endLingerTimer);
    if (s.dragEndTimer) clearTimeout(s.dragEndTimer);
    if (s.landedTimer) clearTimeout(s.landedTimer);
  }
});

// ---- IPC ----

// Renderer announces ready-to-paint. We respond with the session-info for that
// window (so the renderer can show its label) and then replay the current state.
ipcMain.on('renderer-ready', (event) => {
  const wc = event.sender;
  // Find the session whose window owns this webContents.
  let session = null;
  for (const s of sessions.values()) {
    if (s.window && !s.window.isDestroyed() && s.window.webContents.id === wc.id) {
      session = s;
      break;
    }
  }
  if (!session) return;
  session.readyForState = true;
  // Send session info so the renderer can show its label.
  sendSessionInfo(session);
  // Then send (or replay) the current state.
  sendStateToSession(session);
});

// Pack id must be a safe directory-name slug.
const PACK_ID_RE = /^[a-zA-Z0-9_-]+$/;
const VALID_RENDERERS = new Set(['svg', 'image', 'lottie']);

function resolvePackAsset(packDir, relPath) {
  if (typeof relPath !== 'string' || !relPath.length) return null;
  const absolute = path.resolve(packDir, relPath);
  const packDirWithSep = packDir.endsWith(path.sep) ? packDir : packDir + path.sep;
  if (absolute !== packDir && !absolute.startsWith(packDirWithSep)) {
    return null;
  }
  return absolute;
}

async function readOptionalCss(packDir, packId) {
  try {
    return await fs.promises.readFile(path.join(packDir, 'pack.css'), 'utf8');
  } catch (cssErr) {
    if (cssErr && cssErr.code !== 'ENOENT') {
      console.warn(`[gaya] pack '${packId}' pack.css read error, using empty css:`, cssErr.message);
    }
    return '';
  }
}

ipcMain.handle('pack:list', async () => {
  return availablePacks;
});

ipcMain.handle('pack:load', async (_event, id) => {
  try {
    if (typeof id !== 'string' || !PACK_ID_RE.test(id)) {
      throw new Error(`invalid pack id: ${JSON.stringify(id)}`);
    }
    const dir = path.join(CHARACTERS_DIR, id);
    const manifestRaw = await fs.promises.readFile(path.join(dir, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestRaw);
    if (!manifest || !manifest.id) {
      throw new Error(`pack '${id}' manifest missing id`);
    }

    const rendererType = manifest.renderer || 'svg';
    if (!VALID_RENDERERS.has(rendererType)) {
      throw new Error(`pack '${id}' has unknown renderer '${rendererType}'`);
    }

    const css = await readOptionalCss(dir, id);

    if (rendererType === 'svg') {
      const svg = await fs.promises.readFile(path.join(dir, 'mascot.svg'), 'utf8');
      return { id: manifest.id, manifest, svg, css };
    }

    if (rendererType === 'image') {
      const states = (manifest.states && typeof manifest.states === 'object') ? manifest.states : {};
      const fallbackState = manifest.fallbackState || 'idle';
      let sawAny = false;
      for (const [stateName, relPath] of Object.entries(states)) {
        const abs = resolvePackAsset(dir, relPath);
        if (!abs) {
          console.warn(`[gaya] pack '${id}' state '${stateName}' has unsafe path; ignoring`);
          continue;
        }
        try {
          await fs.promises.access(abs, fs.constants.R_OK);
          sawAny = true;
        } catch {
          console.warn(`[gaya] pack '${id}' state '${stateName}' file missing: ${relPath}`);
        }
      }
      if (!sawAny) {
        console.warn(`[gaya] pack '${id}' image renderer has no readable state assets`);
      }
      if (!states[fallbackState]) {
        console.warn(`[gaya] pack '${id}' image renderer fallbackState '${fallbackState}' not declared`);
      }
      return { id: manifest.id, manifest, css };
    }

    if (rendererType === 'lottie') {
      const states = (manifest.states && typeof manifest.states === 'object') ? manifest.states : {};
      const animations = {};
      for (const [stateName, relPath] of Object.entries(states)) {
        const abs = resolvePackAsset(dir, relPath);
        if (!abs) {
          console.warn(`[gaya] pack '${id}' lottie state '${stateName}' has unsafe path; ignoring`);
          continue;
        }
        try {
          const raw = await fs.promises.readFile(abs, 'utf8');
          animations[stateName] = JSON.parse(raw);
        } catch (animErr) {
          console.warn(`[gaya] pack '${id}' lottie state '${stateName}' load failed:`, animErr.message);
        }
      }
      return { id: manifest.id, manifest, css, animations };
    }

    throw new Error(`unhandled renderer type '${rendererType}'`);
  } catch (err) {
    console.error(`[gaya] pack:load failed for '${id}':`, err);
    throw err;
  }
});
