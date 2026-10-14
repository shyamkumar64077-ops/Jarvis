#!/bin/bash
export PATH="$HOME/.local/bin:/usr/local/py-utils/bin:$PATH"

pkill -f "hermes gateway" 2>/dev/null
pkill -f "hermes-mcp serve" 2>/dev/null
pkill -f "llmproxy_app" 2>/dev/null
sleep 3

if [ -f ~/keys.py ] && [ -f ~/llmproxy_app.py ]; then
    nohup python3 ~/llmproxy_app.py > ~/llmproxy.log 2>&1 &
    disown
fi

nohup hermes gateway run > ~/gateway.log 2>&1 &
disown

if [ -f ~/.hermes-mcp-oauth.txt ]; then
    source ~/.hermes-mcp-oauth.txt
    export HERMES_API_KEY="$(cat ~/.hermes-api-key 2>/dev/null)"
    export HERMES_BIN="$(which hermes)"
    nohup hermes-mcp serve > ~/mcp.log 2>&1 &
    disown
fi

echo "Startup complete at $(date)" >> ~/startup.log
