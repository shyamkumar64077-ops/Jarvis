#!/bin/bash
# 1. Kill old processes
pkill -9 -f 'hermes.*gateway' 2>/dev/null
pkill -9 -f 'omniroute' 2>/dev/null
pkill -9 -f 'super-proxy.js' 2>/dev/null

# 2. Start OmniRoute on port 20128
nohup omniroute > /tmp/omniroute.log 2>&1 < /dev/null &
sleep 10

# 3. Start Hermes Gateway
export API_SERVER_ENABLED=true
export API_SERVER_HOST=0.0.0.0
export API_SERVER_PORT=8642
export API_SERVER_KEY=super_secret_hermes_key_2026
/home/codespace/.python/current/bin/python3 -m pip install python-telegram-bot > /dev/null 2>&1
setsid /home/codespace/.python/current/bin/hermes -p default gateway run > /tmp/hermes-gw.log 2>&1 < /dev/null &

# 4. Telegram Notification
(
  sleep 10
  TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' ~/.hermes/.env | cut -d'=' -f2-)
  if [ -n $TOKEN ]; then
    curl -s -X POST https://api.telegram.org/bot$TOKEN/sendMessage -d chat_id=8672579935 -d text=⚡ Online boss! OmniRoute and Cloud Hermes are awake. 🚀
  fi
) &
