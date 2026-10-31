#!/bin/bash
pkill -9 -f 'hermes.*gateway' 2>/dev/null
export API_SERVER_ENABLED=true
export API_SERVER_HOST=0.0.0.0
export API_SERVER_PORT=8642
export API_SERVER_KEY=super_secret_hermes_key_2026
# Ensure Telegram dependency is installed
pip3 install python-telegram-bot > /dev/null 2>&1
setsid hermes -p default gateway run > /tmp/hermes-gw.log 2>&1 < /dev/null &
