<!-- TURN 서버 설정과 비밀키 보호 방법을 설명하는 프로젝트 안내서입니다. -->
# TURN 서버 연결 방법

링크콜은 현재 STUN으로 직접 연결을 먼저 시도합니다. 직접 연결이 막힌 두 인터넷 환경 사이를 중계하려면 TURN 서버가 필요합니다. TURN은 영상 저장 서버나 PeerJS 시그널링 서버와 다릅니다.

## 추천: Cloudflare Realtime TURN

1. https://dash.cloudflare.com/ 에 가입합니다.
2. Cloudflare Dashboard의 Realtime TURN에서 TURN 키를 생성합니다.
3. TURN 키의 **ID와 API 토큰은 브라우저나 GitHub에 공개하지 않습니다.**
4. Cloudflare Worker 또는 별도 백엔드가 다음 Cloudflare API에 **서버에서만** 요청하도록 합니다.
   - POST https://rtc.live.cloudflare.com/v1/turn/keys/{TURN_KEY_ID}/credentials/generate-ice-servers
   - 인증: Authorization: Bearer {TURN_KEY_API_TOKEN}
   - JSON 본문: `{"ttl":86400}` (예: 24시간)
5. 백엔드는 응답의 `iceServers`를 앱에 반환합니다. 브라우저는 이 **임시** 인증정보만 전달받습니다.
6. 서비스 URL(HTTPS)을 `turn-config.js` 파일의 다음 항목에 입력합니다.

```js
// 단기 TURN 인증정보를 내려주는 서버의 공개 URL만 지정합니다.
window.LINKCALL_TURN_ENDPOINT = 'https://YOUR-SECURE-TURN-ENDPOINT.example/ice';
```

7. GitHub Pages를 새로 배포한 뒤 두 다른 인터넷 회선에서 서로 연결되는지 시험합니다.

## 엔드포인트 요구사항

- GET 요청에 응답하며 형태는 `{"iceServers":[{"urls":"stun:..."},{"urls":["turn:..."],"username":"임시값","credential":"임시값"}]}`입니다.
- 적절한 HTTPS/CORS 설정이 필요합니다.
- **중요:** 공개 페이지의 브라우저가 누구나 접근 가능한 발급 URL을 호출할 수 있습니다. **CORS 제한만으로 사용량 악용을 방지하지 못하므로** 운영 전 로그인 인증 또는 Turnstile·속도 제한 등을 결합해야 합니다.
- Cloudflare TURN 키와 API 토큰은 Worker Secret 또는 안전한 서버 환경변수로만 저장합니다.
- 발급되는 TURN 인증정보의 유효기간은 예상 통화 시간보다 길게 잡거나 갱신 기능을 구현해야 합니다.
- TURN이 동작하더라도 무료 PeerJS Cloud 시그널링 서버가 중단되면 새로운 통화 연결이 안 될 수 있습니다.

## 현 상태

앱은 `turn-config.js`가 빈 문자열인 동안 TURN을 사용하지 않습니다. GitHub Pages 정적 호스팅만으로는 TURN 임시 키 발급 서버를 대신할 수 없습니다. Cloudflare 계정과 서버 배포 절차가 끝나야 실제로 TURN이 작동합니다.

공식 문서

- https://developers.cloudflare.com/realtime/turn/
- https://developers.cloudflare.com/realtime/turn/generate-credentials/
- https://peerjs.com/client/api/peer
