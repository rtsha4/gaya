#!/usr/bin/env bash
# Claude Code PreToolUse hook -> desktopi "working".
#
# Reads the hook event JSON from stdin (Claude Code passes session_id, cwd,
# transcript_path, tool_name, etc. as a single JSON object) and forwards
# session_id + cwd to desktopi so each session gets its own mascot.
#
# Notes:
# - We avoid `jq` (not always installed). `python3` ships with macOS.
# - All extraction is wrapped in `|| true` / `2>/dev/null` so a parse failure
#   never blocks Claude Code.
# - Final curl is `--max-time 1 || true` for the same reason.

INPUT=$(cat)

SESSION_ID=$(printf '%s' "$INPUT" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  print(d.get("session_id","") or "")
except Exception:
  print("")
' 2>/dev/null || echo "")

CWD=$(printf '%s' "$INPUT" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  print(d.get("cwd","") or "")
except Exception:
  print("")
' 2>/dev/null || echo "")

PAYLOAD=$(printf '%s' "$INPUT" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  out={"state":"working"}
  if d.get("session_id"): out["session_id"]=d["session_id"]
  if d.get("cwd"): out["cwd"]=d["cwd"]
  print(json.dumps(out))
except Exception:
  print("{\"state\":\"working\"}")
' 2>/dev/null || echo '{"state":"working"}')

curl -s -X POST -H 'Content-Type: application/json' \
  -d "$PAYLOAD" \
  http://127.0.0.1:39999/state --max-time 1 >/dev/null 2>&1 || true
exit 0
