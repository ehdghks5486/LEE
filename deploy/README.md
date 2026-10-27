# 서버 배포 안내

앱을 24시간 운영하려면 고정 IP가 있는 리눅스 서버 한 대가 필요합니다. 아래는 AWS Lightsail(서울) 기준이며, 다른 클라우드(네이버 클라우드, Vultr, 가비아 등)도 "Ubuntu 서버 생성 → 고정 IP → 80/443 포트 열기 → 설치 명령 실행" 순서는 같습니다.

## 1. 서버 만들기 (AWS Lightsail, 약 10분)

1. https://lightsail.aws.amazon.com 접속 → AWS 계정 생성(카드 등록 필요) → 로그인.
2. **인스턴스 생성** 클릭.
   - 리전: **서울 (ap-northeast-2)**
   - 플랫폼: Linux/Unix, 블루프린트: **OS 전용 → Ubuntu 24.04 LTS**
   - 플랜: 가장 작은 것(월 $5, 1GB RAM)이면 충분합니다.
   - 이름: `blackout`
3. 생성 후 **네트워킹** 탭 → **고정 IP 생성** → 인스턴스에 연결. 이 IP가 네이버 API 호출 IP이자 접속 주소입니다.
4. 같은 네트워킹 탭 → **IPv4 방화벽**에 규칙 추가: HTTP(80), HTTPS(443). (SSH 22는 기본으로 열려 있음)

## 2. 앱 설치 (명령 한 줄)

1. Lightsail 인스턴스 화면에서 **"SSH를 사용하여 연결"** 버튼을 누르면 브라우저 안에 터미널이 열립니다.
2. 아래 한 줄을 붙여넣고 Enter. 3~5분 걸립니다.

```bash
curl -fsSL https://raw.githubusercontent.com/ehdghks5486/LEE/claude/blackout-order-app/deploy/install.sh | sudo bash
```

저장소가 비공개라면 GitHub에서 읽기 전용 토큰(Settings → Developer settings → Fine-grained token, Contents: Read)을 만든 뒤 이렇게 실행합니다.

```bash
curl -fsSL -H "Authorization: Bearer 토큰" https://raw.githubusercontent.com/ehdghks5486/LEE/claude/blackout-order-app/deploy/install.sh \
  | sudo REPO_URL=https://토큰@github.com/ehdghks5486/LEE.git bash
```

3. 끝나면 화면에 **접속 주소(https://…sslip.io)**, **관리자/공장 초기 비밀번호**, **네이버에 등록할 서버 IP**가 출력됩니다. 비밀번호는 바로 메모하세요.

설치 스크립트가 하는 일: Node.js 22 설치, 앱 복제, 부팅 시 자동 시작(systemd), HTTPS 인증서 자동 발급(Caddy), 매일 03:30 DB 백업(14일 보관).

## 3. 설치 후 할 일

| 할 일 | 방법 |
|---|---|
| 관리자 로그인 · 비밀번호 변경 | 접속 주소 → admin 로그인 → 상단 "비밀번호" |
| 업체·공장 계정 만들기 | 관리자 → 업체관리 / 계정관리 |
| 휴대폰에 설치 | 업체·공장이 접속 주소를 열고 "홈 화면에 추가" |
| 네이버 API 호출 IP 등록 | 커머스API센터 애플리케이션에 설치 화면에 나온 서버 IP 입력 |
| 네이버 키 입력 | `sudo nano /etc/blackout/env` → `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` 입력 → `sudo systemctl restart blackout` |
| 연결 확인 | 관리자 → 스마트스토어 탭 → "지금 동기화" |

## 4. 운영 명령

```bash
sudo systemctl status blackout        # 상태
sudo journalctl -u blackout -f        # 실시간 로그
sudo systemctl restart blackout       # 재시작 (환경변수 수정 후)
sudo bash /opt/blackout/deploy/install.sh   # 최신 코드로 업데이트
ls /opt/blackout/backups              # 백업 파일 (blackout-날짜.db)
```

복구: 백업 파일을 `/opt/blackout/data/blackout.db`로 복사한 뒤 재시작하면 됩니다.

## 5. 도메인을 쓰고 싶다면

기본 주소는 `https://<IP를 -로 연결>.sslip.io` 형식입니다(예: `https://3-35-10-20.sslip.io`). 별도 도메인이 있으면 DNS A 레코드를 서버 IP로 가리킨 뒤 아래처럼 다시 실행하면 그 도메인으로 인증서가 발급됩니다.

```bash
sudo DOMAIN=order.example.com bash /opt/blackout/deploy/install.sh
```

## 6. 이미 쓰는 서버에 같이 올릴 수 있나

가능 조건: Ubuntu/Debian 계열 리눅스이고, root(sudo) 접속이 되며, 80/443 포트를 이 앱이 쓸 수 있거나 다른 웹서버(nginx 등)가 있어 그 뒤로 붙일 수 있는 경우입니다. 이미 80/443을 다른 서비스가 쓰고 있다면 Caddy 설치 단계는 건너뛰고 기존 웹서버에서 `127.0.0.1:3000`으로 리버스 프록시만 추가하면 됩니다. 앱 빌더형 서비스나 PHP 전용 웹호스팅에는 올릴 수 없습니다.
