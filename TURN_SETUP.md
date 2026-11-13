<!-- TURN 서버 설정과 비밀키 보호 방법을 설명하는 프로젝트 안내서입니다. -->
# 카드 없이 무료로 운영하는 구성

Cloudflare Workers Free에서 사이트와 연결정보 API를 제공하고, Metered 무료 TURN을 직접 연결이 막힌 경우의 중계로 사용합니다. PeerJS의 무료 공개 서버가 방 찾기와 연결 협상을 담당합니다. Netlify는 사용하지 않습니다. Cloudflare Realtime TURN은 카드 등록을 요구하므로 활성화하지 않았습니다.

## 배포

`wrangler.jsonc`와 `worker.mjs`가 배포 설정입니다. `node build.mjs`는 브라우저용 파일 5개만 `dist/`에 복사합니다. 배포 명령은 `npx wrangler@4.161.0 deploy`이며 Git 연동에서도 같은 명령을 사용합니다.

Worker의 Settings → Variables and Secrets에 다음을 등록합니다.

- `METERED_APP_NAME`: Metered Developers 화면 도메인의 `.metered.live` 앞부분
- `METERED_TURN_API_KEY`: TURN Credentials → linkcall → Get credential → Show API Key의 **해당 중계 인증정보 전용 키**. Secret으로 저장합니다. 계정 전체를 관리하는 Developers의 Secret Key는 쓰지 않습니다.
- `CLASSROOM_PASSWORD`: 선생님과 학생만 아는 충분히 긴 중계 접속 비밀번호. Secret으로 저장합니다.

Cloudflare 주소의 `/turn-config.js`는 같은 사이트의 `/api/ice`를 지정합니다. `/api/ice`는 비밀번호를 확인한 뒤 Metered에서 ICE 서버 배열을 받아 `{ "iceServers": [...] }`로 반환합니다. API 키는 GitHub나 브라우저에 보내지 않습니다. 브라우저에는 통화에 필요한 TURN 사용자명·비밀번호만 전달합니다.

이 구성은 Metered의 기존 인증정보를 읽는 방식이며, 통화마다 만료되는 새 인증정보를 만드는 방식은 아닙니다. 접속 비밀번호는 중계 연결정보 요청을 보호하며, 개별 학생의 신원을 확인하거나 PeerJS 방 입장을 서버에서 인증하지는 않습니다. 방 코드와 TURN 인증정보를 받은 사람의 재사용을 완전히 막지는 못하므로 초대 링크·비밀번호는 수업 상대에게만 전달합니다. 유출 시 Metered에서 해당 Credential을 비활성화하고 새 키로 교체합니다.

인증 실패는 입장을 중단합니다. Metered 응답 실패·시간 초과·잘못된 배열이면 비밀번호 확인 후 STUN 직접 연결을 시도하고 화면에 제한을 표시합니다. 중계 인증정보를 받았더라도 무료 용량 소진으로 실제 TURN 연결이 거부될 수 있습니다. 그 경우 직접 연결이 가능한 회선에서는 통화할 수 있지만, 중계가 꼭 필요한 회선에서는 연결되지 않습니다.

IP별 발급 요청은 Cloudflare 위치별 분당 10회로 제한합니다. 이는 월간 트래픽 한도나 사용자 인증을 대신하지 않습니다.

## 무료 한도와 비용

2026-11-13 실제 Metered 계정에서 확인한 플랜은 **TURN Trial 월 500MB, $0/월**입니다. 들어오는 트래픽과 나가는 트래픽을 모두 합산합니다. 대시보드는 무료 한도 초과 시 다음 갱신일까지 TURN이 중지된다고 안내합니다. 카드 없이 사용하며 Auto-reload는 Off입니다. 가입 크레딧 $30은 월간 TURN 무료 용량 증가로 간주하지 않습니다.

직접 연결된 영상·음성·파일은 Metered 사용량을 소모하지 않습니다. 중계가 필요한 통화와 파일만 용량을 씁니다. 표준 화질 목표치(각 방향 영상 1.2Mbps + 음성 40kbps)로 두 사람이 계속 보내면 500MB는 대략 7~14분 수준입니다. 한쪽 또는 양쪽 중계 여부와 실제 화질·움직임·프로토콜 부가량에 따라 달라지며 보장 수업 시간이 아닙니다. 긴 수업에서는 데이터 절약 화질이나 카메라 끄기가 도움이 됩니다. 무료로 모든 회선에서 무제한 중계를 보장할 수는 없습니다.

Workers 정적 파일 요청은 무료이고 연결정보 API는 Workers Free의 하루 100,000요청 한도를 사용합니다. 이 구성은 Workers 유료 전환·Cloudflare Realtime 구독·Metered 유료 플랜·자동 충전을 요구하지 않습니다. 공급자 가격과 한도는 변경될 수 있으므로 실제 계정 화면을 확인합니다.

## 확인 방법

1. 두 브라우저에서 방 만들기·입장, 영상, 채팅, 파일 수신을 확인합니다.
2. 영상 연결만 끊어 자동으로 복구되는지 확인합니다.
3. 시험에서만 `iceTransportPolicy: 'relay'`를 강제해 통화와 선택된 후보의 `relay` 여부를 확인합니다. 운영에서는 직접 연결을 우선하도록 기본 `all`을 유지합니다.
4. 실제 수업 전 서로 다른 인터넷 회선의 두 기기에서 카메라·마이크·화면 공유를 확인합니다.

GitHub Pages의 정적 `turn-config.js`는 비어 있어 그 주소에서는 기존 STUN 직접 연결만 사용합니다. TURN 지원 주소는 Cloudflare 배포 주소입니다. PeerJS 공개 서버가 중단되면 TURN이 있어도 새 통화를 시작할 수 없습니다.

공식 근거: [Metered 가격](https://www.metered.ca/pricing/), [인증정보 조회 API](https://www.metered.ca/docs/turn-rest-api/get-credential/), [Workers 가격](https://developers.cloudflare.com/workers/platform/pricing/), [PeerJS](https://peerjs.com/client/api/peer)
