#!/usr/bin/env bash
# BLACKOUT 주문관리 앱 서버 설치 스크립트 (Ubuntu 22.04 / 24.04)
#
# 사용법 (서버에서 root 또는 sudo 권한으로):
#   curl -fsSL https://raw.githubusercontent.com/ehdghks5486/LEE/claude/blackout-order-app/deploy/install.sh | sudo bash
#   또는 저장소를 받은 뒤:  sudo bash deploy/install.sh
#
# 환경변수로 바꿀 수 있는 값:
#   REPO_URL   저장소 주소 (비공개 저장소면 https://TOKEN@github.com/... 형식)
#   BRANCH     설치할 브랜치 (기본: claude/blackout-order-app)
#   DOMAIN     접속 도메인 (기본: <서버IP를 -로 연결>.sslip.io → 별도 DNS 없이 HTTPS 발급)
#   APP_DIR    설치 위치 (기본: /opt/blackout)
#
# 하는 일: Node.js 22 설치 → 앱 복제 → systemd 서비스 등록 → Caddy로 HTTPS 자동 발급 → 매일 03:30 DB 백업
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/ehdghks5486/LEE.git}"
BRANCH="${BRANCH:-claude/blackout-order-app}"
APP_DIR="${APP_DIR:-/opt/blackout}"
ENV_FILE=/etc/blackout/env
SERVICE_USER=blackout

if [[ $EUID -ne 0 ]]; then echo "root 권한이 필요합니다: sudo bash $0" >&2; exit 1; fi

echo "==> 1/6 기본 패키지"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null

echo "==> 2/6 Node.js 22"
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

echo "==> 3/6 앱 설치 ($APP_DIR, 브랜치 $BRANCH)"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  git -C "$APP_DIR" checkout --quiet "$BRANCH"
  git -C "$APP_DIR" reset --quiet --hard "origin/$BRANCH"
else
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund --silent
mkdir -p "$APP_DIR/data" "$APP_DIR/backups"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

echo "==> 4/6 환경 설정 ($ENV_FILE)"
PUBLIC_IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me || true)"
DOMAIN="${DOMAIN:-${PUBLIC_IP//./-}.sslip.io}"
mkdir -p /etc/blackout
if [[ ! -f "$ENV_FILE" ]]; then
  ADMIN_PW="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 12)"
  FACTORY_PW="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 12)"
  cat > "$ENV_FILE" <<ENV
# BLACKOUT 주문관리 환경변수. 수정 후: sudo systemctl restart blackout
PORT=3000
HOST=127.0.0.1
DB_PATH=$APP_DIR/data/blackout.db
SECURE_COOKIES=1
SEED_DEMO=0
# 최초 실행 시 생성되는 초기 비밀번호 (이후 앱에서 변경 가능)
ADMIN_PASSWORD=$ADMIN_PW
FACTORY_PASSWORD=$FACTORY_PW
# 네이버 커머스 API (발급 후 입력하고 재시작하면 자동으로 연동 시작)
NAVER_CLIENT_ID=
NAVER_CLIENT_SECRET=
# 연동 시험: SMARTSTORE_MODE=mock
SMARTSTORE_MODE=
SMARTSTORE_POLL_MINUTES=5
ENV
  chmod 600 "$ENV_FILE"
  NEW_ENV=1
else
  NEW_ENV=0
fi
echo "$DOMAIN" > /etc/blackout/domain

echo "==> 5/6 systemd 서비스"
cat > /etc/systemd/system/blackout.service <<UNIT
[Unit]
Description=BLACKOUT 주문관리 앱
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node --no-warnings=ExperimentalWarning server/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$APP_DIR/data $APP_DIR/backups

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --quiet blackout
systemctl restart blackout

# 매일 03:30 DB 백업 (14일 보관)
cat > /etc/cron.d/blackout-backup <<CRON
30 3 * * * $SERVICE_USER cd $APP_DIR && /usr/bin/node --no-warnings=ExperimentalWarning server/backup.js >> $APP_DIR/backups/backup.log 2>&1
CRON

echo "==> 6/6 Caddy (HTTPS 자동 발급: https://$DOMAIN)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}
CADDY
systemctl enable --quiet caddy
systemctl restart caddy

# 방화벽(ufw)이 켜져 있으면 80/443 허용
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi

sleep 2
if curl -fsS http://127.0.0.1:3000/api/health >/dev/null; then APP_OK="정상"; else APP_OK="확인 필요 (sudo journalctl -u blackout -n 50)"; fi

echo
echo "================================================================"
echo " 설치 완료"
echo "  접속 주소 : https://$DOMAIN"
echo "  앱 상태   : $APP_OK"
if [[ $NEW_ENV -eq 1 ]]; then
echo "  관리자    : admin / $ADMIN_PW"
echo "  공장      : factory / $FACTORY_PW"
echo "  (비밀번호는 $ENV_FILE 에도 적혀 있습니다. 로그인 후 앱에서 변경하세요.)"
fi
echo
echo "  네이버 API 호출 IP로 등록할 서버 IP : $PUBLIC_IP"
echo "  네이버 키 입력 : sudo nano $ENV_FILE  → NAVER_CLIENT_ID/SECRET 입력 → sudo systemctl restart blackout"
echo "  업데이트       : sudo bash $APP_DIR/deploy/install.sh"
echo "  로그           : sudo journalctl -u blackout -f"
echo "================================================================"
