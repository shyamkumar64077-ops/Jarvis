#!/usr/bin/env bash
# Idempotent startup for the Jarvis devcontainer.
#
# Contract:
#   - Running this script twice must NOT start a second copy of any service.
#   - A service is considered "already running" when its port answers HTTP.
#   - The script blocks until both services are ready, then exits 0.
#
# Ports:
#   3001  freellmapi    (OpenAI-compatible API + admin UI)
#   8642  hermes gateway (Telegram bot, dashboard, MCP)

set -uo pipefail

export PATH="$HOME/.local/bin:/usr/local/py-utils/bin:/home/codespace/nvm/current/bin:$PATH"

FLM_PORT=3001
GW_PORT=8642
FLM_DIR="${FLM_DIR:-$HOME/freellmapi}"
FLM_SERVER_DIR="$FLM_DIR/server"
LOG_DIR="$HOME"
READY_TIMEOUT="${READY_TIMEOUT:-120}"   # seconds to wait for each service
POLL_INTERVAL=2

log() { echo "[start-hermes] $(date '+%H:%M:%S') $*"; }

# --- helpers ---------------------------------------------------------------

# port_up <port> -> 0 when something is listening and answering on the port.
# Any HTTP status counts as "up" (401/404 mean the service is alive but
# rejecting the request; 000 means nothing is listening).
port_up() {
  local port="$1" code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${port}/" 2>/dev/null || true)
  [ -n "$code" ] && [ "$code" != "000" ]
}

# wait_ready <port> <label> [probe-path]
wait_ready() {
  local port="$1" label="$2" probe="${3:-/}" deadline waited=0
  while [ "$waited" -lt "$READY_TIMEOUT" ]; do
    if port_up "$port"; then
      log "$label ready on port $port (after ${waited}s)"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    waited=$((waited + POLL_INTERVAL))
  done
  log "ERROR: $label did not become ready on port $port within ${READY_TIMEOUT}s"
  return 1
}

# --- 1. freellmapi on 3001 -------------------------------------------------

if port_up "$FLM_PORT"; then
  log "freellmapi already listening on $FLM_PORT - skipping start"
else
  log "starting freellmapi on $FLM_PORT"
  if [ -d "$FLM_SERVER_DIR" ]; then
    (
      cd "$FLM_SERVER_DIR" || exit 1
      PORT="$FLM_PORT" nohup npx tsx src/index.ts > "$LOG_DIR/freellmapi-server.log" 2>&1 &
      disown
    ) >/dev/null 2>&1
  else
    log "ERROR: $FLM_SERVER_DIR not found - freellmapi not started"
  fi
fi

# --- 2. hermes gateway on 8642 --------------------------------------------

if port_up "$GW_PORT"; then
  log "hermes gateway already listening on $GW_PORT - skipping start"
else
  log "starting hermes gateway on $GW_PORT"
  if command -v hermes >/dev/null 2>&1; then
    nohup hermes gateway run > "$LOG_DIR/gateway.log" 2>&1 &
    disown
  else
    log "ERROR: hermes binary not on PATH - gateway not started"
  fi
fi

# --- 3. hermes MCP server (optional, only if OAuth creds exist) ------------

if [ -f "$HOME/.hermes-mcp-oauth.txt" ]; then
  if pgrep -f "mcp serve" >/dev/null 2>&1; then
    log "hermes-mcp already running - skipping start"
  else
    log "starting hermes-mcp"
    # `set -a` + source so OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET are EXPORTED;
    # plain source leaves them shell-local and hermes-mcp exits with
    # "config error: OAUTH_CLIENT_ID is required".
    #
    # `hermes mcp serve` is a STDIO server: it exits the moment stdin closes.
    # Redirect stdin from /dev/zero so it stays up, and setsid so it is not
    # killed with the devcontainer's postStart shell.
    (
      set -a
      # shellcheck disable=SC1091
      . "$HOME/.hermes-mcp-oauth.txt"
      set +a
      export HERMES_API_KEY="$(cat "$HOME/.hermes-api-key" 2>/dev/null)"
      export HERMES_BIN="$(command -v hermes)"
      setsid nohup hermes mcp serve > "$LOG_DIR/mcp.log" 2>&1 < /dev/zero &
    ) >/dev/null 2>&1
    sleep 3
    if pgrep -f "mcp serve" >/dev/null 2>&1; then
      log "hermes-mcp started"
    else
      log "WARNING: hermes-mcp exited immediately - see $LOG_DIR/mcp.log"
    fi
  fi
else
  log "no ~/.hermes-mcp-oauth.txt - skipping hermes-mcp"
fi

# --- health gates ----------------------------------------------------------

rc=0
wait_ready "$FLM_PORT" "freellmapi" "/v1/models" || rc=1
wait_ready "$GW_PORT" "hermes gateway" "/v1/health" || rc=1

if [ "$rc" -eq 0 ]; then
  log "startup complete - all services healthy"
else
  log "startup finished with errors (see ~/freellmapi-server.log, ~/gateway.log)"
fi

echo "Startup complete at $(date)" >> "$LOG_DIR/startup.log"
exit "$rc"
