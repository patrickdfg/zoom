// 정적 웹앱과 수업용 Metered TURN 연결정보 API입니다.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = { 'Cache-Control': 'no-store' };
    if (url.pathname === '/turn-config.js') {
      return new Response("window.LINKCALL_TURN_ENDPOINT = '/api/ice';\n", {
        headers: { ...headers, 'Content-Type': 'application/javascript; charset=utf-8' }
      });
    }
    if (url.pathname !== '/api/ice' && url.pathname !== '/api/session') return env.ASSETS.fetch(request);
    const origin = request.headers.get('Origin');
    const pagesOrigin = 'https://zoom.codemaru.kr';
    if (origin === pagesOrigin) {
      Object.assign(headers, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization', Vary: 'Origin' });
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    }
    const reply = (error, status) => Response.json({ error }, { status, headers });
    if (request.method !== 'GET') return reply('GET 요청만 허용됩니다.', 405);
    if (!env.METERED_APP_NAME || !env.METERED_TURN_API_KEY) {
      return reply('중계 서버 설정을 마치지 않았습니다.', 503);
    }
    if (origin && origin !== url.origin && origin !== pagesOrigin) return reply('허용되지 않은 요청입니다.', 403);
    const limit = await env.ICE_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
    if (!limit.success) return reply('요청이 많습니다. 1분 뒤 다시 시도해 주세요.', 429);
    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    // 구글 로그인 토큰은 1시간이면 끝나므로, 확인한 뒤 2시간 30분짜리 관리자 토큰으로 바꿔 줍니다.
    if (url.pathname === '/api/session') {
      if (!(await isGoogleAdmin(token, env))) return reply('관리자 계정이 아닙니다.', 401);
      const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
      return Response.json({ token: 'adm.' + exp + '.' + await sign('adm.' + exp, env), exp }, { headers });
    }
    if (!(await isAllowed(token, env))) {
      return reply('관리자 로그인을 다시 해 주세요.', 401);
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

const SESSION_SECONDS = 150 * 60;

// 관리자 토큰 서명 키. 따로 정한 값이 없으면 이미 비밀로 저장된 Metered 키를 씁니다(서명에서 키가 드러나지 않습니다).
async function sign(text, env) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET || env.METERED_TURN_API_KEY),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}

// 기존 수업 비밀번호, 2시간 30분 관리자 토큰, 관리자 구글 로그인 토큰 중 하나를 받습니다.
async function isAllowed(token, env) {
  if (!token) return false;
  if (env.CLASSROOM_PASSWORD && token === env.CLASSROOM_PASSWORD) return true;
  const session = /^adm\.(\d+)\.([0-9a-f]{64})$/.exec(token);
  if (session) {
    return Number(session[1]) > Date.now() / 1000 && session[2] === await sign('adm.' + session[1], env);
  }
  return isGoogleAdmin(token, env);
}

// 구글 로그인 토큰은 Google tokeninfo가 서명·만료를 확인합니다.
async function isGoogleAdmin(token, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.ADMIN_EMAIL || token.split('.').length !== 3) return false;
  try {
    const response = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token), {
      signal: AbortSignal.timeout(6000)
    });
    if (!response.ok) return false;
    const info = await response.json();
    return info.aud === env.GOOGLE_CLIENT_ID && info.email === env.ADMIN_EMAIL && String(info.email_verified) === 'true';
  } catch (_) {
    return false;
  }
}
