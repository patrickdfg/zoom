// 통화 화질·음질, TURN 연결정보, 안전한 파일 전송을 보조합니다.
(function () {
  'use strict';
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const CHUNK_BYTES = 12 * 1024;
  const VIDEO = {
    low: { width: 640, height: 360, fps: 15, bitrate: 400000 },
    standard: { width: 1280, height: 720, fps: 24, bitrate: 1200000 },
    high: { width: 1920, height: 1080, fps: 30, bitrate: 2500000 }
  };
  const AUDIO = { low: 24000, standard: 40000, high: 64000 };

  async function getPeerOptions(endpoint) {
    const fallback = [{ urls: 'stun:stun.cloudflare.com:3478' }];
    if (!endpoint) return { options: { debug: 1, config: { iceServers: fallback } }, turn: false };
    const response = await fetch(endpoint, { cache: 'no-store' });
    if (!response.ok) throw new Error('TURN 인증정보 요청에 실패했습니다.');
    const body = await response.json();
    if (!body || !Array.isArray(body.iceServers) || !body.iceServers.length) {
      throw new Error('TURN 서버 응답 형식이 올바르지 않습니다.');
    }
    const servers = body.iceServers.filter((server) =>
      server && (typeof server.urls === 'string' || Array.isArray(server.urls))
    );
    if (!servers.length) throw new Error('사용 가능한 TURN/STUN 서버가 없습니다.');
    return { options: { debug: 1, config: { iceServers: servers } }, turn: servers.some((s) =>
      (Array.isArray(s.urls) ? s.urls : [s.urls]).some((url) => /^turns?:/.test(url))
    ) };
  }

  async function updateCapture(stream, level) {
    const track = stream && stream.getVideoTracks()[0];
    if (!track || !track.applyConstraints) return;
    const v = VIDEO[level] || VIDEO.standard;
    await track.applyConstraints({
      width: { ideal: v.width }, height: { ideal: v.height }, frameRate: { ideal: v.fps }
    });
  }

  async function applyQuality(call, videoLevel, audioLevel) {
    const pc = call && call.peerConnection;
    if (!pc || !pc.getSenders) return;
    const video = VIDEO[videoLevel] || VIDEO.standard;
    const audio = AUDIO[audioLevel] || AUDIO.standard;
    await Promise.all(pc.getSenders().map(async (sender) => {
      if (!sender.track || !sender.getParameters || !sender.setParameters) return;
      const parameters = sender.getParameters();
      if (!parameters.encodings || !parameters.encodings.length) return;
      const encoding = parameters.encodings[0];
      encoding.maxBitrate = sender.track.kind === 'audio' ? audio : video.bitrate;
      if (sender.track.kind === 'video') encoding.maxFramerate = video.fps;
      try { await sender.setParameters(parameters); }
      catch (_) { /* 장치·브라우저별 미지원 옵션은 무시 */ }
    }));
  }

  function createFileReceiver(onComplete) {
    const incoming = new Map();
    const blobUrls = [];

    function receive(message) {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'file-start') {
        const { id, name, size, mime } = message;
        if (typeof id !== 'string' || id.length > 80 ||
            typeof name !== 'string' || name.length > 200 ||
            !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES ||
            incoming.size >= 3) return;
        incoming.set(id, { name, size, mime: typeof mime === 'string' ? mime : '', buffers: [], received: 0 });
      }
      if (message.type === 'file-chunk') {
        const item = incoming.get(message.id);
        if (!item) return;
        const buffer = message.bytes;
        if (!(buffer instanceof Uint8Array) && !(buffer instanceof ArrayBuffer)) {
          incoming.delete(message.id);
          return;
        }
        const chunk = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        if (!chunk.length || chunk.byteLength > CHUNK_BYTES || item.received + chunk.length > item.size) {
          incoming.delete(message.id);
          return;
        }
        item.buffers.push(chunk);
        item.received += chunk.length;
      }
      if (message.type === 'file-end') {
        const item = incoming.get(message.id);
        if (!item) return;
        incoming.delete(message.id);
        if (item.received !== item.size) return;
        const blob = new Blob(item.buffers, { type: item.mime || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        blobUrls.push(url);
        onComplete({ kind: 'file', mine: false, name: item.name, size: item.size, url });
      }
    }

    function reset() {
      incoming.clear();
      blobUrls.forEach((url) => URL.revokeObjectURL(url));
      blobUrls.length = 0;
    }
    return { receive, reset };
  }

  async function sendFile(conn, file, keepGoing, onProgress) {
    if (!conn || !conn.open) throw new Error('상대방과 연결된 후 전송해 주세요.');
    if (file.size > MAX_FILE_BYTES) throw new Error('파일은 10MB 이하만 보낼 수 있습니다.');
    const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now());
    conn.send({ type: 'file-start', id, name: file.name.slice(0, 200), size: file.size, mime: file.type });
    for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
      if (!keepGoing() || !conn.open) throw new Error('연결이 끊겨 파일 전송이 중단되었습니다.');
      const channel = conn.dataChannel;
      while (channel && channel.bufferedAmount > 196608) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        if (!keepGoing() || !conn.open) throw new Error('파일 전송이 중단되었습니다.');
      }
      const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
      conn.send({ type: 'file-chunk', id, bytes });
      if (onProgress) onProgress(Math.floor(Math.min(1, (offset + bytes.length) / Math.max(file.size, 1)) * 100));
      if (offset % (CHUNK_BYTES * 8) === 0) await new Promise((resolve) => setTimeout(resolve, 15));
    }
    conn.send({ type: 'file-end', id });
    if (onProgress) onProgress(100);
  }

  window.LinkCallTools = {
    VIDEO, AUDIO, MAX_FILE_BYTES, getPeerOptions, updateCapture, applyQuality,
    createFileReceiver, sendFile
  };
})();
