// 정적 웹앱과 수업용 Metered TURN 연결정보 API입니다.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = { 'Cache-Control': 'no-store' };
    if (url.pathname === '/turn-config.js') {
      return new Response("window.LINKCALL_TURN_ENDPOINT = '/api/ice';\nwindow.LINKCALL_ACCESS_REQUIRED = true;\n", {
        headers: { ...headers, 'Content-Type': 'application/javascript; charset=utf-8' }
      });
    }
    if (url.pathname !== '/api/ice') return env.ASSETS.fetch(request);
    const reply = (error, status) => Response.json({ error }, { status, headers });
    if (request.method !== 'GET') return reply('GET 요청만 허용됩니다.', 405);
    if (!env.CLASSROOM_PASSWORD || !env.METERED_APP_NAME || !env.METERED_TURN_API_KEY) {
      return reply('중계 서버 설정을 마치지 않았습니다.', 503);
    }
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return reply('허용되지 않은 요청입니다.', 403);
    const limit = await env.ICE_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
    if (!limit.success) return reply('요청이 많습니다. 1분 뒤 다시 시도해 주세요.', 429);
    if (request.headers.get('Authorization') !== 'Bearer ' + env.CLASSROOM_PASSWORD) {
      return reply('수업 비밀번호를 확인해 주세요.', 401);
    }
    const directOnly = () => Response.json({
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
      warning: '무료 중계 서버를 사용할 수 없어 직접 연결만 시도합니다. 연결되지 않으면 다른 인터넷 회선으로 접속해 주세요.'
    }, { headers });
    try {
      const response = await fetch('https://' + encodeURIComponent(env.METERED_APP_NAME) + '.metered.live/api/v1/turn/credentials?apiKey=' + encodeURIComponent(env.METERED_TURN_API_KEY), {
        signal: AbortSignal.timeout(6000)
      });
      if (!response.ok) return directOnly();
      const iceServers = await response.json();
      if (!Array.isArray(iceServers) || !iceServers.some(server => server &&
        (Array.isArray(server.urls) ? server.urls : [server.urls]).some(value => /^turns?:/.test(value)))) {
        return directOnly();
      }
      return Response.json({ iceServers }, { headers });
    } catch (_) {
      return directOnly();
    }
  }
};
