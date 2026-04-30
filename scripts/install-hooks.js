#!/usr/bin/env node
/*
 * install-hooks.js
 *
 * Merge gaya's Claude Code hook entries into ~/.claude/settings.json.
 *
 * Usage:
 *   node scripts/install-hooks.js              # install (idempotent)
 *   node scripts/install-hooks.js --uninstall  # remove only our entries
 *   node scripts/install-hooks.js --dry-run    # show diff, write nothing
 *
 * The script is dependency-free (Node stdlib only). It backs up the
 * existing settings.json before any write, performs an atomic
 * rename, and never touches hook entries that aren't ours.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// --- constants ---------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOKS_DIR = path.join(REPO_ROOT, 'hooks');
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// Event -> { script, matcher? }
// Events without a matcher omit the key entirely (Claude Code's convention
// for events that don't take tool-name matchers).
const HOOK_SPECS = [
  { event: 'UserPromptSubmit', script: 'on-user-prompt-submit.sh' },
  { event: 'PreToolUse', script: 'on-pre-tool-use.sh', matcher: '*' },
  { event: 'PostToolUse', script: 'on-post-tool-use.sh', matcher: '*' },
  { event: 'Notification', script: 'on-notification.sh' },
  { event: 'Stop', script: 'on-stop.sh' },
  { event: 'SessionStart', script: 'on-session-start.sh' },
  { event: 'SessionEnd', script: 'on-session-end.sh' },
];

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

// --- helpers -----------------------------------------------------------

function parseArgs(argv) {
  const flags = { uninstall: false, dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === '--uninstall') flags.uninstall = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`${C.red}Unknown argument: ${a}${C.reset}`);
      printHelp();
      process.exit(2);
    }
  }
  return flags;
}

function printHelp() {
  console.log(`Usage: node scripts/install-hooks.js [--uninstall] [--dry-run]

  (no flags)   Install gaya hooks into ~/.claude/settings.json
  --uninstall  Remove gaya hooks from ~/.claude/settings.json
  --dry-run    Show changes without writing
  -h, --help   Show this help`);
}

function readSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return { settings: {}, existed: false };
  }
  const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
  if (raw.trim() === '') return { settings: {}, existed: true };
  try {
    return { settings: JSON.parse(raw), existed: true };
  } catch (err) {
    console.error(
      `${C.red}Failed to parse ${SETTINGS_PATH}:${C.reset}\n  ${err.message}\n` +
      `${C.yellow}Aborting. Fix the JSON manually and retry.${C.reset}`,
    );
    process.exit(1);
  }
}

function backupSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return null;
  const ts = formatTimestamp(new Date());
  const dest = `${SETTINGS_PATH}.backup-${ts}`;
  fs.copyFileSync(SETTINGS_PATH, dest);
  return dest;
}

function formatTimestamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  // Use PID + random in tmp name to avoid collisions across concurrent runs.
  const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

// chmod +x lazily — checkout from Windows / archive can drop the bit.
function ensureExecutable(absPath) {
  try {
    const st = fs.statSync(absPath);
    const wantBits = 0o111; // any execute bit
    if ((st.mode & wantBits) !== wantBits) {
      fs.chmodSync(absPath, st.mode | 0o755);
      return true;
    }
  } catch (_) {
    // Missing file is reported elsewhere.
  }
  return false;
}

function ourCommandPaths() {
  return new Set(HOOK_SPECS.map((s) => path.join(HOOKS_DIR, s.script)));
}

// --- install -----------------------------------------------------------

function install(flags) {
  const { settings, existed } = readSettings();
  const before = JSON.parse(JSON.stringify(settings));

  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }

  const added = [];
  const skipped = [];
  const chmodded = [];

  for (const spec of HOOK_SPECS) {
    const cmdPath = path.join(HOOKS_DIR, spec.script);
    if (!fs.existsSync(cmdPath)) {
      console.error(`${C.yellow}warn: hook script not found: ${cmdPath}${C.reset}`);
    } else if (ensureExecutable(cmdPath)) {
      chmodded.push(cmdPath);
    }

    const list = Array.isArray(settings.hooks[spec.event])
      ? settings.hooks[spec.event]
      : [];

    // Idempotency: same matcher + same absolute command => already installed.
    const matcherKey = spec.matcher ?? null;
    const existingIdx = list.findIndex((entry) => {
      const eMatcher = entry && Object.prototype.hasOwnProperty.call(entry, 'matcher')
        ? entry.matcher
        : null;
      if (eMatcher !== matcherKey) return false;
      const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
      return hooks.some((h) => h && h.type === 'command' && h.command === cmdPath);
    });

    if (existingIdx !== -1) {
      skipped.push({ event: spec.event, command: cmdPath });
      continue;
    }

    // Build entry with matcher first for readability (key insertion order
    // is preserved by JSON.stringify).
    const newEntry = {};
    if (spec.matcher !== undefined) newEntry.matcher = spec.matcher;
    newEntry.hooks = [{ type: 'command', command: cmdPath }];

    list.push(newEntry);
    settings.hooks[spec.event] = list;
    added.push({ event: spec.event, command: cmdPath });
  }

  const nextJson = JSON.stringify(settings, null, 2) + '\n';
  const prevJson = JSON.stringify(before, null, 2) + '\n';

  if (flags.dryRun) {
    console.log(`${C.bold}[dry-run] no changes will be written${C.reset}`);
    printSummary({ added, skipped, chmodded, backupPath: null });
    printDiffPreview(prevJson, nextJson);
    return;
  }

  if (added.length === 0) {
    console.log(`${C.green}All gaya hooks already installed. Nothing to do.${C.reset}`);
    if (chmodded.length) {
      console.log(`${C.dim}chmod +x applied to ${chmodded.length} script(s).${C.reset}`);
    }
    printQuickCheck();
    return;
  }

  const backupPath = existed ? backupSettings() : null;
  atomicWrite(SETTINGS_PATH, nextJson);

  console.log(`${C.green}${C.bold}Installed gaya hooks.${C.reset}`);
  printSummary({ added, skipped, chmodded, backupPath });
  printQuickCheck();
}

// --- uninstall ---------------------------------------------------------

function uninstall(flags) {
  const { settings, existed } = readSettings();
  const before = JSON.parse(JSON.stringify(settings));

  if (!existed) {
    console.log(`${C.yellow}No settings.json at ${SETTINGS_PATH} — nothing to uninstall.${C.reset}`);
    return;
  }
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    console.log(`${C.yellow}No "hooks" key in settings — nothing to uninstall.${C.reset}`);
    return;
  }

  const ours = ourCommandPaths();
  const removed = [];

  for (const event of Object.keys(settings.hooks)) {
    const list = settings.hooks[event];
    if (!Array.isArray(list)) continue;

    const kept = [];
    for (const entry of list) {
      if (!entry || !Array.isArray(entry.hooks)) {
        kept.push(entry);
        continue;
      }
      const filteredHooks = entry.hooks.filter((h) => {
        const isOurs = h && h.type === 'command' && ours.has(h.command);
        if (isOurs) removed.push({ event, command: h.command });
        return !isOurs;
      });

      // Drop the entry if we emptied its hooks array.
      if (filteredHooks.length > 0) {
        kept.push({ ...entry, hooks: filteredHooks });
      }
    }

    if (kept.length === 0) {
      delete settings.hooks[event];
    } else {
      settings.hooks[event] = kept;
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  const nextJson = JSON.stringify(settings, null, 2) + '\n';
  const prevJson = JSON.stringify(before, null, 2) + '\n';

  if (flags.dryRun) {
    console.log(`${C.bold}[dry-run] no changes will be written${C.reset}`);
    console.log(`${C.cyan}Would remove ${removed.length} gaya hook entr${removed.length === 1 ? 'y' : 'ies'}.${C.reset}`);
    for (const r of removed) console.log(`  ${C.dim}- ${r.event}: ${r.command}${C.reset}`);
    printDiffPreview(prevJson, nextJson);
    return;
  }

  if (removed.length === 0) {
    console.log(`${C.green}No gaya hook entries found. Nothing to do.${C.reset}`);
    return;
  }

  const backupPath = backupSettings();
  atomicWrite(SETTINGS_PATH, nextJson);

  console.log(`${C.green}${C.bold}Removed gaya hooks.${C.reset}`);
  console.log(`${C.cyan}Backup:${C.reset} ${backupPath}`);
  console.log(`${C.cyan}Removed entries:${C.reset} ${removed.length}`);
  for (const r of removed) console.log(`  ${C.dim}- ${r.event}: ${r.command}${C.reset}`);
}

// --- output helpers ----------------------------------------------------

function printSummary({ added, skipped, chmodded, backupPath }) {
  if (backupPath) console.log(`${C.cyan}Backup:${C.reset} ${backupPath}`);
  console.log(`${C.cyan}Added:${C.reset} ${added.length}`);
  for (const a of added) console.log(`  ${C.green}+ ${a.event}${C.reset}  ${a.command}`);
  console.log(`${C.cyan}Skipped (already present):${C.reset} ${skipped.length}`);
  for (const s of skipped) console.log(`  ${C.dim}= ${s.event}  ${s.command}${C.reset}`);
  if (chmodded.length) {
    console.log(`${C.cyan}chmod +x applied:${C.reset} ${chmodded.length}`);
    for (const p of chmodded) console.log(`  ${C.dim}* ${p}${C.reset}`);
  }
}

function printQuickCheck() {
  console.log('');
  console.log(`${C.bold}Verify gaya is reachable:${C.reset}`);
  console.log(`  curl http://127.0.0.1:39999/health`);
}

// Minimal line-level diff: useful enough for dry-run preview without pulling
// in any dependency.
function printDiffPreview(prev, next) {
  if (prev === next) {
    console.log(`${C.dim}(no JSON changes)${C.reset}`);
    return;
  }
  console.log('');
  console.log(`${C.bold}--- ~/.claude/settings.json (before)${C.reset}`);
  console.log(`${C.bold}+++ ~/.claude/settings.json (after)${C.reset}`);
  const a = prev.split('\n');
  const b = next.split('\n');
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const la = a[i];
    const lb = b[i];
    if (la === lb) continue;
    if (la !== undefined) console.log(`${C.red}- ${la}${C.reset}`);
    if (lb !== undefined) console.log(`${C.green}+ ${lb}${C.reset}`);
  }
}

// --- main --------------------------------------------------------------

function main() {
  const flags = parseArgs(process.argv);
  if (flags.uninstall) uninstall(flags);
  else install(flags);
}

main();
