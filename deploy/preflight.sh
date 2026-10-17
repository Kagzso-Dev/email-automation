#!/usr/bin/env bash
# Read-only survey of a shared production server BEFORE deploying this app.
# Changes nothing: it only lists what is already running so the new app can
# pick a free port, a unique PM2 name, an unused domain and a new database.
#
#   bash deploy/preflight.sh            # optional: API_PORT=4100 bash deploy/preflight.sh

API_PORT="${API_PORT:-4100}"

echo "===== NODE / NPM ====="
node -v 2>/dev/null || echo "node not installed"
npm -v 2>/dev/null || echo "npm not installed"

echo
echo "===== PM2 PROCESSES (existing projects - do not touch) ====="
pm2 ls 2>/dev/null || echo "pm2 not installed"

echo
echo "===== LISTENING PORTS ====="
sudo ss -tlnp 2>/dev/null | awk 'NR==1 || /LISTEN/'

echo
echo "===== IS API_PORT=${API_PORT} FREE? ====="
if sudo ss -tln | awk '{print $4}' | grep -qE "[:.]${API_PORT}\$"; then
  echo "TAKEN - choose another API_PORT"
else
  echo "free"
fi

echo
echo "===== NGINX SITES + DOMAINS ALREADY IN USE ====="
ls -l /etc/nginx/sites-enabled/ 2>/dev/null
sudo nginx -T 2>/dev/null | grep -E '^\s*server_name' | sort -u

echo
echo "===== MYSQL ====="
mysql --version 2>/dev/null || echo "mysql client not installed"
echo "List databases yourself with:  sudo mysql -e 'SHOW DATABASES;'"

echo
echo "===== FIREWALL ====="
sudo ufw status 2>/dev/null || echo "ufw not available"

echo
echo "===== RESOURCES ====="
free -h
df -h /
