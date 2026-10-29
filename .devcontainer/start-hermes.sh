#!/bin/bash
pkill -9 -f 'hermes.*gateway'
export API_SERVER_ENABLED=true
export API_SERVER_HOST=0.0.0.0
export API_SERVER_PORT=8642
export API_SERVER_KEY=super_secret_hermes_key_2026
setsid /home/codespace/hermes-agent/venv/bin/hermes -p default gateway run > /tmp/hermes-gw.log 2>&1 < /dev/null &
sleep 5
