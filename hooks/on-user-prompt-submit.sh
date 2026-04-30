#!/usr/bin/env bash
# Claude Code UserPromptSubmit hook -> notify desktopi that the agent is thinking.
# Must always exit 0 so Claude Code is never blocked by this script.

INPUT=$(cat)

PAYLOAD=$(printf '%s' "$INPUT" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  out={"state":"thinking"}
  if d.get("session_id"): out["session_id"]=d["session_id"]
  if d.get("cwd"): out["cwd"]=d["cwd"]
  print(json.dumps(out))
except Exception:
  print("{\"state\":\"thinking\"}")
' 2>/dev/null || echo '{"state":"thinking"}')

curl -s -X POST -H 'Content-Type: application/json' \
  -d "$PAYLOAD" \
  http://127.0.0.1:39999/state --max-time 1 >/dev/null 2>&1 || true
exit 0
