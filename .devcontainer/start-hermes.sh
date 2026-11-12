#!/bin/bash
pkill -9 -f 'hermes.*gateway' 2>/dev/null
pkill -9 -f 'super-proxy.js' 2>/dev/null
sleep 2

if [ -d /home/codespace/cloud-proxy ]; then
  cd /home/codespace/cloud-proxy
  nohup node super-proxy.js > /tmp/cloud-proxy.log 2>&1 < /dev/null &
fi

HERMES_BIN="/home/codespace/.python/current/bin/hermes"
if [ ! -f "$HERMES_BIN" ]; then
    echo "Hermes binary missing. Reinstalling..."
    /home/codespace/.python/current/bin/python3 -m pip install hermes-agent
fi

export API_SERVER_ENABLED=true
export API_SERVER_HOST=0.0.0.0
export API_SERVER_PORT=8642
export API_SERVER_KEY=super_secret_hermes_key_2026
setsid "$HERMES_BIN" -p default gateway run > /tmp/hermes-gw.log 2>&1 < /dev/null &

(
  sleep 12
  curl -s -X POST "https://api.telegram.org/bot8984588860:AAFNGf0TxNTHsGPd8NDim3S-XvSxQUvoqcs/sendMessage" \
    -d "chat_id=8672579935" \
    -d "text=\xe2\x9a\xa1 Online boss! Cloud Hermes is fully awake and connected. \xf0\x9f\x9a\x80"
) &
