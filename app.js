// React와 WebRTC(PeerJS)로 1:1 음성·영상 통화와 모니터 공유를 구현합니다.
(function () {
  'use strict';

  const h = React.createElement;
  const { useEffect, useRef, useState } = React;
  const PREFIX = 'linkcall-room-';
  const ROOM_RE = /^\d{6}$/;
  // 예전에 보낸 24자리 초대 링크도 계속 들어올 수 있게 남겨 둡니다.
  const LEGACY_ROOM_RE = /^[0-9a-f]{24}$/;
  const TOOLS = window.LinkCallTools;
  const MAX_ZOOM = 4;
  const HOST_ID_RETRIES = 4;
  // 원격제어는 Google 크롬 원격 데스크톱(지원 코드 방식)에 맡기고, 링크콜은 통화만 맡습니다.
  const REMOTE_URL = 'https://remotedesktop.google.com/support';

  function readRemoteCode(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length === 12 ? digits : '';
  }

  function formatRemoteCode(code) {
    return code.replace(/(\d{4})(?=\d)/g, '$1 ');
  }

  // 크롬·엣지는 모니터가 하나뿐이면 false 를 줍니다(지원 안 하는 브라우저는 undefined).
  // 모니터를 꽂고 빼면 값이 바뀌므로 쓸 때마다 다시 읽습니다.
  function isSingleScreen() {
    return Boolean(window.screen && window.screen.isExtended === false);
  }

  function openRemoteDesktop() {
    window.open(REMOTE_URL, '_blank', 'noopener');
  }

  // 6자리 숫자 방 코드. 4294000000 은 1,000,000 의 배수라 숫자가 고르게 나옵니다.
  function makeRoomCode() {
    const buf = new Uint32Array(1);
    do { crypto.getRandomValues(buf); } while (buf[0] >= 4294000000);
    return String(buf[0] % 1000000).padStart(6, '0');
  }

  // 채팅·파일 목록 구분용 내부 ID (방 코드와 무관)
  function makeId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function isRoomCode(code) {
    return ROOM_RE.test(code) || LEGACY_ROOM_RE.test(code);
  }

  function formatRoom(code) {
    return ROOM_RE.test(code) ? code.slice(0, 3) + ' ' + code.slice(3) : code;
  }

  function readRoom(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    let code = raw;
    try {
      if (raw.includes('?')) code = new URL(raw, location.href).searchParams.get('room') || '';
    } catch (_) { /* 입력값 검증에서 처리 */ }
    return code.replace(/[\s-]/g, '').toLowerCase();
  }

  function roomUrl(code) {
    const url = new URL(location.href);
    url.searchParams.set('room', code);
    url.hash = '';
    return url.toString();
  }

  function App() {
    const initialRoom = readRoom(new URLSearchParams(location.search).get('room'));
    const [enteredRoom, setEnteredRoom] = useState(initialRoom);
    const [view, setView] = useState('landing');
    const [role, setRole] = useState('');
    const [roomId, setRoomId] = useState('');
    const [status, setStatus] = useState('');
    const [error, setError] = useState('');
    const [micOn, setMicOn] = useState(true);
    const [cameraOn, setCameraOn] = useState(true);
    const [remoteMicOn, setRemoteMicOn] = useState(true);
    const [remoteCameraOn, setRemoteCameraOn] = useState(true);
    const [localStream, setLocalStream] = useState(null);
    const [remoteStream, setRemoteStream] = useState(null);
    const [localScreen, setLocalScreen] = useState(null);
    const [remoteScreen, setRemoteScreen] = useState(null);
    const [copied, setCopied] = useState(false);
    const [audioHelp, setAudioHelp] = useState(false);
    const [videoQuality, setVideoQuality] = useState('standard');
    const [audioQuality, setAudioQuality] = useState('standard');
    const [chatText, setChatText] = useState('');
    const [messages, setMessages] = useState([]);
    const [transferStatus, setTransferStatus] = useState('');
    const [reconnecting, setReconnecting] = useState(false);
    const [turnEnabled, setTurnEnabled] = useState(false);
    const [focusMode, setFocusMode] = useState(false);
    const [zoom, setZoom] = useState({ z: 1, x: 0, y: 0 });
    const [pipOn, setPipOn] = useState(false);
    const [remoteOpen, setRemoteOpen] = useState(false);
    const [remoteCode, setRemoteCode] = useState('');
    const [remoteNote, setRemoteNote] = useState('');

    const peerRef = useRef(null);
    const connRef = useRef(null);
    const mainCallRef = useRef(null);
    const screenCallRef = useRef(null);
    const incomingScreenCallRef = useRef(null);
    const localRef = useRef(null);
    const localScreenRef = useRef(null);
    const cameraOnRef = useRef(true);
    const micOnRef = useRef(true);
    const roleRef = useRef('');
    const tokenRef = useRef(0);
    const timerRef = useRef(null);
    const remoteVideoRef = useRef(null);
    const remoteScreenVideoRef = useRef(null);
    const myVideoRef = useRef(null);
    const myScreenVideoRef = useRef(null);
    const stageRef = useRef(null);
    const roomIdRef = useRef('');
    const videoQualityRef = useRef('standard');
    const audioQualityRef = useRef('standard');
    const reconnectTimerRef = useRef(null);
    const reconnectTimeoutRef = useRef(null);
    const peerReconnectTimerRef = useRef(null);
    const reconnectAttemptsRef = useRef(0);
    const fileReceiverRef = useRef(null);
    const sendingFileRef = useRef(false);
    const chatListRef = useRef(null);
    const zoomRef = useRef({ z: 1, x: 0, y: 0 });
    const dragRef = useRef(null);

    if (!fileReceiverRef.current && TOOLS) {
      fileReceiverRef.current = TOOLS.createFileReceiver((file) => {
        setMessages((previous) => [...previous.slice(-99), { ...file, id: makeId() }]);
      });
    }

    const active = (token) => tokenRef.current === token;

    function attachVideo(ref, stream) {
      if (!ref.current || ref.current.srcObject === stream) return;
      ref.current.srcObject = stream || null;
      if (stream) ref.current.play().catch(() => setAudioHelp(true));
    }

    useEffect(() => {
      if (chatListRef.current) chatListRef.current.scrollTop = chatListRef.current.scrollHeight;
    }, [messages, transferStatus]);

    useEffect(() => {
      attachVideo(remoteVideoRef, remoteStream);
      attachVideo(remoteScreenVideoRef, remoteScreen);
      attachVideo(myVideoRef, localStream);
      attachVideo(myScreenVideoRef, localScreen);
    }, [view, remoteStream, remoteScreen, localStream, localScreen]);

    useEffect(() => {
      const video = remoteVideoRef.current;
      if (!video) return undefined;
      const on = () => setPipOn(true);
      const off = () => setPipOn(false);
      video.addEventListener('enterpictureinpicture', on);
      video.addEventListener('leavepictureinpicture', off);
      return () => {
        video.removeEventListener('enterpictureinpicture', on);
        video.removeEventListener('leavepictureinpicture', off);
      };
    }, [view]);

    // 상대 공유 화면 확대: 휠 = 마우스 위치 기준 확대/축소 (React 휠 이벤트는 기본 동작을 못 막아 직접 등록)
    useEffect(() => {
      const el = stageRef.current;
      if (!el || !remoteScreen) return undefined;
      const onWheel = (event) => {
        event.preventDefault();
        const rect = el.getBoundingClientRect();
        zoomAt(event.deltaY < 0 ? 1.2 : 1 / 1.2, event.clientX - rect.left, event.clientY - rect.top);
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      return () => el.removeEventListener('wheel', onWheel);
    }, [remoteScreen, view]);

    useEffect(() => { resetZoom(); }, [remoteScreen]);

    // 창 크기·크게 보기·전체화면이 바뀌면 확대 위치가 화면 밖으로 나가지 않게 다시 맞춥니다.
    useEffect(() => {
      const fit = () => setZoomState(zoomRef.current);
      fit();
      window.addEventListener('resize', fit);
      return () => window.removeEventListener('resize', fit);
    }, [focusMode]);

    useEffect(() => {
      if (!focusMode) return undefined;
      const onKey = (event) => {
        if (event.key === 'Escape' && !document.fullscreenElement) setFocusMode(false);
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [focusMode]);

    function clampZoom(next) {
      const el = stageRef.current;
      const w = el ? el.clientWidth : 0;
      const ht = el ? el.clientHeight : 0;
      const z = Math.min(MAX_ZOOM, Math.max(1, next.z));
      if (z <= 1.001) return { z: 1, x: 0, y: 0 };
      return {
        z,
        x: Math.min(0, Math.max(w * (1 - z), next.x)),
        y: Math.min(0, Math.max(ht * (1 - z), next.y))
      };
    }

    function setZoomState(next) {
      const value = clampZoom(next);
      const cur = zoomRef.current;
      if (cur.z === value.z && cur.x === value.x && cur.y === value.y) return;
      zoomRef.current = value;
      setZoom(value);
    }

    function zoomAt(factor, px, py) {
      const el = stageRef.current;
      if (!el) return;
      const cur = zoomRef.current;
      const cx = px === undefined ? el.clientWidth / 2 : px;
      const cy = py === undefined ? el.clientHeight / 2 : py;
      const z = Math.min(MAX_ZOOM, Math.max(1, cur.z * factor));
      const ratio = z / cur.z;
      setZoomState({ z, x: cx - (cx - cur.x) * ratio, y: cy - (cy - cur.y) * ratio });
    }

    function resetZoom() {
      zoomRef.current = { z: 1, x: 0, y: 0 };
      setZoom(zoomRef.current);
    }

    function onStagePointerDown(event) {
      if (!remoteScreen || zoomRef.current.z <= 1 || event.button !== 0) return;
      if (event.target.closest && event.target.closest('button')) return;
      dragRef.current = { id: event.pointerId, sx: event.clientX, sy: event.clientY, x: zoomRef.current.x, y: zoomRef.current.y };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch (_) { /* 무시 */ }
    }

    function onStagePointerMove(event) {
      const drag = dragRef.current;
      if (!drag || drag.id !== event.pointerId) return;
      setZoomState({ z: zoomRef.current.z, x: drag.x + event.clientX - drag.sx, y: drag.y + event.clientY - drag.sy });
    }

    function onStagePointerUp(event) {
      if (dragRef.current && dragRef.current.id === event.pointerId) dragRef.current = null;
    }

    function onStageDoubleClick(event) {
      if (event.target.closest && event.target.closest('button')) return;
      if (document.fullscreenElement) return;
      setFocusMode((value) => !value);
    }

    async function togglePip() {
      const video = remoteVideoRef.current;
      try {
        if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return; }
        if (!video || !video.srcObject || !document.pictureInPictureEnabled || !video.requestPictureInPicture) {
          setStatus('이 브라우저는 작은 창 띄우기를 지원하지 않습니다. Chrome 또는 Edge 를 사용해 주세요.');
          return;
        }
        await video.requestPictureInPicture();
      } catch (_) {
        setStatus('상대방 영상을 작은 창으로 띄우지 못했습니다. 버튼을 한 번 더 눌러 주세요.');
      }
    }

    function stopStream(stream) {
      if (stream) stream.getTracks().forEach((track) => track.stop());
    }

    function destroySession() {
      tokenRef.current += 1;
      clearTimeout(timerRef.current);
      clearTimeout(reconnectTimerRef.current);
      clearTimeout(reconnectTimeoutRef.current);
      clearTimeout(peerReconnectTimerRef.current);
      timerRef.current = null;
      reconnectTimerRef.current = null;
      reconnectTimeoutRef.current = null;
      peerReconnectTimerRef.current = null;
      reconnectAttemptsRef.current = 0;
      if (fileReceiverRef.current) fileReceiverRef.current.reset();
      sendingFileRef.current = false;
      const data = connRef.current;
      connRef.current = null;
      if (data && data.open) {
        try { data.send({ type: 'bye' }); } catch (_) { /* 이미 연결 종료 */ }
      }
      [screenCallRef, incomingScreenCallRef, mainCallRef].forEach((ref) => {
        const call = ref.current;
        ref.current = null;
        if (call) call.close();
      });
      if (data) data.close();
      if (peerRef.current) peerRef.current.destroy();
      peerRef.current = null;
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
      stopStream(localScreenRef.current);
      stopStream(localRef.current);
      localScreenRef.current = null;
      localRef.current = null;
      roleRef.current = '';
      roomIdRef.current = '';
    }

    function leaveRoom(message) {
      destroySession();
      setView('landing');
      setRole('');
      setRoomId('');
      setLocalStream(null);
      setLocalScreen(null);
      setRemoteStream(null);
      setRemoteScreen(null);
      setCameraOn(true);
      setMicOn(true);
      setRemoteCameraOn(true);
      setRemoteMicOn(true);
      setAudioHelp(false);
      setMessages([]);
      setChatText('');
      setTransferStatus('');
      setReconnecting(false);
      setTurnEnabled(false);
      setFocusMode(false);
      resetZoom();
      cameraOnRef.current = true;
      micOnRef.current = true;
      setStatus('');
      setError(message || '');
      setCopied(false);
      history.replaceState({}, '', location.pathname);
    }

    useEffect(() => {
      return () => destroySession();
    }, []);

    async function requestMedia() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('카메라와 마이크를 지원하는 HTTPS 브라우저가 필요합니다.');
      }
      const preset = (TOOLS && TOOLS.VIDEO[videoQualityRef.current]) || { width: 1280, height: 720, fps: 24 };
      const video = { width: { ideal: preset.width }, height: { ideal: preset.height }, frameRate: { ideal: preset.fps } };
      const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      try {
        return await navigator.mediaDevices.getUserMedia({ video, audio });
      } catch (firstError) {
        try { return await navigator.mediaDevices.getUserMedia({ audio, video: false }); }
        catch (_) {
          try { return await navigator.mediaDevices.getUserMedia({ audio: false, video }); }
          catch (_) { throw firstError; }
        }
      }
    }

    function sendState() {
      if (connRef.current && connRef.current.open) {
        connRef.current.send({
          type: 'status',
          microphone: micOnRef.current,
          camera: cameraOnRef.current && !Boolean(localScreenRef.current)
        });
      }
    }

    function setupMainCall(call, token) {
      if (mainCallRef.current && mainCallRef.current !== call) mainCallRef.current.close();
      mainCallRef.current = call;
      call.on('stream', (stream) => {
        if (!active(token)) return;
        setRemoteStream(stream);
        setView('connected');
        setStatus('상대방과 연결되었습니다.');
        if (TOOLS) TOOLS.applyQuality(call, videoQualityRef.current, audioQualityRef.current);
      });
      call.on('close', () => {
        if (active(token) && mainCallRef.current === call) {
          mainCallRef.current = null;
          setRemoteStream(null);
        }
      });
      call.on('error', () => {
        if (active(token)) setStatus('영상 연결에 문제가 있습니다. 통화를 다시 연결해 주세요.');
      });
    }

    function startMainCall(peerId, token) {
      if (!active(token) || !peerRef.current || !localRef.current) return;
      const call = peerRef.current.call(peerId, localRef.current, { metadata: { kind: 'camera' } });
      if (call) {
        setupMainCall(call, token);
        setTimeout(() => {
          if (active(token) && TOOLS) TOOLS.applyQuality(call, videoQualityRef.current, audioQualityRef.current);
        }, 1200);
      }
    }

    function startScreenCall(peerId, token) {
      if (!active(token) || !peerRef.current || !localScreenRef.current) return;
      if (screenCallRef.current) screenCallRef.current.close();
      const call = peerRef.current.call(peerId, localScreenRef.current, { metadata: { kind: 'screen' } });
      if (!call) return;
      screenCallRef.current = call;
      setTimeout(() => {
        if (active(token) && TOOLS) TOOLS.applyQuality(call, videoQualityRef.current, audioQualityRef.current);
      }, 1200);
      call.on('error', () => {
        if (active(token)) setStatus('화면 공유 연결이 실패했습니다. 다시 시도해 주세요.');
      });
      call.on('close', () => {
        if (active(token) && screenCallRef.current === call) screenCallRef.current = null;
      });
    }

    function clearRemoteConnection() {
      if (mainCallRef.current) mainCallRef.current.close();
      if (incomingScreenCallRef.current) incomingScreenCallRef.current.close();
      if (screenCallRef.current) screenCallRef.current.close();
      mainCallRef.current = null;
      incomingScreenCallRef.current = null;
      screenCallRef.current = null;
      setRemoteStream(null);
      setRemoteScreen(null);
      setRemoteCameraOn(true);
      setRemoteMicOn(true);
    }

    function retrySignalServer(token) {
      if (!active(token) || peerReconnectTimerRef.current) return;
      peerReconnectTimerRef.current = setTimeout(() => {
        peerReconnectTimerRef.current = null;
        const peer = peerRef.current;
        if (!active(token) || !peer || peer.destroyed || !peer.disconnected) return;
        try { peer.reconnect(); } catch (_) { /* 다음 복구 기회에 다시 시도 */ }
        retrySignalServer(token);
      }, 1800);
    }

    function retryGuestConnection(token) {
      if (!active(token) || roleRef.current !== 'guest' || reconnectTimerRef.current) return;
      const count = ++reconnectAttemptsRef.current;
      if (count > 12) {
        setReconnecting(false);
        setStatus('자동 재연결에 실패했습니다. 통화 종료 후 초대 링크로 다시 입장해 주세요.');
        return;
      }
      setReconnecting(true);
      setView('waiting');
      setStatus('연결이 끊겼습니다. 자동 재연결 중… (' + count + '/12)');
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (!active(token)) return;
        const peer = peerRef.current;
        if (!peer || peer.destroyed) {
          setReconnecting(false);
          setStatus('통화 연결 서버를 다시 열지 못했습니다. 새로 입장해 주세요.');
          return;
        }
        if (peer.disconnected) {
          try { peer.reconnect(); } catch (_) { /* 다음 시도에서 재확인 */ }
          retryGuestConnection(token);
          return;
        }
        if (!peer.open) { retryGuestConnection(token); return; }
        const conn = peer.connect(PREFIX + roomIdRef.current, { reliable: true });
        if (!conn) { retryGuestConnection(token); return; }
        setupDataConnection(conn, token);
        reconnectTimeoutRef.current = setTimeout(() => {
          if (active(token) && connRef.current === conn && !conn.open) {
            connRef.current = null;
            conn.close();
            retryGuestConnection(token);
          }
        }, 7000);
      }, Math.min(14000, Math.round(1200 * Math.pow(1.5, count - 1))));
    }

    function setupDataConnection(conn, token) {
      connRef.current = conn;
      conn.on('open', () => {
        if (!active(token) || connRef.current !== conn) return;
        clearTimeout(timerRef.current);
        clearTimeout(reconnectTimerRef.current);
        clearTimeout(reconnectTimeoutRef.current);
        timerRef.current = null;
        reconnectTimerRef.current = null;
        reconnectTimeoutRef.current = null;
        reconnectAttemptsRef.current = 0;
        setReconnecting(false);
        setView('connected');
        setStatus('상대방 영상 연결 중…');
        if (roleRef.current === 'host') startMainCall(conn.peer, token);
        sendState();
        if (localScreenRef.current) startScreenCall(conn.peer, token);
      });
      conn.on('data', (msg) => {
        if (!active(token) || !msg || typeof msg !== 'object') return;
        if (msg.type === 'busy') {
          leaveRoom('이미 두 사람이 통화 중인 방입니다. 다른 방을 만들어 주세요.');
        } else if (msg.type === 'bye') {
          if (roleRef.current === 'guest') leaveRoom('상대방이 통화를 종료했습니다.');
        } else if (msg.type === 'status') {
          setRemoteMicOn(Boolean(msg.microphone));
          setRemoteCameraOn(Boolean(msg.camera));
        } else if (msg.type === 'chat' && typeof msg.text === 'string' && msg.text.length <= 2000) {
          setMessages((previous) => [...previous.slice(-99), {
            id: makeId(), kind: 'text', mine: false, text: msg.text
          }]);
        } else if (typeof msg.type === 'string' && msg.type.startsWith('file-')) {
          if (fileReceiverRef.current) fileReceiverRef.current.receive(msg);
        } else if (msg.type === 'remote-code' && typeof msg.code === 'string' && readRemoteCode(msg.code)) {
          setMessages((previous) => [...previous.slice(-99), {
            id: makeId(), kind: 'remote', mine: false, code: readRemoteCode(msg.code)
          }]);
          setStatus('상대방이 원격 지원 코드를 보냈습니다. 대화창의 「코드 복사하고 원격제어 열기」를 누르세요.');
        } else if (msg.type === 'screen-stop') {
          setRemoteScreen(null);
          if (incomingScreenCallRef.current) incomingScreenCallRef.current.close();
          incomingScreenCallRef.current = null;
        }
      });
      conn.on('close', () => {
        if (!active(token) || connRef.current !== conn) return;
        connRef.current = null;
        clearRemoteConnection();
        if (roleRef.current === 'host') {
          setView('waiting');
          setStatus('상대방이 나갔습니다. 같은 링크로 다시 초대할 수 있습니다.');
        } else {
          retryGuestConnection(token);
        }
      });
      conn.on('error', () => {
        if (active(token)) setStatus('연결이 불안정합니다. 네트워크를 확인해 주세요.');
      });
    }

    async function begin(kind) {
      const inputCode = readRoom(enteredRoom);
      if (kind === 'guest' && !isRoomCode(inputCode)) {
        setError('유효한 초대 링크 또는 6자리 방 코드를 입력해 주세요.');
        return;
      }
      if (!window.Peer) {
        setError('통화 라이브러리를 불러오지 못했습니다. 새로고침하거나 네트워크를 확인해 주세요.');
        return;
      }
      setError('');
      setStatus('카메라와 마이크 연결을 확인하는 중…');
      setView('starting');
      const token = ++tokenRef.current;
      const code = kind === 'host' ? makeRoomCode() : inputCode;

      try {
        const media = await requestMedia();
        if (!active(token)) { stopStream(media); return; }
        localRef.current = media;
        setLocalStream(media);
        const hasCamera = media.getVideoTracks().length > 0;
        const hasMic = media.getAudioTracks().length > 0;
        cameraOnRef.current = hasCamera;
        micOnRef.current = hasMic;
        setCameraOn(hasCamera);
        setMicOn(hasMic);
        roleRef.current = kind;
        roomIdRef.current = code;
        reconnectAttemptsRef.current = 0;
        setMessages([]);
        setTransferStatus('');
        setRole(kind);
        setRoomId(code);
        history.replaceState({}, '', location.pathname + '?room=' + code);

        let peerOptions;
        try {
          const result = await TOOLS.getPeerOptions(window.LINKCALL_TURN_ENDPOINT);
          peerOptions = result.options;
          setTurnEnabled(result.turn);
        } catch (_) {
          peerOptions = (await TOOLS.getPeerOptions('')).options;
          setTurnEnabled(false);
          setStatus('TURN 설정을 읽지 못해 기본 직접 연결 모드로 시작합니다.');
        }
        if (!active(token)) return;
        setView('waiting');
        setStatus(kind === 'host' ? '방을 여는 중…' : '초대받은 방을 찾는 중…');
        openPeer(code, 0, peerOptions);
      } catch (err) {
        if (active(token)) leaveRoom('카메라 또는 마이크 권한을 확인해 주세요. ' + (err.message || ''));
      }

      // 6자리 코드는 공개 연결 서버에서 다른 방과 겹칠 수 있어, 방장은 겹치면 새 코드로 다시 엽니다.
      function openPeer(code, attempt, options) {
        const peer = kind === 'host' ? new Peer(PREFIX + code, options) : new Peer(options);
        peerRef.current = peer;
        const mine = () => active(token) && peerRef.current === peer;

        peer.on('open', () => {
          if (!mine()) return;
          clearTimeout(peerReconnectTimerRef.current);
          peerReconnectTimerRef.current = null;
          if (kind === 'host') {
            setStatus('방이 준비되었습니다. 초대 링크를 공유해 주세요.');
          } else {
            const conn = peer.connect(PREFIX + code, { reliable: true });
            setupDataConnection(conn, token);
            timerRef.current = setTimeout(() => {
              if (active(token) && connRef.current === conn && !conn.open) {
                connRef.current = null;
                conn.close();
                retryGuestConnection(token);
              }
            }, 15000);
          }
        });

        peer.on('connection', (conn) => {
          if (!mine()) return;
          if (kind !== 'host' || connRef.current) {
            conn.on('open', () => {
              conn.send({ type: 'busy' });
              setTimeout(() => conn.close(), 300);
            });
            return;
          }
          setupDataConnection(conn, token);
        });

        peer.on('call', (call) => {
          if (!mine()) { call.close(); return; }
          const expected = kind === 'guest' ? PREFIX + code : (connRef.current && connRef.current.peer);
          if (call.peer !== expected) { call.close(); return; }
          if (call.metadata && call.metadata.kind === 'screen') {
            if (incomingScreenCallRef.current) incomingScreenCallRef.current.close();
            incomingScreenCallRef.current = call;
            call.on('stream', (stream) => {
              if (active(token)) setRemoteScreen(stream);
            });
            call.on('close', () => {
              if (active(token) && incomingScreenCallRef.current === call) {
                incomingScreenCallRef.current = null;
                setRemoteScreen(null);
              }
            });
            call.answer(new MediaStream());
          } else {
            setupMainCall(call, token);
            call.answer(localRef.current);
          }
        });

        peer.on('disconnected', () => {
          if (!mine()) return;
          setStatus('통화 연결 서버와 연결이 끊겨 복구하는 중입니다.');
          retrySignalServer(token);
        });

        peer.on('error', (err) => {
          if (!mine()) return;
          if (err.type === 'peer-unavailable' && roleRef.current === 'guest') {
            if (connRef.current && !connRef.current.open) {
              connRef.current.close();
              connRef.current = null;
            }
            retryGuestConnection(token);
          } else if (err.type === 'unavailable-id' && kind === 'host' && attempt < HOST_ID_RETRIES) {
            peerRef.current = null;
            peer.destroy();
            const next = makeRoomCode();
            roomIdRef.current = next;
            setRoomId(next);
            history.replaceState({}, '', location.pathname + '?room=' + next);
            openPeer(next, attempt + 1, options);
          } else if (err.type === 'unavailable-id') {
            leaveRoom('이 방은 이미 열려 있습니다. 새로운 방을 만들어 주세요.');
          } else if (peer.disconnected && !peer.destroyed) {
            retrySignalServer(token);
          } else {
            setStatus('통화 연결 서버 오류가 발생했습니다. (' + err.type + ') 다시 입장해 주세요.');
          }
        });
      }
    }

    function toggleMic() {
      const next = !micOnRef.current;
      if (!localRef.current || !localRef.current.getAudioTracks().length) return;
      micOnRef.current = next;
      localRef.current.getAudioTracks().forEach((track) => { track.enabled = next; });
      setMicOn(next);
      sendState();
    }

    function toggleCamera() {
      const next = !cameraOnRef.current;
      if (!localRef.current || !localRef.current.getVideoTracks().length) return;
      cameraOnRef.current = next;
      localRef.current.getVideoTracks().forEach((track) => {
        track.enabled = next && !Boolean(localScreenRef.current);
      });
      setCameraOn(next);
      sendState();
    }

    function stopShare() {
      if (!localScreenRef.current) return;
      const screen = localScreenRef.current;
      localScreenRef.current = null;
      if (screenCallRef.current) screenCallRef.current.close();
      screenCallRef.current = null;
      stopStream(screen);
      setLocalScreen(null);
      if (localRef.current) {
        localRef.current.getVideoTracks().forEach((track) => { track.enabled = cameraOnRef.current; });
      }
      if (connRef.current && connRef.current.open) connRef.current.send({ type: 'screen-stop' });
      sendState();
    }

    function pickScreen() {
      const preset = (TOOLS && TOOLS.VIDEO[videoQualityRef.current]) || { fps: 15 };
      return navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: preset.fps } },
        audio: false,
        // 통화 탭 자신은 목록에서 빼서 화면 속 화면(거울 현상)을 막습니다.
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        monitorTypeSurfaces: 'include'
      });
    }

    function prepareScreen(screen) {
      const track = screen.getVideoTracks()[0];
      if (!track) return null;
      // 글자가 많은 화면이라 움직임보다 선명도를 우선합니다.
      try { track.contentHint = 'detail'; } catch (_) { /* 미지원 브라우저 */ }
      track.addEventListener('ended', () => {
        if (localScreenRef.current === screen) stopShare();
      }, { once: true });
      return track;
    }

    async function toggleShare() {
      if (localScreenRef.current) { stopShare(); return; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        setStatus('이 브라우저는 모니터 화면 공유를 지원하지 않습니다.');
        return;
      }
      const token = tokenRef.current;
      try {
        const screen = await pickScreen();
        if (!active(token)) { stopStream(screen); return; }
        localScreenRef.current = screen;
        setLocalScreen(screen);
        if (localRef.current) localRef.current.getVideoTracks().forEach((track) => { track.enabled = false; });
        prepareScreen(screen);
        if (connRef.current && connRef.current.open) startScreenCall(connRef.current.peer, token);
        sendState();
        if (isSingleScreen()) {
          setStatus('화면을 공유하고 있습니다. 통화 창이 가려지면 「상대 얼굴 작은 창」으로 상대방을 계속 볼 수 있습니다.');
          // 모니터가 하나면 상대 얼굴을 바로 작은 창으로 띄워 봅니다(브라우저가 막으면 버튼으로 띄움).
          const video = remoteVideoRef.current;
          if (video && video.srcObject && !document.pictureInPictureElement && video.requestPictureInPicture) {
            video.requestPictureInPicture().catch(() => {});
          }
        } else {
          setStatus('선택한 화면을 공유하고 있습니다. 다른 모니터로 바꾸려면 「화면 바꾸기」를 누르세요.');
        }
      } catch (err) {
        if (err.name !== 'NotAllowedError') setStatus('화면 공유를 시작하지 못했습니다. 다시 시도해 주세요.');
      }
    }

    // 공유를 끊지 않고 다른 모니터·창으로 바꿉니다. 가능하면 영상 트랙만 갈아 끼웁니다.
    async function switchShare() {
      const old = localScreenRef.current;
      if (!old) return;
      const token = tokenRef.current;
      let next;
      try {
        next = await pickScreen();
      } catch (err) {
        if (err.name !== 'NotAllowedError') setStatus('다른 화면으로 바꾸지 못했습니다. 다시 시도해 주세요.');
        return;
      }
      if (!active(token) || localScreenRef.current !== old) { stopStream(next); return; }
      localScreenRef.current = next;
      setLocalScreen(next);
      const track = prepareScreen(next);
      const call = screenCallRef.current;
      const pc = call && call.peerConnection;
      const sender = pc && pc.getSenders && pc.getSenders().find((item) => item.track && item.track.kind === 'video');
      let replaced = false;
      if (sender && track) {
        try { await sender.replaceTrack(track); replaced = true; } catch (_) { /* 아래에서 다시 연결 */ }
      }
      if (!replaced && active(token) && connRef.current && connRef.current.open) startScreenCall(connRef.current.peer, token);
      stopStream(old);
      setStatus('공유 화면을 바꿨습니다.');
    }

    async function copyInvite() {
      try {
        await navigator.clipboard.writeText(roomUrl(roomId));
        setCopied(true);
        setTimeout(() => setCopied(false), 2200);
      } catch (_) {
        setStatus('복사 권한이 없다면 브라우저 주소창의 링크를 복사해 주세요.');
      }
    }

    async function retryAudio() {
      const videos = [remoteVideoRef.current, remoteScreenVideoRef.current].filter(Boolean);
      await Promise.all(videos.map((video) => video.play().catch(() => {})));
      setAudioHelp(false);
    }

    function fullScreen() {
      const el = stageRef.current;
      if (!el) return;
      if (document.fullscreenElement) document.exitFullscreen();
      else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    }

    async function chooseVideoQuality(level) {
      setVideoQuality(level);
      videoQualityRef.current = level;
      try {
        if (TOOLS) await TOOLS.updateCapture(localRef.current, level);
      } catch (_) {
        setStatus('카메라가 선택한 해상도를 지원하지 않아 기존 화질을 유지합니다.');
      }
      if (TOOLS) {
        await TOOLS.applyQuality(mainCallRef.current, level, audioQualityRef.current);
        await TOOLS.applyQuality(screenCallRef.current, level, audioQualityRef.current);
      }
    }

    async function chooseAudioQuality(level) {
      setAudioQuality(level);
      audioQualityRef.current = level;
      if (TOOLS) {
        await TOOLS.applyQuality(mainCallRef.current, videoQualityRef.current, level);
        await TOOLS.applyQuality(screenCallRef.current, videoQualityRef.current, level);
      }
    }

    function sendRemoteCode() {
      const code = readRemoteCode(remoteCode);
      const conn = connRef.current;
      if (!code) { setRemoteNote('크롬 원격 데스크톱의 12자리 숫자 코드를 넣어 주세요.'); return; }
      if (!conn || !conn.open) { setRemoteNote('상대방과 연결된 뒤 보낼 수 있습니다. 지금은 코드를 직접 불러 주세요.'); return; }
      conn.send({ type: 'remote-code', code });
      setMessages((previous) => [...previous.slice(-99), { id: makeId(), kind: 'remote', mine: true, code }]);
      setRemoteCode('');
      setRemoteNote('코드를 보냈습니다. 상대방이 접속하면 크롬 원격 데스크톱 창에서 「공유」를 눌러 허락하세요.');
    }

    async function openWithRemoteCode(code) {
      try {
        await navigator.clipboard.writeText(code);
        setStatus('코드 ' + formatRemoteCode(code) + ' 를 복사했습니다. 열린 창의 「다른 사용자 지원」 칸에 붙여 넣으세요.');
      } catch (_) {
        setStatus('코드 ' + formatRemoteCode(code) + ' 를 열린 창의 「다른 사용자 지원」 칸에 입력하세요.');
      }
      openRemoteDesktop();
    }

    function sendChat() {
      const text = chatText.trim();
      const conn = connRef.current;
      if (!text || !conn || !conn.open) return;
      const clean = text.slice(0, 2000);
      conn.send({ type: 'chat', text: clean });
      setMessages((previous) => [...previous.slice(-99), {
        id: makeId(), kind: 'text', mine: true, text: clean
      }]);
      setChatText('');
    }

    async function sendAttachment(event) {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      const conn = connRef.current;
      if (!file || !TOOLS) return;
      if (!conn || !conn.open) {
        setTransferStatus('상대방이 연결된 뒤 파일을 선택해 주세요.');
        return;
      }
      if (sendingFileRef.current) {
        setTransferStatus('현재 파일 전송이 끝난 뒤 다시 시도해 주세요.');
        return;
      }
      if (file.size > TOOLS.MAX_FILE_BYTES) {
        setTransferStatus('10MB 이하 파일만 보낼 수 있습니다.');
        return;
      }
      sendingFileRef.current = true;
      const token = tokenRef.current;
      setTransferStatus('파일 전송 준비 중…');
      try {
        await TOOLS.sendFile(conn, file, () => active(token) && connRef.current === conn,
          (percent) => setTransferStatus('파일 전송 중 ' + percent + '%'));
        if (!active(token)) return;
        setMessages((previous) => [...previous.slice(-99), {
          id: makeId(), kind: 'file', mine: true, name: file.name, size: file.size
        }]);
        setTransferStatus('파일 전송 데이터 발송 완료');
      } catch (err) {
        if (active(token)) setTransferStatus(err.message || '파일 전송에 실패했습니다.');
      } finally {
        sendingFileRef.current = false;
      }
    }

    const inRoom = view !== 'landing';
    const hasRemote = Boolean(remoteStream || remoteScreen);
    const isSharing = Boolean(localScreen);
    const singleScreen = isSingleScreen();
    const remoteCameraVisible = Boolean(remoteStream && remoteStream.getVideoTracks().length && remoteCameraOn);
    const stageLabel = remoteScreen ? '상대방 모니터' : '상대방 카메라';

    return h('div', { className: 'app' },
      h('header', { className: 'topbar' },
        h('div', { className: 'brand' },
          h('span', { className: 'brand-mark' }, '↗'),
          h('span', null, '링크콜', h('span', { className: 'muted' }, '1:1 CALL')),
          h('button', {
            className: 'btn ghost remote-toggle' + (remoteOpen ? ' active' : ''), type: 'button',
            'aria-expanded': remoteOpen, onClick: () => { setRemoteOpen((value) => !value); setRemoteNote(''); }
          }, '🖥 원격제어')
        ),
        h('div', { className: 'pill' + (view === 'connected' ? ' live' : '') },
          view === 'connected' ? '● 연결됨' : view === 'waiting' ? '◉ 대기 중' : '● 1:1 전용')
      ),
      remoteOpen && h('section', { className: 'remote-panel', 'aria-label': '원격제어 안내' },
        h('div', { className: 'remote-head' },
          h('div', null,
            h('h2', null, '🖥 원격제어 · 크롬 원격 데스크톱'),
            h('p', { className: 'hint' }, '마우스·키보드 조작은 Google 크롬 원격 데스크톱이 맡고, 링크콜은 통화를 계속 이어 줍니다. 상대가 「공유」를 눌러 허락해야만 조작할 수 있습니다.')
          ),
          h('button', { className: 'btn ghost', type: 'button', onClick: () => setRemoteOpen(false), 'aria-label': '원격제어 안내 닫기' }, '✕')
        ),
        h('div', { className: 'remote-grid' },
          h('div', { className: 'remote-card' },
            h('h3', null, '내 컴퓨터를 맡길 때 (도움 받는 사람)'),
            h('ol', null,
              h('li', null, '아래 「원격 지원 화면 열기」를 누릅니다.'),
              h('li', null, '처음 한 번은 「Chrome 원격 데스크톱」 프로그램을 내려받아 설치합니다.'),
              h('li', null, '「내 컴퓨터 공유 → 코드 생성」에서 나온 12자리 코드를 아래 칸에 넣고 보냅니다.'),
              h('li', null, '상대가 접속하면 뜨는 창에서 「공유」를 누릅니다.')
            ),
            h('div', { className: 'remote-send' },
              h('input', {
                className: 'room-input', type: 'text', inputMode: 'numeric', autoComplete: 'off',
                placeholder: '12자리 지원 코드', 'aria-label': '크롬 원격 데스크톱 지원 코드',
                value: remoteCode, maxLength: 20,
                onChange: (event) => setRemoteCode(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') sendRemoteCode(); }
              }),
              h('button', { className: 'btn primary', type: 'button', onClick: sendRemoteCode, disabled: view !== 'connected' }, '코드 보내기')
            ),
            view !== 'connected' && h('p', { className: 'hint' }, '코드 보내기는 상대방과 통화가 연결된 뒤에 쓸 수 있습니다.')
          ),
          h('div', { className: 'remote-card' },
            h('h3', null, '상대 컴퓨터를 도와줄 때 (도와주는 사람)'),
            h('ol', null,
              h('li', null, '상대가 보낸 코드가 대화창에 뜨면 「코드 복사하고 원격제어 열기」를 누릅니다.'),
              h('li', null, '열린 창의 「다른 사용자 지원」 칸에 코드를 붙여 넣고 「연결」을 누릅니다.'),
              h('li', null, '원격 화면은 새 탭에서, 대화는 링크콜에서 계속됩니다.')
            ),
            h('p', { className: 'hint' }, '두 사람 모두 Google 계정으로 로그인해야 합니다. 코드는 몇 분 뒤 만료되며, 끝내려면 원격 창의 「공유 중지」를 누르세요.')
          )
        ),
        h('div', { className: 'remote-actions' },
          h('button', { className: 'btn secondary', type: 'button', onClick: openRemoteDesktop }, '↗ 원격 지원 화면 열기'),
          remoteNote && h('span', { className: 'hint' }, remoteNote)
        )
      ),
      !inRoom
        ? h('main', { className: 'landing main' },
            h('section', { className: 'hero' },
              h('div', { className: 'eyebrow' }, 'SIMPLE & PRIVATE VIDEO CALL'),
              h('h1', null, '서로의 화면을 보며', h('br'), h('span', { className: 'gradient-text' }, '편하게 이야기하세요.')),
              h('p', null, '카메라 영상부터 듀얼 모니터 중 원하는 화면까지. 복잡한 설치 없이 초대 링크 하나로 두 사람이 연결됩니다.'),
              h('div', { className: 'tags' },
                h('span', { className: 'tag' }, '◉ 1:1 실시간 영상'),
                h('span', { className: 'tag' }, '▣ 모니터 선택 공유'),
                h('span', { className: 'tag' }, '♫ 양방향 음성'),
                h('span', { className: 'tag' }, '↗ 초대 링크')
              )
            ),
            h('section', { className: 'intro-card' },
              h('h2', null, '통화 시작하기'),
              h('p', { className: 'hint' }, '카메라와 마이크를 허용한 뒤 상대방에게 링크를 보내세요.'),
              error && h('div', { className: 'alert', role: 'alert' }, error),
              h('div', { className: 'card-section' },
                h('button', { className: 'btn primary full', onClick: () => begin('host') }, '＋ 새 통화방 만들기')
              ),
              h('div', { className: 'or' }, '또는 초대받은 방 입장'),
              h('label', { className: 'input-label', htmlFor: 'join-room' }, '초대 링크 / 방 코드'),
              h('input', {
                id: 'join-room',
                className: 'room-input',
                placeholder: '링크를 붙여넣거나 6자리 코드를 입력하세요',
                value: enteredRoom,
                onChange: (event) => setEnteredRoom(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') begin('guest'); },
                autoComplete: 'off'
              }),
              h('div', { style: { marginTop: 12 } },
                h('button', { className: 'btn secondary full', onClick: () => begin('guest') }, '→ 초대방 입장하기')
              ),
              h('p', { className: 'footnote' }, '윈도우 Chrome 또는 Edge 권장 · HTTPS 환경에서 사용 · 화면 공유 시 브라우저 선택창에서 모니터를 지정합니다.')
            )
          )
        : h('main', { className: 'main room-page' },
            h('div', { className: 'room-heading' },
              h('div', null,
                h('h1', null, view === 'starting' ? '통화 준비 중…' : view === 'waiting' ? '상대방을 기다리는 중' : '통화 중'),
                h('p', null, status || '상대방과 함께 대화해 보세요.')
              ),
              h('div', { className: 'room-actions' },
                h('button', { className: 'btn ghost', onClick: copyInvite, disabled: !roomId }, copied ? '✓ 복사됨' : '↗ 초대 링크 복사'),
                h('button', { className: 'btn ghost', onClick: togglePip, disabled: !remoteStream, title: '다른 프로그램 위에 상대방 카메라를 작은 창으로 띄웁니다' },
                  pipOn ? '▣ 작은 창 닫기' : '▣ 상대 얼굴 작은 창'),
                h('button', { className: 'btn ghost', onClick: () => setFocusMode((value) => !value), title: '옆 칸을 숨기고 상대 화면을 크게 봅니다 (Esc 로 돌아오기)' },
                  focusMode ? '↙ 기본 보기' : '⤢ 크게 보기'),
                h('button', { className: 'btn ghost', onClick: fullScreen }, '⛶ 전체화면')
              )
            ),
            error && h('div', { className: 'alert', role: 'alert' }, error),
            h('div', { className: 'call-layout' + (focusMode ? ' focus' : '') },
              h('div', {
                className: 'stage' + (remoteScreen && zoom.z > 1 ? ' zoomed' : ''),
                ref: stageRef,
                onDoubleClick: onStageDoubleClick,
                onPointerDown: onStagePointerDown,
                onPointerMove: onStagePointerMove,
                onPointerUp: onStagePointerUp,
                onPointerCancel: onStagePointerUp
              },
                h('video', {
                  ref: remoteVideoRef, autoPlay: true, playsInline: true,
                  style: { display: remoteScreen || !remoteCameraVisible ? 'none' : 'block' }
                }),
                h('video', {
                  ref: remoteScreenVideoRef, autoPlay: true, playsInline: true,
                  style: {
                    display: remoteScreen ? 'block' : 'none',
                    transform: 'translate(' + zoom.x + 'px, ' + zoom.y + 'px) scale(' + zoom.z + ')',
                    transformOrigin: '0 0'
                  },
                  muted: true
                }),
                (!hasRemote || (!remoteScreen && !remoteCameraVisible)) &&
                  h('div', { className: 'placeholder' },
                    h('div', { className: 'placeholder-icon' }, hasRemote ? '◉' : '↗'),
                    h('h2', null, hasRemote ? '상대방 카메라가 꺼져 있습니다' : view === 'starting' ? '장치 연결 중입니다' : '연결을 기다리고 있습니다'),
                    h('p', null, hasRemote
                      ? '음성통화는 계속됩니다. 상대방이 모니터를 공유하면 여기 표시됩니다.'
                      : role === 'host' ? '초대 링크를 보내면 상대방의 영상이나 공유 화면이 이곳에 나타납니다.' : '방을 만든 사람이 접속해 있는지 확인해 주세요.')
                  ),
                hasRemote && h('span', { className: 'on-video' }, stageLabel,
                  remoteScreen && h('span', { className: 'on-video-hint' }, ' · 두 번 누르면 크게 · 휠로 확대')),
                remoteScreen && h('div', { className: 'zoom-tools' },
                  h('button', { type: 'button', onClick: () => zoomAt(1 / 1.25), disabled: zoom.z <= 1, 'aria-label': '축소' }, '−'),
                  h('button', { type: 'button', onClick: resetZoom, title: '원래 크기로' }, Math.round(zoom.z * 100) + '%'),
                  h('button', { type: 'button', onClick: () => zoomAt(1.25), disabled: zoom.z >= MAX_ZOOM, 'aria-label': '확대' }, '+')
                ),
                audioHelp && h('button', { className: 'btn primary', style: { position: 'absolute', top: 14, right: 14, zIndex: 4 }, onClick: retryAudio }, '▶ 상대방 소리 재생')
              ),
              h('aside', { className: 'aside' },
                h('div', { className: 'preview' },
                  h('video', {
                    ref: myVideoRef, autoPlay: true, playsInline: true, muted: true, className: 'mirror',
                    style: { display: !isSharing && cameraOn && localStream && localStream.getVideoTracks().length ? 'block' : 'none' }
                  }),
                  h('video', {
                    ref: myScreenVideoRef, autoPlay: true, playsInline: true, muted: true,
                    style: { display: isSharing ? 'block' : 'none' }
                  }),
                  !isSharing && (!cameraOn || !localStream || !localStream.getVideoTracks().length) &&
                    h('div', { className: 'preview-placeholder' }, h('span', null, '◎'), '카메라 꺼짐'),
                  h('span', { className: 'preview-caption' }, isSharing ? '내 공유 화면' : '내 카메라')
                ),
                h('div', { className: 'room-panel' },
                  h('h3', null, '상대방에게 보여줄 화면'),
                  h('div', { className: 'source' },
                    h('button', { className: !isSharing ? 'active' : '', onClick: () => { if (isSharing) stopShare(); } }, '◉', h('br'), '카메라'),
                    h('button', { className: isSharing ? 'active' : '', onClick: () => { if (!isSharing) toggleShare(); } }, '▣', h('br'), '모니터 · 창')
                  ),
                  h('p', { className: 'hint' }, singleScreen
                    ? '모니터가 하나라면 「창」 탭에서 보여줄 프로그램만 고르세요. 통화 창이 가려지면 「상대 얼굴 작은 창」을 쓰면 됩니다.'
                    : '모니터를 누르면 브라우저에서 화면 1, 화면 2 또는 창을 직접 선택합니다.'),
                  isSharing && h('button', { className: 'btn ghost full switch-share', onClick: switchShare }, '⇄ 다른 화면으로 바꾸기'),
                  h('div', { className: 'room-code' }, '방 코드 ', h('strong', null, roomId ? formatRoom(roomId) : '준비 중'))
                )
              )
            ),
            h('div', { className: 'controls' },
              h('button', { className: 'control' + (!micOn ? ' off' : ''), onClick: toggleMic, disabled: !localStream || !localStream.getAudioTracks().length },
                h('span', { className: 'symbol' }, micOn ? '♪' : '⊘'), micOn ? '마이크 켜짐' : '마이크 꺼짐'
              ),
              h('button', { className: 'control' + (!cameraOn ? ' off' : ''), onClick: toggleCamera, disabled: !localStream || !localStream.getVideoTracks().length },
                h('span', { className: 'symbol' }, cameraOn ? '◎' : '⊘'), cameraOn ? '카메라 켜짐' : '카메라 꺼짐'
              ),
              h('button', { className: 'control' + (isSharing ? ' off' : ''), onClick: toggleShare, disabled: !localStream },
                h('span', { className: 'symbol' }, '▣'), isSharing ? '공유 중지' : '화면 공유'
              ),
              isSharing && h('button', { className: 'control', onClick: switchShare },
                h('span', { className: 'symbol' }, '⇄'), '화면 바꾸기'
              ),
              h('button', { className: 'control end', onClick: () => leaveRoom('') },
                h('span', { className: 'symbol' }, '✕'), '통화 종료'
              )
            ),
            h('div', { className: 'extra-panels' },
              h('section', { className: 'quality-panel' },
                h('h2', null, '⚙ 영상 · 소리 품질'),
                h('p', { className: 'hint' }, '네트워크 상황에 맞춰 조절하세요. 실제 품질은 장치와 통화 연결 상태에 따라 달라집니다.'),
                h('label', { className: 'input-label', htmlFor: 'video-quality' }, '영상 화질'),
                h('select', {
                  className: 'quality-select', id: 'video-quality', value: videoQuality,
                  onChange: (event) => chooseVideoQuality(event.target.value)
                },
                  h('option', { value: 'low' }, '절약 · 360p / 15fps'),
                  h('option', { value: 'standard' }, '표준 · 720p / 24fps'),
                  h('option', { value: 'high' }, '고화질 · 1080p / 30fps')
                ),
                h('label', { className: 'input-label audio-label', htmlFor: 'audio-quality' }, '음성 품질'),
                h('select', {
                  className: 'quality-select', id: 'audio-quality', value: audioQuality,
                  onChange: (event) => chooseAudioQuality(event.target.value)
                },
                  h('option', { value: 'low' }, '데이터 절약 · 24 kbps 목표'),
                  h('option', { value: 'standard' }, '표준 · 40 kbps 목표'),
                  h('option', { value: 'high' }, '고음질 · 64 kbps 목표')
                ),
                h('p', { className: 'hint' }, '자동 재연결: ', reconnecting ? '복구 중 (최대 12회)' : '켜짐', ' · TURN: ', turnEnabled ? '설정됨' : '미설정')
              ),
              h('section', { className: 'chat-panel' },
                h('h2', null, '▤ 대화 · 파일 전송'),
                h('div', { className: 'chat-list', ref: chatListRef, 'aria-live': 'polite' },
                  messages.length === 0
                    ? h('p', { className: 'empty-chat' }, '상대방과 연결되면 메시지와 파일을 주고받을 수 있습니다.')
                    : messages.map((msg) => h('div', { key: msg.id, className: 'chat-bubble' + (msg.mine ? ' mine' : '') },
                        h('span', { className: 'chat-who' }, msg.mine ? '나' : '상대방'),
                        msg.kind === 'remote'
                          ? h('div', { className: 'chat-remote' },
                              h('span', null, '🖥 원격 지원 코드 ', h('strong', null, formatRemoteCode(msg.code))),
                              !msg.mine && h('button', { className: 'btn primary', type: 'button', onClick: () => openWithRemoteCode(msg.code) }, '코드 복사하고 원격제어 열기'))
                          : msg.kind === 'file'
                          ? h('div', { className: 'chat-file' }, '📎 ', msg.name, ' (', (msg.size / 1024 / 1024).toFixed(2), ' MB)',
                              msg.url && h('a', { href: msg.url, download: msg.name }, '파일 저장'))
                          : h('p', { className: 'chat-message' }, msg.text)
                      ))
                ),
                h('div', { className: 'chat-composer' },
                  h('input', {
                    className: 'room-input', type: 'text', 'aria-label': '채팅 메시지',
                    value: chatText, maxLength: 2000,
                    placeholder: view === 'connected' ? '메시지 입력…' : '연결되면 메시지를 보낼 수 있습니다',
                    disabled: view !== 'connected',
                    onChange: (event) => setChatText(event.target.value),
                    onKeyDown: (event) => { if (event.key === 'Enter') sendChat(); }
                  }),
                  h('button', { className: 'btn primary', disabled: view !== 'connected' || !chatText.trim(), onClick: sendChat }, '전송')
                ),
                h('div', { className: 'attachment-row' },
                  h('label', { className: 'btn ghost file-label' }, '📎 파일 보내기',
                    h('input', {
                      type: 'file', disabled: view !== 'connected',
                      'aria-label': '보낼 파일 선택', onChange: sendAttachment
                    })
                  ),
                  h('span', { className: 'hint' }, transferStatus || '파일은 10MB 이하 · 상대방에게 직접 전송')
                )
              )
            ),
            h('div', { className: 'connection-note' },
              h('strong', null, role === 'host' ? '방을 만들었습니다. ' : '초대받은 방에 입장했습니다. '),
              '상대방이 참가하면 바로 연결됩니다. 이어폰을 사용하면 소리 울림을 줄일 수 있습니다.',
              !remoteMicOn && ' · 상대방 마이크 꺼짐'
            )
          ),
      h('footer', { className: 'footer' }, '링크콜 테스트 버전 · 무료 PeerJS 연결 서버 · 영상·파일은 상대방과 직접 전송되며 TURN 설정 시 중계될 수 있습니다.')
    );
  }

  ReactDOM.createRoot(document.getElementById('root')).render(h(App));
})();
