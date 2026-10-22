#!/bin/bash
export PATH="$HOME/.local/bin:/usr/local/py-utils/bin:/home/codespace/nvm/current/bin:$PATH"

pkill -f "hermes gateway" 2>/dev/null
pkill -f "hermes-mcp serve" 2>/dev/null
pkill -f "tsx src/index.ts" 2>/dev/null
sleep 3

# 1. FreeLLMAPI proxy on port 3001 (LLM provider for Hermes)
if [ -d ~/freellmapi/server ]; then
  (
    cd ~/freellmapi/server
    nohup npx tsx src/index.ts > ~/freellmapi-server.log 2>&1 &
    disown
  ) >/dev/null 2>&1
  # wait for the server to bind
  for i in $(seq 1 30); do
    curl -s -o /dev/null http://127.0.0.1:3001/v1/models && break
    sleep 2
  done
fi

# 2. Hermes gateway on port 8642
nohup hermes gateway run > ~/gateway.log 2>&1 &
disown

# 3. Hermes MCP server (optional, only if OAuth creds exist)
if [ -f ~/.hermes-mcp-oauth.txt ]; then
  source ~/.hermes-mcp-oauth.txt
  export HERMES_API_KEY="$(cat ~/.hermes-api-key 2>/dev/null)"
  export HERMES_BIN="$(which hermes)"
  nohup hermes-mcp serve > ~/mcp.log 2>&1 &
  disown
fi

echo "Startup complete at $(date)" >> ~/startup.log
