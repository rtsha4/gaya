#!/usr/bin/env bash
# Claude Code SessionStart hook -> gaya "idle".
# This is the *first* event for a new session, so it's also the trigger that
# tells gaya to spin up a fresh mascot window for that session.

INPUT=$(cat)

PAYLOAD=$(printf '%s' "$INPUT" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  out={"state":"idle"}
  if d.get("session_id"): out["session_id"]=d["session_id"]
  if d.get("cwd"): out["cwd"]=d["cwd"]
  print(json.dumps(out))
except Exception:
  print("{\"state\":\"idle\"}")
' 2>/dev/null || echo '{"state":"idle"}')

curl -s -X POST -H 'Content-Type: application/json' \
  -d "$PAYLOAD" \
  http://127.0.0.1:39999/state --max-time 1 >/dev/null 2>&1 || true
exit 0
