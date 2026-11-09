#!/usr/bin/env bash
# Установка STRELA STARS на VPS (Ubuntu/Debian). Запуск: bash install.sh
set -e
cd "$(dirname "$0")"

echo "== Node.js =="
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  apt-get update && apt-get install -y curl ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "== cloudflared (бесплатный HTTPS без домена) =="
if ! command -v cloudflared >/dev/null; then
  ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m)
  case "$ARCH" in arm64|aarch64) F=cloudflared-linux-arm64;; *) F=cloudflared-linux-amd64;; esac
  curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/$F"
  chmod +x /usr/local/bin/cloudflared
fi
cloudflared --version

echo "== pm2 (держит бота запущенным 24/7) =="
command -v pm2 >/dev/null || npm install -g pm2

if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo "Создан файл .env — впиши туда BOT_TOKEN, WALLET_MNEMONIC и WALLET_ADDRESS:"
  echo "  nano .env"
  echo "потом снова: bash install.sh"
  exit 0
fi

pm2 delete strela-stars >/dev/null 2>&1 || true
pm2 start server.js --name strela-stars
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
echo
echo "Готово! Смотри лог: pm2 logs strela-stars"
