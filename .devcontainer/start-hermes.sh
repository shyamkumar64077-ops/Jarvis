#!/bin/bash
pkill -9 -f 'hermes.*gateway' 2>/dev/null
pkill -9 -f 'super-proxy.js' 2>/dev/null

# 1. Start Cloud Proxy (if needed)
if [ -d /home/codespace/cloud-proxy ]; then
  cd /home/codespace/cloud-proxy
  nohup node super-proxy.js > /tmp/cloud-proxy.log 2>&1 < /dev/null &
fi

# 2. Start Hermes Gateway
export API_SERVER_ENABLED=true
export API_SERVER_HOST=0.0.0.0
export API_SERVER_PORT=8642
export API_SERVER_KEY=super_secret_hermes_key_2026
setsid /home/codespace/.python/current/bin/hermes -p default gateway run > /tmp/hermes-gw.log 2>&1 < /dev/null &

# 3. Send Telegram Boot Notification
(
  sleep 12
  curl -s -X POST "https://api.telegram.org/bot8984588860:AAFNGf0TxNTHsGPd8NDim3S-XvSxQUvoqcs/sendMessage" -d "chat_id=8672579935" -d "text=⚡ Online boss! Cloud Hermes is fully awake and connected. 🚀"
) &
