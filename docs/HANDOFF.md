# 인수인계: BLACKOUT 주문관리 앱 (2026-10-27 기준)

이 문서는 다른 Claude 세션이 작업을 이어받을 때 읽는 현황 요약입니다. 개인정보·비밀번호·API 키는 적지 않습니다.

## 현재 상태

- 브랜치 `claude/blackout-order-app`에 1차(업체·관리자·공장 PWA)와 2차(네이버 스마트스토어 연동)가 구현되어 있습니다. master에는 아직 머지하지 않았습니다.
- 테스트: `npm test` 16건 통과. Playwright 브라우저 검증 완료.
- 가격 기본값: 단가 90,000원/㎡, 양개형·프리형 추가금 각 50,000원, 택배비 8,800원, 최소 주문면적 2㎡. 제작원가 60,000원/㎡는 예시 값.
- 네이버 커머스 API: 클라이언트·동기화 모듈은 완성, 실서버 호출은 실제 키로 미검증. 사용자가 커머스API센터에서 애플리케이션 등록 중 ("주문 판매자" API 그룹만 추가, 호출 IP는 서버 IP 등록 예정).
- AWS 계정 생성 완료, Lightsail 인스턴스는 아직 미생성.

## 지금 할 일 (순서대로)

1. **서버 생성**: 사용자 PC 세션의 내장 브라우저로 https://lightsail.aws.amazon.com 열기 (로그인은 사용자가 직접). `deploy/README.md` 1~4단계대로 서울 리전, Ubuntu 24.04, 월 $5, 이름 `blackout`, 고정 IP 생성·연결, 방화벽 HTTPS 추가.
2. **설치**: Lightsail 브라우저 SSH에서 아래 실행. 출력된 접속 주소·초기 비밀번호·서버 IP를 사용자에게 전달 (비밀번호는 채팅에 남기지 말 것).
   ```bash
   curl -fsSL https://raw.githubusercontent.com/ehdghks5486/LEE/claude/blackout-order-app/deploy/install.sh | sudo bash
   ```
3. **확인**: 접속 주소에서 admin 로그인 → 비밀번호 변경 → 업체·공장 계정 생성.
4. **네이버 연동**: 커머스API센터 애플리케이션에 서버 IP 등록 → 클라이언트 ID/시크릿을 서버의 `/etc/blackout/env`에 입력 → `sudo systemctl restart blackout` → 관리자 "스마트스토어" 탭에서 "지금 동기화"로 연결 확인. 오류 문구는 동기화 기록에 표시됨.
5. **첫 실주문 검증**: 수집 → 승인(발주확인 전송) → 공장 송장 등록(발송처리 전송) 순으로 한 건 확인. API 경로가 문서와 다르면 `server/smartstore/client.js`의 PATHS만 수정.
6. 안정화 후 `claude/blackout-order-app` → master 머지 (사용자 확인 후).

## 주의

- 저장소는 공개 상태. 비밀번호·API 키·주소 등 개인정보는 절대 커밋하지 말 것.
- 공장 계정에는 가격·업체 정보가 노출되면 안 됨 (`server/orders.js`의 FACTORY_FIELDS 참고).
- 스마트스토어 주문은 업체 단가가 아닌 네이버 결제금액을 매출로 기록함.

## 파일 안내

- `README.md` 기능·가격 계산·API 설명, `deploy/README.md` 서버 생성·운영, `deploy/install.sh` 설치 스크립트
- `server/` 백엔드, `public/` PWA 프론트엔드, `test/` 테스트
