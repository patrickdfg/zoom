// TURN 임시 인증정보를 발급하는 서버 주소를 지정합니다. 비밀키는 넣지 않습니다.
window.LINKCALL_TURN_ENDPOINT = '';
if (location.hostname === 'zoom.codemaru.kr') {
  window.LINKCALL_TURN_ENDPOINT = 'https://linkcall.egibynote105g.workers.dev/api/ice';
  window.LINKCALL_ACCESS_REQUIRED = true;
}
