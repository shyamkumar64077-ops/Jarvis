#!/bin/bash
pkill -9 -f 'hermes.*gateway' 2>/dev/null
pkill -9 -f 'omniroute' 2>/dev/null
pkill -9 -f 'super-proxy.js' 2>/dev/null

# 1. Start Custom Super Proxy
cd /home/codespace/cloud-proxy
nohup node super-proxy.js > /tmp/cloud-proxy.log 2>&1 < /dev/null &
sleep 3

# 2. Start Hermes Gateway
export API_SERVER_ENABLED=true
export API_SERVER_HOST=0.0.0.0
export API_SERVER_PORT=8642
export API_SERVER_KEY=super_secret_hermes_key_2026
/home/codespace/hermes-agent/venv/bin/python3 -m pip install python-telegram-bot > /dev/null 2>&1
setsid /home/codespace/hermes-agent/venv/bin/hermes -p default gateway run > /tmp/hermes-gw.log 2>&1 < /dev/null &

# 3. Send Telegram Notification
(
  sleep 10
  TOKEN=8984588860:AAFNGf0TxNTHsGPd8NDim3S-XvSxQUvoqcs
  if [ -n  ]; then
    curl -s -X POST https://api.telegram.org/bot/sendMessage -d chat_id=8672579935 -d text=⚡ Online boss! Custom Proxy and Cloud Hermes are awake. 🚀
  fi
) &
