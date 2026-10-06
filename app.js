import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import { getFirestore, doc, getDoc, onSnapshot, updateDoc, runTransaction } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';

const YOUTUBE_API_KEY = 'AIzaSyDs31A8sNQqSVESILNKv93qWLxEAq-33E4';
const FIREBASE_CONFIG = { apiKey: 'AIzaSyBwySV_jaJoQcow6u494XH7WkFmMY3eyG0', authDomain: 'muxo-karaoke.firebaseapp.com', projectId: 'muxo-karaoke', storageBucket: 'muxo-karaoke.firebasestorage.app', messagingSenderId: '290765040154', appId: '1:290765040154:web:eb204766dcdc3c58437fa3' };
const PRIORITY_CHANNEL_NAME = 'Karaoke Entre Panas';
const TRANSITION_AUDIO_URL = 'https://opengameart.org/sites/default/files/funkymenuloop-longer.mp3';
const COMMERCIAL_AUDIO_URL = './muxo-commercial.m4a';
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_ID_LENGTH = 6;
const MAX_TABLES = 20;
const OPERATOR_LEASE_MS = 45000;
const OPERATOR_HEARTBEAT_MS = 10000;
const freshSession = () => emptyRoomSession();
const emptyRoomSession = () => ({ nowPlaying: null, queue: [], recent: [], playback: { volume: 100, position: 0, duration: 0, videoId: null, command: null } });
const app = document.querySelector('#app');
let state = freshSession();
let selectedSong = null;
let selectedTableNumber = '';
let selectedSingerName = '';
let searchState = { query: '', mode: 'recommendations', channelId: null, pageSize: 10, page: 1, nextPageToken: null, prevPageToken: null, totalResults: 0, results: [] };
let recommendationsLoading = false;
let saveTimer = null;
let firebaseDb = null;
let firebaseReady = false;
let sessionUnsubscribe = null;
let activeRoomId = null;
let displayIframe = null;
let displayPlayer = null;
let youtubeApiPromise = null;
let lastAppliedPlaybackCommandId = null;
let playbackTelemetryTimer = null;
let displayVisualizerFrame = null;
let displayTransitionTimer = null;
let displayTransitionActive = false;
let displayVideoError = false;
let transitionAmbientAudio = null;
let commercialAudio = null;
let commercialPlaybackId = 0;
let selectionKeydownHandler = null;
let operatorLeaseTimer = null;
let operatorLockError = '';
const localKey = 'muxo-pages-session';
const deviceModeKey = 'muxo-device-mode';

function escapeHtml(value) {
  const normalized = String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
  return normalized.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
function normalizeChannelName(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
function prioritizeSearchResults(results) {
  const priority = normalizeChannelName(PRIORITY_CHANNEL_NAME);
  return [...results].sort((first, second) => Number(normalizeChannelName(second.channelTitle).includes(priority)) - Number(normalizeChannelName(first.channelTitle).includes(priority)));
}
function logoMarkup(className = '', alt = 'Muxo') { return `<img class="muxo-logo ${className}" src="muxo-logo.png" alt="${escapeHtml(alt)}"/>`; }
function icon(name) { return `<span class="material-symbols-rounded" aria-hidden="true">${name}</span>`; }
function routeInfo() {
  const [path, query = ''] = location.hash.replace('#', '').split('?');
  return { path: path || 'waiter', params: new URLSearchParams(query) };
}
function route() { return routeInfo().path; }
function roomIdFromLocation() {
  const room = routeInfo().params.get('room') ?? '';
  return normalizeRoomId(room) || null;
}
function roomHref(role) { return `#${role}${activeRoomId ? `?room=${encodeURIComponent(activeRoomId)}` : ''}`; }
function localSessionKey(roomId = activeRoomId) { return `${localKey}-${roomId || 'local'}`; }
function normalizeRoomId(value) { return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_ID_LENGTH); }
function generateRoomId() { return Array.from({ length: ROOM_ID_LENGTH }, () => ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)]).join(''); }
function deviceMode() { return localStorage.getItem(deviceModeKey); }
function canAccessOperator() { return !['waiter', 'display'].includes(deviceMode()); }
function rememberDeviceMode(role) {
  if (role === 'operator' || !deviceMode()) localStorage.setItem(deviceModeKey, role);
}
function roleSwitchMarkup(activeRole) {
  const operatorLink = canAccessOperator() ? `<a class="${activeRole === 'operator' ? 'active' : ''}" href="#operator">${icon('queue_music')}Encargado</a>` : '';
  return `<div class="room-role-switch">${operatorLink}<a class="${activeRole === 'waiter' ? 'active' : ''}" href="#waiter">${icon('person')}Mesero</a><a class="${activeRole === 'display' ? 'active' : ''}" href="#display">${icon('tv')}Pantalla</a></div>`;
}
function redirectUnauthorizedOperator() {
  if (route() !== 'operator' || canAccessOperator()) return false;
  const roomId = roomIdFromLocation();
  const target = roomId ? `#waiter?room=${encodeURIComponent(roomId)}` : '#waiter';
  notify('Este dispositivo está configurado como mesero y no puede abrir el modo encargado.');
  if (location.hash !== target) location.hash = target;
  return true;
}
function clientDeviceId() {
  const stored = localStorage.getItem('muxo-client-id');
  if (stored) return stored;
  const value = id();
  localStorage.setItem('muxo-client-id', value);
  return value;
}
function currentRole() { return ['waiter', 'operator', 'display'].includes(route()) ? route() : 'waiter'; }
function roleLabel(role = currentRole()) { return role === 'operator' ? 'encargado' : role === 'display' ? 'pantalla TV' : 'mesero'; }
function id() { return crypto.randomUUID?.() || `muxo-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function notify(message) { const node = document.createElement('div'); node.className = 'toast'; node.textContent = message; document.body.append(node); setTimeout(() => node.remove(), 2600); }
function youtubeUrl(videoId, autoplay = 1) { return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=${autoplay}&playsinline=1&rel=0&enablejsapi=1&origin=${encodeURIComponent(location.origin)}&widget_referrer=${encodeURIComponent(location.href)}`; }
function playbackState() { return state.playback ?? { volume: 100, command: null }; }
function playbackVolume() { const volume = Number(playbackState().volume); return Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : 100; }
function playbackLabel() { return playbackState().command?.action === 'pause' ? 'Pausado' : 'En reproducción'; }
function formatTime(seconds) { const safe = Math.max(0, Math.floor(Number(seconds) || 0)); return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`; }
function roomDocument() { return doc(firebaseDb, 'sessions', 'muxo-main'); }
function sessionDocument() { return roomDocument(); }
function youtubeApiError(response, payload = null) {
  const reason = payload?.error?.errors?.[0]?.reason;
  const message = String(payload?.error?.message ?? '').toLowerCase();
  if (reason === 'quotaExceeded') return new Error('La cuota diaria de YouTube se agotó. Intenta nuevamente mañana o revisa la cuota del proyecto.');
  if (reason === 'keyInvalid') return new Error('La clave de YouTube no es válida. Revisa la configuración de YouTube Data API.');
  if (reason === 'forbidden' && message.includes('referer')) return new Error('YouTube bloqueó este dominio. Agrega el dominio local o publicado a las restricciones HTTP de la clave.');
  if (response?.status === 403) return new Error('YouTube rechazó la solicitud. Revisa la clave, sus restricciones HTTP y la cuota del proyecto.');
  return new Error('YouTube no respondió correctamente. Intenta nuevamente en unos segundos.');
}
async function youtubeRequest(endpoint, params) {
  const response = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${new URLSearchParams(params)}`);
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw youtubeApiError(response, payload);
  return payload;
}
function loadYoutubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (youtubeApiPromise) return youtubeApiPromise;
  youtubeApiPromise = new Promise((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { previousReady?.(); resolve(); };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.dataset.muxoYoutubeApi = 'true';
    script.onerror = () => reject(new Error('No se pudo cargar el reproductor de YouTube.'));
    document.head.append(script);
  });
  return youtubeApiPromise;
}
function postYoutubeCommand(func, args = []) {
  if (!displayPlayer || typeof displayPlayer[func] !== 'function') return false;
  displayPlayer[func](...args);
  return true;
}
function postPlaybackCommand(command) {
  if (command.action === 'pause') return postYoutubeCommand('pauseVideo');
  if (command.action === 'play') return postYoutubeCommand('playVideo');
  if (command.action === 'restart') {
    const seeked = postYoutubeCommand('seekTo', [0, true]);
    postYoutubeCommand('playVideo');
    return seeked;
  }
  if (command.action === 'set-volume') return postYoutubeCommand('setVolume', [command.volume]);
  return false;
}
function syncDisplayVolume() { postYoutubeCommand('setVolume', [playbackVolume()]); }
function applyPlaybackCommand(command) {
  if (!command || command.id === lastAppliedPlaybackCommandId || displayTransitionActive) return;
  lastAppliedPlaybackCommandId = command.id;
  postPlaybackCommand(command);
}
function stopPlaybackTelemetry() {
  clearInterval(playbackTelemetryTimer);
  playbackTelemetryTimer = null;
}
function stopDisplayVisualizer() {
  if (displayVisualizerFrame !== null) cancelAnimationFrame(displayVisualizerFrame);
  displayVisualizerFrame = null;
}
function startDisplayVisualizer() {
  stopDisplayVisualizer();
  const visualizer = document.querySelector('#display-edge-visualizer');
  if (!visualizer || !displayPlayer) return;
  const animate = (timestamp) => {
    if (!visualizer.isConnected || !displayPlayer) {
      stopDisplayVisualizer();
      return;
    }
    const isPlaying = displayPlayer.getPlayerState?.() === window.YT?.PlayerState?.PLAYING;
    const position = Number(displayPlayer.getCurrentTime?.()) || 0;
    const wave = (Math.sin(timestamp * .006 + position * 1.7) + Math.sin(timestamp * .011 + position * 2.5) + 2) / 4;
    const level = isPlaying ? .18 + wave * .82 : .06;
    visualizer.style.setProperty('--visualizer-level', level.toFixed(3));
    visualizer.style.setProperty('--visualizer-glow', `${(0.35 + level * .65).toFixed(3)}`);
    visualizer.style.setProperty('--visualizer-scale', `${(.86 + level * .14).toFixed(3)}`);
    visualizer.style.setProperty('--visualizer-drift', `${Math.round(level * 18)}px`);
    visualizer.classList.toggle('is-playing', isPlaying);
    displayVisualizerFrame = requestAnimationFrame(animate);
  };
  displayVisualizerFrame = requestAnimationFrame(animate);
}
function startPlaybackTelemetry() {
  stopPlaybackTelemetry();
  if (!firebaseReady || !displayPlayer) return;
  playbackTelemetryTimer = setInterval(async () => {
    if (!displayPlayer || !state.nowPlaying) return;
    const position = Number(displayPlayer.getCurrentTime?.());
    const duration = Number(displayPlayer.getDuration?.());
    if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return;
    const playback = { ...playbackState(), position, duration, videoId: state.nowPlaying.youtubeVideoId, updatedAt: Date.now() };
    state = { ...state, playback };
    await updateDoc(sessionDocument(), { [`rooms.${activeRoomId}.playback`]: playback });
  }, 2000);
}
function preferredSpeechVoice() {
  const voices = window.speechSynthesis?.getVoices?.() ?? [];
  const spanishVoices = voices.filter((voice) => /^es[-_]/i.test(voice.lang) || /español|espanol|spanish/i.test(voice.name));
  const score = (voice) => {
    const label = `${voice.name} ${voice.lang}`.toLowerCase();
    if (/natural|neural|online/.test(label)) return 5;
    if (/sabina|elena|jorge|google español|google espanol/.test(label)) return 4;
    if (/es[-_]pe/.test(label)) return 3;
    if (/es[-_]mx|es[-_]es/.test(label)) return 2;
    return 1;
  };
  return [...spanishVoices].sort((first, second) => score(second) - score(first))[0] ?? null;
}
function createSpeechUtterance(text) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'es-PE';
  utterance.rate = .96;
  utterance.pitch = 1;
  utterance.volume = 1;
  const voice = preferredSpeechVoice();
  if (voice) utterance.voice = voice;
  return utterance;
}
function startTransitionAmbientAudio() {
  if (!transitionAmbientAudio) {
    transitionAmbientAudio = new Audio(TRANSITION_AUDIO_URL);
    transitionAmbientAudio.loop = true;
    transitionAmbientAudio.preload = 'auto';
    transitionAmbientAudio.volume = .14;
  }
  transitionAmbientAudio.currentTime = 0;
  const playRequest = transitionAmbientAudio.play();
  playRequest?.catch?.(() => {});
}
function stopTransitionAmbientAudio() {
  if (!transitionAmbientAudio) return;
  transitionAmbientAudio.pause();
  transitionAmbientAudio.currentTime = 0;
}
function getCommercialAudio() {
  if (!commercialAudio) {
    commercialAudio = new Audio(COMMERCIAL_AUDIO_URL);
    commercialAudio.preload = 'auto';
    commercialAudio.volume = 1;
  }
  return commercialAudio;
}
function stopCommercialAudio() {
  commercialPlaybackId += 1;
  if (!commercialAudio) return;
  commercialAudio.pause();
  commercialAudio.currentTime = 0;
  commercialAudio.onended = null;
  commercialAudio.onerror = null;
}
function playCommercialAudio(onFinished) {
  const audio = getCommercialAudio();
  const playbackId = ++commercialPlaybackId;
  audio.pause();
  audio.currentTime = 0;
  const finish = () => {
    if (playbackId === commercialPlaybackId) onFinished?.();
  };
  audio.onended = finish;
  audio.onerror = finish;
  const playRequest = audio.play();
  playRequest?.catch?.(finish);
}
function refreshMarquees(root = document) {
  root?.querySelectorAll?.('.text-marquee').forEach((marquee) => {
    const content = marquee.querySelector('[data-marquee-content]');
    if (!content) return;
    const distance = Math.max(0, content.getBoundingClientRect().width - marquee.clientWidth);
    marquee.style.setProperty('--marquee-distance', `${distance}px`);
    marquee.classList.toggle('is-overflowing', distance > 4);
  });
}
function stopAnnouncementAudio() {
  window.speechSynthesis?.cancel();
  stopCommercialAudio();
}
function speakDisplayTransition(current) {
  stopAnnouncementAudio();
  window.speechSynthesis?.cancel();
  const phrases = [
    { text: `Mesa ${current.tableNumber}.`, pauseAfter: 180 },
    { text: `Canta ${current.singerName}.`, pauseAfter: 180 },
    { text: `El tema ${current.songTitle}.`, pauseAfter: 340 },
    { text: `Mesa ${current.tableNumber}.`, pauseAfter: 180 },
    { text: `Canta ${current.singerName}.`, pauseAfter: 180 },
    { text: `El tema ${current.songTitle}.`, pauseAfter: 340 },
  ];
  const speakDetails = () => {
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
      finishDisplayTransition();
      return;
    }
    let index = 0;
    const speakNext = () => {
      if (!displayTransitionActive) return;
      if (index >= phrases.length) {
        finishDisplayTransition();
        return;
      }
      const phrase = phrases[index++];
      const utterance = createSpeechUtterance(phrase.text);
      utterance.onend = () => setTimeout(speakNext, phrase.pauseAfter);
      utterance.onerror = () => setTimeout(speakNext, phrase.pauseAfter);
      window.speechSynthesis.speak(utterance);
    };
    speakNext();
  };
  playCommercialAudio(() => {
    if (!displayTransitionActive) return;
    setTimeout(speakDetails, 220);
  });
}
function showDisplayVideoError() {
  displayVideoError = true;
  displayTransitionActive = false;
  clearTimeout(displayTransitionTimer);
  displayTransitionTimer = null;
  stopDisplayVisualizer();
  window.speechSynthesis?.cancel();
  stopTransitionAmbientAudio();
  stopAnnouncementAudio();
  postYoutubeCommand('pauseVideo');
  const transition = document.querySelector('#display-transition');
  if (transition) transition.hidden = true;
  const audioActivation = document.querySelector('#audio-activation');
  if (audioActivation) audioActivation.hidden = true;
  const errorOverlay = document.querySelector('#display-video-error');
  if (errorOverlay) errorOverlay.hidden = false;
}
function hideDisplayVideoError() {
  displayVideoError = false;
  const errorOverlay = document.querySelector('#display-video-error');
  if (errorOverlay) errorOverlay.hidden = true;
}
function showAudioActivation() {
  const overlay = document.querySelector('#audio-activation');
  if (!overlay) return;
  overlay.hidden = false;
  const button = overlay.querySelector('#activate-audio');
  if (button) button.onclick = () => {
    displayPlayer?.unMute?.();
    syncDisplayVolume();
    window.speechSynthesis?.resume();
    postYoutubeCommand('playVideo');
    overlay.hidden = true;
    localStorage.setItem('muxo-audio-enabled', 'true');
  };
}
function ensureDisplayPlayback() {
  postYoutubeCommand('playVideo');
  setTimeout(() => {
    if (!displayPlayer || displayTransitionActive) return;
    const playerState = displayPlayer.getPlayerState?.();
    if (playerState === window.YT?.PlayerState?.UNSTARTED || playerState === window.YT?.PlayerState?.CUED) {
      displayPlayer.mute?.();
      displayPlayer.playVideo?.();
      setTimeout(() => { if (displayPlayer?.getPlayerState?.() === window.YT?.PlayerState?.PLAYING) showAudioActivation(); }, 700);
    }
  }, 900);
}
function finishDisplayTransition() {
  clearTimeout(displayTransitionTimer);
  displayTransitionTimer = null;
  window.speechSynthesis?.cancel();
  stopCommercialAudio();
  stopTransitionAmbientAudio();
  const overlay = document.querySelector('#display-transition');
  if (overlay) overlay.hidden = true;
  displayTransitionActive = false;
  const command = playbackState().command;
  if (command?.action === 'pause') postYoutubeCommand('pauseVideo');
  else ensureDisplayPlayback();
  lastAppliedPlaybackCommandId = command?.id ?? lastAppliedPlaybackCommandId;
  startPlaybackTelemetry();
}
function beginDisplayTransition(current) {
  displayTransitionActive = true;
  stopAnnouncementAudio();
  postYoutubeCommand('pauseVideo');
  const overlay = document.querySelector('#display-transition');
  if (overlay) {
    overlay.querySelector('[data-transition-singer]').textContent = current.singerName;
    overlay.querySelector('[data-transition-song]').textContent = current.songTitle;
    overlay.querySelector('[data-transition-table]').textContent = `MESA ${current.tableNumber}`;
    overlay.hidden = false;
    refreshMarquees(overlay);
  }
  startTransitionAmbientAudio();
  speakDisplayTransition(current);
}
async function attachDisplayPlayer({ transition = false } = {}) {
  const iframe = document.querySelector('#display-video');
  if (!iframe) { stopPlaybackTelemetry(); stopDisplayVisualizer(); displayIframe = null; displayPlayer = null; return; }
  if (iframe === displayIframe) return;
  stopPlaybackTelemetry();
  stopDisplayVisualizer();
  displayIframe = iframe;
  displayPlayer = null;
  hideDisplayVideoError();
  try {
    await loadYoutubeApi();
    if (document.querySelector('#display-video') !== iframe) return;
    displayPlayer = new window.YT.Player('display-video', {
      events: {
        onReady: () => {
          if (!displayVideoError) hideDisplayVideoError();
          syncDisplayVolume();
          startDisplayVisualizer();
          if (transition && state.nowPlaying) {
            beginDisplayTransition(state.nowPlaying);
            return;
          }
          const command = playbackState().command;
          if (command) {
            lastAppliedPlaybackCommandId = command.id;
            postPlaybackCommand(command);
            if (command.action === 'set-volume' && state.nowPlaying) postYoutubeCommand('playVideo');
          } else if (state.nowPlaying) ensureDisplayPlayback();
          startPlaybackTelemetry();
        },
        onStateChange: (event) => {
          if (event.data === window.YT.PlayerState.ENDED && state.nowPlaying) advanceQueue(state.nowPlaying.youtubeVideoId);
        },
        onError: showDisplayVideoError,
        onAutoplayBlocked: showAudioActivation,
      },
    });
  } catch (error) {
    console.error(error);
    notify('El reproductor de YouTube no está disponible.');
  }
}
function sendPlaybackCommand(action, volume = playbackVolume()) {
  const nextVolume = Math.max(0, Math.min(100, volume));
  save({ ...state, playback: { ...playbackState(), volume: nextVolume, command: { id: id(), action, volume: nextVolume, createdAt: Date.now() } } });
}

async function initializeFirebaseServices() {
  if (!firebaseDb) {
    firebaseDb = getFirestore(initializeApp(FIREBASE_CONFIG));
  }
}
async function claimOperatorLock(roomId) {
  const roomRef = roomDocument();
  const deviceId = clientDeviceId();
  await runTransaction(firebaseDb, async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    const roomState = snapshot.data()?.rooms?.[roomId];
    if (!roomState) throw new Error('ROOM_NOT_FOUND');
    const lastSeen = Number(roomState.operatorLastSeenAt) || 0;
    const occupied = roomState.operatorId && roomState.operatorId !== deviceId && Date.now() - lastSeen < OPERATOR_LEASE_MS;
    if (occupied) {
      const error = new Error('OPERATOR_ALREADY_ACTIVE');
      error.code = 'OPERATOR_ALREADY_ACTIVE';
      throw error;
    }
    transaction.update(roomRef, {
      [`rooms.${roomId}.operatorId`]: deviceId,
      [`rooms.${roomId}.operatorLastSeenAt`]: Date.now(),
      [`rooms.${roomId}.updatedAt`]: Date.now(),
    });
  });
}
function stopOperatorLease() {
  clearInterval(operatorLeaseTimer);
  operatorLeaseTimer = null;
}
async function releaseOperatorLock(roomId = activeRoomId) {
  stopOperatorLease();
  if (!firebaseReady || !roomId) return;
  try {
    await runTransaction(firebaseDb, async (transaction) => {
      const roomRef = roomDocument();
      const snapshot = await transaction.get(roomRef);
      const roomState = snapshot.data()?.rooms?.[roomId];
      if (!roomState || roomState.operatorId !== clientDeviceId()) return;
      transaction.update(roomRef, {
        [`rooms.${roomId}.operatorId`]: null,
        [`rooms.${roomId}.operatorLastSeenAt`]: 0,
        [`rooms.${roomId}.updatedAt`]: Date.now(),
      });
    });
  } catch (error) {
    console.error(error);
  }
}
function loseOperatorLock() {
  operatorLockError = 'Esta sala ya tiene otro encargado activo.';
  stopOperatorLease();
  sessionUnsubscribe?.();
  sessionUnsubscribe = null;
  activeRoomId = null;
  firebaseReady = false;
  state = emptyRoomSession();
  render();
}
function startOperatorLease() {
  stopOperatorLease();
  const renew = async () => {
    if (!firebaseReady || !activeRoomId || currentRole() !== 'operator') return;
    try {
      await runTransaction(firebaseDb, async (transaction) => {
        const roomRef = roomDocument();
        const snapshot = await transaction.get(roomRef);
        const roomState = snapshot.data()?.rooms?.[activeRoomId];
        if (!roomState || roomState.operatorId !== clientDeviceId()) {
          const error = new Error('OPERATOR_LOCK_LOST');
          error.code = 'OPERATOR_LOCK_LOST';
          throw error;
        }
        transaction.update(roomRef, { [`rooms.${activeRoomId}.operatorLastSeenAt`]: Date.now() });
      });
    } catch (error) {
      console.error(error);
      loseOperatorLock();
    }
  };
  operatorLeaseTimer = setInterval(renew, OPERATOR_HEARTBEAT_MS);
}
async function startRoomSession(roomId) {
  sessionUnsubscribe?.();
  sessionUnsubscribe = null;
  stopOperatorLease();
  firebaseReady = false;
  state = emptyRoomSession();
  if (!roomId) {
    render();
    return;
  }
  try {
    await initializeFirebaseServices();
    const sessionRole = currentRole();
    const sessionRef = roomDocument();
    const snapshot = await getDoc(sessionRef);
    const roomState = snapshot.data()?.rooms?.[roomId];
    if (!snapshot.exists() || !roomState) {
      activeRoomId = null;
      notify('La sala no existe o ya no está disponible.');
      render();
      return;
    }
    if (sessionRole === 'operator') {
      try {
        await claimOperatorLock(roomId);
      } catch (error) {
        console.error(error);
        activeRoomId = null;
        operatorLockError = error.code === 'OPERATOR_ALREADY_ACTIVE' ? 'Esta sala ya tiene otro encargado activo.' : 'No se pudo reservar el control de esta sala.';
        render();
        return;
      }
    }
    operatorLockError = '';
    rememberDeviceMode(sessionRole);
    activeRoomId = roomId;
    firebaseReady = true;
    state = roomState;
    localStorage.setItem(localSessionKey(), JSON.stringify(state));
    sessionUnsubscribe = onSnapshot(sessionRef, (next) => {
      const nextRoomState = next.data()?.rooms?.[roomId];
      if (roomId !== activeRoomId || !next.exists() || !nextRoomState) return;
      state = nextRoomState;
      localStorage.setItem(localSessionKey(), JSON.stringify(state));
      if (route() === 'waiter' && updateWaiterInPlace()) return;
      render();
    }, () => notify('La conexión en vivo de esta sala se interrumpió.'));
  } catch (error) {
    console.error(error);
    firebaseReady = false;
    const stored = localStorage.getItem(localSessionKey(roomId));
    if (stored) {
      try { state = JSON.parse(stored); } catch { state = emptyRoomSession(); }
    }
    notify('No se pudo conectar a Firebase. La sala quedó en modo local.');
  }
  render();
  if (currentRole() === 'operator' && firebaseReady) startOperatorLease();
}
async function createRoom() {
  try {
    await initializeFirebaseServices();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const roomId = generateRoomId();
      const roomRef = roomDocument();
      let created = false;
      await runTransaction(firebaseDb, async (transaction) => {
        const existing = await transaction.get(roomRef);
        const rooms = existing.data()?.rooms ?? {};
        if (rooms[roomId]) return;
        const now = Date.now();
        const roomState = { roomId, createdAt: now, updatedAt: now, operatorId: clientDeviceId(), operatorLastSeenAt: now, ...emptyRoomSession() };
        if (existing.exists()) transaction.update(roomRef, { [`rooms.${roomId}`]: roomState });
        else transaction.set(roomRef, { rooms: { [roomId]: roomState } });
        created = true;
      });
      if (!created) continue;
      operatorLockError = '';
      location.hash = `#operator?room=${roomId}`;
      return;
    }
    notify('No se pudo generar un código de sala. Inténtalo nuevamente.');
  } catch (error) {
    console.error(error);
    notify('No se pudo crear la sala. Revisa la conexión de Firebase.');
  }
}
function leaveRoom() {
  void releaseOperatorLock();
  sessionUnsubscribe?.();
  sessionUnsubscribe = null;
  stopOperatorLease();
  activeRoomId = null;
  firebaseReady = false;
  operatorLockError = '';
  state = freshSession();
  location.hash = `#${currentRole()}`;
}
function save(next) {
  state = next;
  localStorage.setItem(localSessionKey(), JSON.stringify(state));
  render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!firebaseReady || !activeRoomId) return;
    try {
      await updateDoc(sessionDocument(), { [`rooms.${activeRoomId}`]: { ...state, updatedAt: Date.now() } });
    } catch (error) {
      console.error(error);
      notify('No se pudo sincronizar el cambio con Firebase.');
    }
  }, 120);
}
function nav(active, display = false) {
  if (display) return `<header class="display-top"><a class="brand" href="${roomHref('display')}">${logoMarkup('brand-logo')}</a><span class="top-meta"><span class="live-dot"></span>${icon('mic_external_on')} SALA ${escapeHtml(activeRoomId ?? '')} · EN VIVO</span><span class="muted">${new Date().toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit'})}</span></header>`;
  const operatorLink = canAccessOperator() ? `<a class="${active === 'operator' ? 'active' : ''}" href="${roomHref('operator')}">${icon('queue_music')}<span>Encargado</span><span id="queue-count">${state.queue.length}</span></a>` : '';
  return `<header class="topbar"><a class="brand" href="${roomHref('waiter')}">${logoMarkup('brand-logo')}</a><span class="top-meta"><span class="live-dot"></span>Sala ${escapeHtml(activeRoomId ?? '')} · Firebase ${firebaseReady ? 'activo' : 'local'}</span><div class="top-actions"><a class="room-switch" href="#${active}">${icon('logout')}<span>Cambiar sala</span></a></div></header><nav class="nav"><a class="${active === 'waiter' ? 'active' : ''}" href="${roomHref('waiter')}">${icon('person')}<span>Mesero</span></a>${operatorLink}</nav>`;
}
function roomCodeForm() {
  return `<div class="room-access-divider" aria-hidden="true"><span>o escribe el código</span></div><form id="join-room-form" class="room-join-form"><label for="room-code-input">Código de sala</label><div class="room-join-controls"><input id="room-code-input" class="input" maxlength="${ROOM_ID_LENGTH}" inputmode="text" autocapitalize="characters" autocomplete="off" placeholder="Ej. D7B3HL" aria-describedby="room-code-hint"/><button class="button" type="submit">${icon('login')}Entrar</button></div><small id="room-code-hint">Usa las ${ROOM_ID_LENGTH} letras o números que aparecen en el enlace de la sala.</small></form>`;
}
function roomAccessView() {
  const role = currentRole();
  const lockMessage = operatorLockError && role === 'operator' ? `<div class="error room-lock-error" role="alert">${escapeHtml(operatorLockError)} Puedes crear una sala nueva.</div>` : '';
  const isOperator = role === 'operator';
  const roleName = role === 'display' ? 'pantalla' : role === 'waiter' ? 'mesero' : 'encargado';
  const title = isOperator ? 'Prepara tu escenario' : 'Conecta con tu sala';
  const description = isOperator ? 'Crea una sala para coordinar canciones, mesas y reproducción desde un solo lugar.' : `Ingresa el código de 6 caracteres que te comparte el encargado para conectar tu ${roleName}.`;
  const action = role === 'operator'
    ? `<button id="create-room-button" class="button room-create">${icon('add_circle')}Crear sala automáticamente</button><small class="room-hint">Muxo generará un código único para compartirlo con tu equipo.</small>${roomCodeForm()}`
    : roomCodeForm();
  return `<div class="room-gate"><div class="room-gate-card"><div class="room-gate-brand">${logoMarkup('room-logo')}</div><div class="room-pairing-layout"><div class="room-pairing-mark"><span class="room-pairing-ring"></span>${icon(role === 'operator' ? 'queue_music' : role === 'display' ? 'tv' : 'person')}</div><div class="room-pairing-copy"><div class="eyebrow">${icon(role === 'operator' ? 'queue_music' : role === 'display' ? 'tv' : 'person')} ACCESO DE ${escapeHtml(roleLabel(role).toUpperCase())}</div><h1>${title}</h1><p>${description}</p></div></div>${roleSwitchMarkup(role)}${lockMessage}${action}</div></div>`;
}
function waiterView() {
  return `<div class="shell">${nav('waiter')}<main class="page waiter-page"><section class="waiter-search-hero"><div class="eyebrow">MESA DE OPERACIÓN</div><h1>Encuentra tu canción</h1><p>Busca una versión de karaoke y agrégala al turno de la mesa.</p><div class="search waiter-search"><label class="sr-only" for="search-input">Artista o canción</label><input id="search-input" class="input" value="${escapeHtml(searchState.query)}" placeholder="Artista o canción…" autocomplete="off"/><button id="search-button" class="button">${icon('search')}<span>Buscar</span></button></div><div id="search-error" role="status" aria-live="polite"></div></section><div class="waiter-summary"><span class="badge">${icon('queue_music')}${state.queue.length} en cola</span><span class="muted">Resultados de YouTube</span></div><section id="results" class="results"></section><div id="selection"></div></main></div>`;
}
function youtubeSearchItemToSong(item, isPriority = false) {
  const snippet = item.snippet ?? {};
  const videoId = typeof item.id === 'string' ? item.id : item.id?.videoId;
  return {
    id: videoId,
    title: snippet.title ?? 'Video sin título',
    description: snippet.description ?? '',
    channelTitle: snippet.channelTitle ?? '',
    thumbnail: snippet.thumbnails?.medium?.url ?? snippet.thumbnails?.default?.url ?? '',
    isPriority,
  };
}
function loadResultsPage({ pageToken = '', pageNumber = 1 } = {}) {
  return searchState.mode === 'recommendations'
    ? loadRecommendedVideos({ pageToken, pageNumber })
    : searchYoutube({ pageToken, pageNumber });
}
function renderResults(results) {
  const node = document.querySelector('#results');
  if (!node) return;
  if (!results.length) {
    node.innerHTML = searchState.mode === 'recommendations' ? '<div class="empty">Cargando recomendados de Karaoke Entre Panas…</div>' : searchState.query ? '<div class="empty">No encontramos resultados para esta búsqueda.</div>' : '';
    return;
  }
  const firstResult = ((searchState.page - 1) * searchState.pageSize) + 1;
  const lastResult = firstResult + results.length - 1;
  const total = searchState.totalResults ? ` de ${searchState.totalResults.toLocaleString('es-PE')}` : '';
  const resultsLabel = searchState.mode === 'recommendations' ? `Recomendados · ${PRIORITY_CHANNEL_NAME}` : 'Resultados de búsqueda';
  node.innerHTML = `<div class="results-toolbar"><div><strong>${escapeHtml(resultsLabel)}</strong><span class="muted"> · ${firstResult}–${lastResult}${total} · Página ${searchState.page}</span></div><label class="page-size">Mostrar <select id="page-size"><option value="10" ${searchState.pageSize === 10 ? 'selected' : ''}>10</option><option value="20" ${searchState.pageSize === 20 ? 'selected' : ''}>20</option><option value="50" ${searchState.pageSize === 50 ? 'selected' : ''}>50</option></select></label></div><div class="results-grid">${results.map((song) => `<article class="song card"><img src="${escapeHtml(song.thumbnail)}" alt="" loading="lazy"/><div class="song-info">${song.isPriority ? `<span class="priority-channel">${icon('star')}RECOMENDADO · ${escapeHtml(PRIORITY_CHANNEL_NAME)}</span>` : ''}<div class="song-title">${escapeHtml(song.title)}</div><div class="song-channel">${escapeHtml(song.channelTitle)}</div><button class="button secondary choose-song" data-song="${escapeHtml(JSON.stringify(song))}">${icon('playlist_add')}Elegir</button></div></article>`).join('')}</div><div class="results-pagination"><button id="previous-page" class="button secondary" ${searchState.prevPageToken ? '' : 'disabled'}>${icon('chevron_left')}Anterior</button><span class="muted">Página ${searchState.page}</span><button id="next-page" class="button secondary" ${searchState.nextPageToken ? '' : 'disabled'}>Siguiente${icon('chevron_right')}</button></div>`;
  node.querySelectorAll('.choose-song').forEach((button) => button.addEventListener('click', () => openSongModal(JSON.parse(button.dataset.song))));
  node.querySelector('#page-size')?.addEventListener('change', (event) => {
    searchState.pageSize = Number(event.target.value);
    loadResultsPage({ pageToken: '', pageNumber: 1 });
  });
  node.querySelector('#previous-page')?.addEventListener('click', () => loadResultsPage({ pageToken: searchState.prevPageToken, pageNumber: Math.max(1, searchState.page - 1) }));
  node.querySelector('#next-page')?.addEventListener('click', () => loadResultsPage({ pageToken: searchState.nextPageToken, pageNumber: searchState.page + 1 }));
}
function formatIsoDuration(value) {
  const match = String(value ?? '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  if (!match) return 'Duración no disponible';
  return `Duración ${formatTime((Number(match[1]) || 0) * 3600 + (Number(match[2]) || 0) * 60 + (Number(match[3]) || 0))}`;
}
function formatSelectedTable(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= MAX_TABLES ? String(numeric).padStart(2, '0') : String(value || '');
}
function tableOptionsMarkup() {
  return Array.from({ length: MAX_TABLES }, (_, index) => {
    const tableNumber = String(index + 1).padStart(2, '0');
    return `<button type="button" class="table-choice ${selectedTableNumber === String(index + 1) ? 'selected' : ''}" data-table="${index + 1}">${tableNumber}</button>`;
  }).join('');
}
function syncSelectionModal() {
  document.querySelectorAll('.table-choice').forEach((button) => button.classList.toggle('selected', button.dataset.table === selectedTableNumber));
  const label = document.querySelector('#selected-table-label');
  if (label) label.textContent = selectedTableNumber ? `Mesa ${formatSelectedTable(selectedTableNumber)}` : 'Elige una mesa';
  const addButton = document.querySelector('#add-button');
  if (addButton) addButton.disabled = !selectedTableNumber;
}
function openSongModal(song) {
  selectedSong = { ...song, durationLabel: 'Consultando duración…' };
  selectedTableNumber = '';
  selectedSingerName = '';
  renderSelection();
  youtubeRequest('videos', { part: 'contentDetails,snippet', id: song.id, key: YOUTUBE_API_KEY })
    .then((data) => {
      const details = data.items?.[0];
      if (!details || selectedSong?.id !== song.id) return;
      selectedSong = { ...selectedSong, durationLabel: formatIsoDuration(details.contentDetails?.duration), description: details.snippet?.description || selectedSong.description };
      renderSelection();
    })
    .catch(() => {
      if (selectedSong?.id !== song.id) return;
      selectedSong = { ...selectedSong, durationLabel: 'Duración no disponible' };
      renderSelection();
    });
}
function renderSelection() {
  const node = document.querySelector('#selection');
  if (!node) return;
  document.removeEventListener('keydown', selectionKeydownHandler);
  selectionKeydownHandler = null;
  if (!selectedSong) { node.innerHTML = ''; return; }
  node.innerHTML = `<div class="modal-backdrop" id="song-modal" role="dialog" aria-modal="true" aria-labelledby="song-modal-title"><section class="song-modal card"><button id="close-song-modal" class="icon-button modal-close" aria-label="Cerrar selección">${icon('close')}</button><div class="song-modal-head"><img src="${escapeHtml(selectedSong.thumbnail)}" alt=""/><div><div class="eyebrow">CANCIÓN ELEGIDA</div><h2 id="song-modal-title">${escapeHtml(selectedSong.title)}</h2><div class="song-channel">${escapeHtml(selectedSong.channelTitle)}</div><div class="song-modal-duration">${escapeHtml(selectedSong.durationLabel || 'Duración no disponible')}</div></div></div><div class="song-modal-body"><div class="table-picker"><div class="modal-section-head"><div><div class="eyebrow">ASIGNA LA MESA</div><h3>Selecciona una mesa · 01–20</h3></div><span id="selected-table-label" class="table-status">${selectedTableNumber ? `Mesa ${formatSelectedTable(selectedTableNumber)}` : 'Elige una mesa'}</span></div><div class="table-grid">${tableOptionsMarkup()}</div></div><div class="singer-picker"><div class="eyebrow">DATOS DEL TURNO</div><h3>¿Quién va a cantar?</h3><input id="singer-input" class="input" placeholder="Nombre del cantante (opcional)" value="${escapeHtml(selectedSingerName)}"/><p class="song-description">${escapeHtml(selectedSong.description || 'Sin descripción disponible.')}</p><button id="add-button" class="button" ${selectedTableNumber ? '' : 'disabled'}>${icon('playlist_add')}Agregar a la cola</button></div></div></section></div>`;
  selectionKeydownHandler = (event) => {
    if (event.key !== 'Escape') return;
    selectedSong = null;
    renderSelection();
  };
  document.addEventListener('keydown', selectionKeydownHandler);
  requestAnimationFrame(() => document.querySelector('#song-modal .table-choice, #song-modal #close-song-modal')?.focus());
  node.querySelector('#close-song-modal')?.addEventListener('click', () => { selectedSong = null; renderSelection(); });
  node.querySelector('#song-modal')?.addEventListener('click', (event) => { if (event.target.id === 'song-modal') { selectedSong = null; renderSelection(); } });
  node.querySelectorAll('.table-choice').forEach((button) => button.addEventListener('click', () => { selectedTableNumber = button.dataset.table; syncSelectionModal(); }));
  node.querySelector('#singer-input')?.addEventListener('input', (event) => { selectedSingerName = event.target.value; });
  node.querySelector('#add-button')?.addEventListener('click', () => {
    const tableNumber = selectedTableNumber.trim();
    if (!tableNumber) return notify('Selecciona una mesa para continuar.');
    const numericTable = Number(tableNumber);
    if (!Number.isInteger(numericTable) || numericTable < 1 || numericTable > MAX_TABLES) return notify(`Selecciona una mesa del 01 al ${String(MAX_TABLES).padStart(2, '0')}.`);
    const singerName = selectedSingerName.trim() || 'Invitado';
    save({ ...state, queue: [...state.queue, { id: id(), tableNumber, singerName, songTitle: selectedSong.title, youtubeVideoId: selectedSong.id, thumbnail: selectedSong.thumbnail, channelTitle: selectedSong.channelTitle, status: 'queued', createdAt: Date.now() }] });
    selectedSong = null;
    selectedTableNumber = '';
    selectedSingerName = '';
    renderSelection();
    notify('Canción agregada a la cola.');
  });
}
async function resolvePriorityChannelId() {
  const data = await youtubeRequest('search', { part: 'snippet', type: 'channel', maxResults: '5', q: PRIORITY_CHANNEL_NAME, key: YOUTUBE_API_KEY });
  const priority = normalizeChannelName(PRIORITY_CHANNEL_NAME);
  const channel = (data.items || []).find((item) => normalizeChannelName(item.snippet?.channelTitle || item.snippet?.title).includes(priority)) || data.items?.[0];
  const channelId = channel?.id?.channelId;
  if (!channelId) throw new Error(`No se encontró el canal ${PRIORITY_CHANNEL_NAME}.`);
  return channelId;
}
async function loadRecommendedVideos({ pageToken = '', pageNumber = 1 } = {}) {
  if (recommendationsLoading) return;
  recommendationsLoading = true;
  const error = document.querySelector('#search-error');
  if (error) error.innerHTML = '';
  try {
    const channelId = searchState.channelId || await resolvePriorityChannelId();
    if (searchState.mode === 'search' && searchState.query) return;
    const params = { part: 'snippet', channelId, type: 'video', order: 'date', maxResults: String(searchState.pageSize), videoEmbeddable: 'true', videoSyndicated: 'true', key: YOUTUBE_API_KEY };
    if (pageToken) params.pageToken = pageToken;
    const data = await youtubeRequest('search', params);
    if (searchState.mode === 'search' && searchState.query) return;
    const results = (data.items || []).map((item) => youtubeSearchItemToSong(item, true)).filter((song) => song.id);
    searchState = { ...searchState, mode: 'recommendations', channelId, query: '', page: pageNumber, nextPageToken: data.nextPageToken || null, prevPageToken: data.prevPageToken || null, totalResults: data.pageInfo?.totalResults || 0, results };
    renderResults(results);
  } catch (err) {
    const node = document.querySelector('#results');
    if (node) node.innerHTML = `<div class="empty">No pudimos cargar los recomendados de ${escapeHtml(PRIORITY_CHANNEL_NAME)}.</div>`;
    if (error) error.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
  } finally {
    recommendationsLoading = false;
  }
}
async function searchYoutube({ pageToken = '', pageNumber = 1 } = {}) {
  const input = document.querySelector('#search-input'); const button = document.querySelector('#search-button'); const error = document.querySelector('#search-error');
  const query = input.value.trim() || searchState.query; if (!query) return notify('Escribe una canción o artista.');
  searchState = { ...searchState, query, mode: 'search', page: pageNumber, nextPageToken: null, prevPageToken: null, totalResults: 0, results: [] };
  button.disabled = true; button.textContent = 'Buscando…'; error.innerHTML = '';
  try {
    const params = new URLSearchParams({ part:'snippet', type:'video', maxResults:String(searchState.pageSize), videoEmbeddable:'true', videoSyndicated:'true', q:`${query} karaoke`, key:YOUTUBE_API_KEY });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await youtubeRequest('search', params);
    const results = prioritizeSearchResults((data.items || []).map((item) => youtubeSearchItemToSong(item, normalizeChannelName(item.snippet?.channelTitle).includes(normalizeChannelName(PRIORITY_CHANNEL_NAME)))).filter((song) => song.id));
    searchState = { ...searchState, nextPageToken: data.nextPageToken || null, prevPageToken: data.prevPageToken || null, totalResults: data.pageInfo?.totalResults || 0, results };
    renderResults(results);
  } catch (err) { error.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`; }
  finally { button.disabled = false; button.textContent = 'Buscar'; }
}
function operatorView() {
  const current = state.nowPlaying;
  const position = Number(playbackState().position) || 0;
  const duration = Number(playbackState().duration) || 0;
  const progress = duration > 0 ? Math.max(0, Math.min(100, (position / duration) * 100)) : 0;
  return `<div class="shell">${nav('operator')}<main class="page"><div class="page-head"><div><div class="eyebrow">CENTRAL DEL ENCARGADO</div><h1>La cola de esta noche</h1><p>Controla el ritmo del show. Solo el encargado puede avanzar el turno.</p></div><div class="page-head-actions"><span class="room-code-display"><span class="room-code-label">CÓDIGO DE SALA</span><strong>${escapeHtml(activeRoomId ?? '')}</strong></span><span class="badge">${icon('queue_music')}${state.queue.length} turnos pendientes</span></div></div><div class="operator-grid"><section class="card now-card">${current ? `<div><div class="now-track"><img class="now-art" src="${escapeHtml(current.thumbnail)}" alt=""/><div class="now-track-copy"><div class="eyebrow">${icon('mic_external_on')} AHORA CANTA <span class="play-status">${icon(playbackState().command?.action === 'pause' ? 'pause_circle' : 'play_circle')} ${playbackLabel()}</span></div><h2>${escapeHtml(current.singerName)}</h2><div class="song-name">${escapeHtml(current.songTitle)}</div></div></div><div class="playback-controls"><button id="pause-button" class="button secondary icon-action" title="Pausar" aria-label="Pausar">${icon('pause')}<span>Pausar</span></button><button id="play-button" class="button secondary icon-action" title="Reproducir" aria-label="Reproducir">${icon('play_arrow')}<span>Reproducir</span></button><button id="restart-button" class="button secondary icon-action" title="Reproducir desde cero" aria-label="Reproducir desde cero">${icon('restart_alt')}<span>Desde cero</span></button><div class="volume-control"><button id="volume-down-button" class="icon-button" title="Bajar volumen" aria-label="Bajar volumen">${icon('volume_down')}</button><span id="volume-label">Volumen ${playbackVolume()}%</span><button id="volume-up-button" class="icon-button" title="Subir volumen" aria-label="Subir volumen">${icon('volume_up')}</button></div></div><div class="playback-progress"><div class="progress-meta"><span>${formatTime(position)}</span><span>${duration > 0 ? `-${formatTime(Math.max(0, duration - position))}` : '--:--'}</span></div><div class="progress-track" role="progressbar" aria-label="Progreso de la canción" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progress)}"><span style="width:${progress}%"></span></div></div></div><div class="now-bottom"><span class="table-pill">${icon('table_restaurant')}MESA ${escapeHtml(current.tableNumber)}</span><div class="toolbar"><button id="absent-button" class="button secondary icon-action" title="Marcar como ausente" aria-label="Marcar como ausente">${icon('person_off')}<span>No está</span></button><button id="next-button" class="button icon-action" title="Reproducir siguiente" aria-label="Reproducir siguiente">${icon('skip_next')}<span>Siguiente</span></button></div></div>` : `<div><div class="eyebrow">TURNO ACTUAL</div><h2>Listo para el próximo turno</h2><div class="song-name">La pantalla mostrará la siguiente canción cuando avances.</div></div><div class="now-bottom"><span class="table-pill">${icon('table_restaurant')}${state.queue.length} EN ESPERA</span><button id="next-button" class="button icon-action" title="Reproducir siguiente" aria-label="Reproducir siguiente">${icon('skip_next')}<span>Reproducir siguiente</span></button></div>`}</section><section class="card queue-card"><div class="section-title"><h2>${icon('queue_music')}Próximos turnos</h2><span class="muted">${state.queue.length}</span></div><div id="queue-list">${queueRows()}</div></section></div></main><a class="display-launch-button" href="${roomHref('display')}">${icon('tv')}<span>Abrir visualización</span></a></div>`;
}
function queueRows() { return state.queue.length ? state.queue.map((request,index) => `<div class="queue-row" draggable="true" data-queue-id="${request.id}" title="Arrastra para reordenar"><span class="queue-number">${String(index+1).padStart(2,'0')}</span><img class="queue-thumb" src="${escapeHtml(request.thumbnail)}" alt="" loading="lazy"/><div><div class="queue-title">${escapeHtml(request.songTitle)}</div><div class="queue-meta">${escapeHtml(request.singerName)} · ${icon('table_restaurant')} Mesa ${escapeHtml(request.tableNumber)}</div></div><div class="row-actions"><span class="drag-handle" aria-hidden="true">${icon('drag_indicator')}</span><button class="icon-button danger remove" title="Quitar de la cola" aria-label="Quitar de la cola" data-id="${request.id}">${icon('delete')}</button></div></div>`).join('') : '<div class="empty">No hay canciones en espera.</div>'; }
function captureWaiterFormState() {
  const fields = ['search-input', 'table-input', 'singer-input'];
  const activeElement = document.activeElement;
  return fields.reduce((snapshot, fieldId) => {
    const field = document.querySelector(`#${fieldId}`);
    if (!field) return snapshot;
    snapshot[fieldId] = {
      value: field.value,
      focused: field === activeElement,
      selectionStart: field.selectionStart,
      selectionEnd: field.selectionEnd,
    };
    return snapshot;
  }, {});
}
function restoreWaiterFormState(snapshot) {
  Object.entries(snapshot ?? {}).forEach(([fieldId, fieldState]) => {
    const field = document.querySelector(`#${fieldId}`);
    if (!field) return;
    field.value = fieldState.value;
    if (!fieldState.focused) return;
    field.focus();
    if (typeof field.setSelectionRange === 'function' && fieldState.selectionStart !== null && fieldState.selectionEnd !== null) {
      field.setSelectionRange(fieldState.selectionStart, fieldState.selectionEnd);
    }
  });
}
function reorderQueue(draggedId, targetId) {
  if (!draggedId || !targetId || draggedId === targetId) return;
  const from = state.queue.findIndex((item) => item.id === draggedId);
  const to = state.queue.findIndex((item) => item.id === targetId);
  if (from < 0 || to < 0) return;
  const queue = [...state.queue];
  const [moved] = queue.splice(from, 1);
  queue.splice(to, 0, moved);
  save({ ...state, queue });
}
function bindQueueDragAndDrop() {
  const rows = [...document.querySelectorAll('.queue-row')];
  let pointerDrag = null;
  const clearDragState = () => rows.forEach((row) => row.classList.remove('dragging', 'drag-over'));
  rows.forEach((row) => {
    row.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('text/plain', row.dataset.queueId);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', clearDragState);
    row.addEventListener('dragover', (event) => { event.preventDefault(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      reorderQueue(event.dataTransfer?.getData('text/plain'), row.dataset.queueId);
      clearDragState();
    });
    row.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' || event.target.closest('button')) return;
      pointerDrag = { row, startY: event.clientY, target: null, moved: false };
      row.setPointerCapture?.(event.pointerId);
    });
    row.addEventListener('pointermove', (event) => {
      if (!pointerDrag || pointerDrag.row !== row) return;
      if (!pointerDrag.moved && Math.abs(event.clientY - pointerDrag.startY) < 8) return;
      pointerDrag.moved = true;
      row.classList.add('dragging');
      const target = rows.find((candidate) => candidate !== row && event.clientY < candidate.getBoundingClientRect().top + candidate.getBoundingClientRect().height / 2);
      rows.forEach((candidate) => candidate.classList.remove('drag-over'));
      pointerDrag.target = target ?? rows.at(-1);
      pointerDrag.target?.classList.add('drag-over');
    });
    row.addEventListener('pointerup', (event) => {
      if (!pointerDrag || pointerDrag.row !== row) return;
      if (pointerDrag.moved) reorderQueue(row.dataset.queueId, pointerDrag.target?.dataset.queueId);
      pointerDrag = null;
      clearDragState();
      row.releasePointerCapture?.(event.pointerId);
    });
    row.addEventListener('pointercancel', () => { pointerDrag = null; clearDragState(); });
  });
}
async function advanceQueue(expectedVideoId = null) {
  if (firebaseReady) {
    try {
      await runTransaction(firebaseDb, async (transaction) => {
        const snapshot = await transaction.get(sessionDocument());
        const live = snapshot.data()?.rooms?.[activeRoomId] ?? state;
        if (expectedVideoId && live.nowPlaying?.youtubeVideoId !== expectedVideoId) return;
        const [next, ...rest] = live.queue ?? [];
        const recent = live.nowPlaying ? [{ ...live.nowPlaying, status: 'finished' }, ...(live.recent ?? [])].slice(0, 8) : (live.recent ?? []);
        const volume = Number(live.playback?.volume);
        const safeVolume = Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : 100;
        transaction.update(sessionDocument(), {
          [`rooms.${activeRoomId}`]: {
          ...live,
          nowPlaying: next ? { ...next, status: 'playing' } : null,
          queue: rest,
          recent,
          playback: { ...(live.playback ?? {}), volume: safeVolume, position: 0, duration: 0, videoId: next?.youtubeVideoId ?? null, command: { id: id(), action: next ? 'play' : 'pause', volume: safeVolume, createdAt: Date.now() } },
          },
        });
      });
      return;
    } catch (error) {
      console.error(error);
      notify('No se pudo avanzar la cola.');
      return;
    }
  }
  const [next, ...rest] = state.queue;
  if (!next && !state.nowPlaying) return notify('La cola está vacía.');
  save({ ...state, nowPlaying: next ? { ...next, status: 'playing' } : null, queue: rest, recent: state.nowPlaying ? [{ ...state.nowPlaying, status: 'finished' }, ...state.recent].slice(0, 8) : state.recent, playback: { ...playbackState(), position: 0, duration: 0, videoId: next?.youtubeVideoId ?? null, command: { id: id(), action: next ? 'play' : 'pause', volume: playbackVolume(), createdAt: Date.now() } } });
}
function bindOperator() {
  document.querySelector('#next-button')?.addEventListener('click', () => advanceQueue(state.nowPlaying?.youtubeVideoId ?? null));
  document.querySelector('#absent-button')?.addEventListener('click', () => { if (!state.nowPlaying) return; save({ ...state, nowPlaying:null, queue:[...state.queue,{...state.nowPlaying,status:'absent'}] }); });
  document.querySelector('#pause-button')?.addEventListener('click', () => sendPlaybackCommand('pause'));
  document.querySelector('#play-button')?.addEventListener('click', () => sendPlaybackCommand('play'));
  document.querySelector('#restart-button')?.addEventListener('click', () => sendPlaybackCommand('restart'));
  document.querySelector('#volume-down-button')?.addEventListener('click', () => sendPlaybackCommand('set-volume', playbackVolume() - 10));
  document.querySelector('#volume-up-button')?.addEventListener('click', () => sendPlaybackCommand('set-volume', playbackVolume() + 10));
  document.querySelectorAll('.remove').forEach((button) => button.addEventListener('click', () => save({ ...state, queue: state.queue.filter((item) => item.id !== button.dataset.id) })));
  bindQueueDragAndDrop();
}
function displayQueueMarkup() {
  return state.queue.slice(0, 4).map((item, index) => `<div class="display-item"><strong>${String(index + 1).padStart(2, '0')} · ${escapeHtml(item.singerName)}</strong><span>${escapeHtml(item.songTitle)}</span><span>${icon('table_restaurant')} Mesa ${escapeHtml(item.tableNumber)}</span></div>`).join('') || '<div class="empty">La próxima canción se está preparando…</div>';
}
function displayVisualizerMarkup() {
  return `<div id="display-edge-visualizer" class="display-edge-visualizer" aria-hidden="true"><span class="edge-ribbon edge-ribbon-top"></span><span class="edge-ribbon edge-ribbon-right"></span><span class="edge-ribbon edge-ribbon-bottom"></span><span class="edge-ribbon edge-ribbon-left"></span><span class="edge-corner edge-corner-tl"></span><span class="edge-corner edge-corner-tr"></span><span class="edge-corner edge-corner-br"></span><span class="edge-corner edge-corner-bl"></span></div>`;
}
function displayIdleLightingMarkup() {
  const lights = Array.from({ length: 8 }, (_, index) => `<span class="idle-light idle-light-${index + 1}"></span>`).join('');
  return `<div class="idle-stage-atmosphere" aria-hidden="true"><div class="idle-stage-wall"></div><div class="idle-beam idle-beam-1"></div><div class="idle-beam idle-beam-2"></div><div class="idle-beam idle-beam-3"></div><div class="idle-light-field">${lights}</div><div class="idle-stage-floor"></div></div>`;
}
function displayView(transition = false) {
  const current = state.nowPlaying;
  const videoId = current?.youtubeVideoId ?? '';
  return `<div class="display" data-video-id="${escapeHtml(videoId)}">${nav('display',true)}<main class="display-main">${current ? `<section class="display-hero display-stage"><div class="video display-video-frame"><iframe id="display-video" src="${youtubeUrl(current.youtubeVideoId, transition ? 0 : 1)}" title="Video karaoke actual" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div><div class="display-copy display-overlay"><div class="eyebrow">${icon('mic_external_on')} AHORA CANTA</div><h1 class="display-table" data-display-table>MESA ${escapeHtml(current.tableNumber)}</h1><div class="display-song text-marquee"><span data-display-song data-marquee-content>${escapeHtml(current.songTitle)}</span></div><div class="display-singer-label">CANTA</div><div class="display-singer" data-display-singer>${escapeHtml(current.singerName)}</div></div><section class="up-next display-next-card"><div class="up-next-head"><div><div class="eyebrow">${icon('queue_music')} A CONTINUACIÓN</div><h2>Próximas voces</h2></div><span class="muted" data-display-count>${state.queue.length} turnos</span></div><div class="display-queue" data-display-queue>${displayQueueMarkup()}</div></section></section>` : `<section class="idle idle-stage">${displayIdleLightingMarkup()}<div class="idle-copy"><div class="eyebrow">✦ MUXO KARAOKE</div><h1>El escenario es tuyo</h1><p>La próxima voz aparecerá aquí.</p></div></section>`}</main>${displayVisualizerMarkup()}<div id="display-transition" class="display-transition" hidden><div class="transition-card"><div class="transition-record"><div class="record-disc"><span>MUXO</span></div><div class="transition-copy"><div class="eyebrow">${icon('mic_external_on')} PRÓXIMA VOZ</div><h2 class="transition-table" data-transition-table>${current ? `MESA ${escapeHtml(current.tableNumber)}` : ''}</h2><div class="transition-marquee text-marquee"><p data-transition-song data-marquee-content>${escapeHtml(current?.songTitle ?? '')}</p></div><div class="transition-singer-label">CANTA</div><div class="transition-singer" data-transition-singer>${escapeHtml(current?.singerName ?? '')}</div></div></div><div class="transition-side"><div class="transition-brand">${logoMarkup('transition-logo')}</div><p>El escenario es tuyo.</p></div></div></div><div id="display-video-error" class="display-video-error" hidden><div class="display-video-error-card"><div class="display-error-logo">${logoMarkup('error-logo')}</div><p>Espere por favor, estamos seleccionando tu canción.</p></div></div><div id="audio-activation" class="audio-activation" hidden><div class="audio-activation-card"><div class="eyebrow">${icon('volume_up')} AUDIO DEL SHOW</div><h2>Activa el audio de Muxo</h2><p>El navegador bloqueó el inicio automático del sonido. Se habilita una sola vez para esta pantalla.</p><button id="activate-audio" class="button">${icon('play_arrow')} Activar audio</button></div></div></div>`;
}
function updateDisplayInPlace() {
  const display = document.querySelector('.display');
  if (!display) return false;
  const currentVideoId = state.nowPlaying?.youtubeVideoId ?? '';
  if ((display.dataset.videoId ?? '') !== currentVideoId) return false;
  const current = state.nowPlaying;
  if (current) {
    const singer = display.querySelector('[data-display-singer]');
    const song = display.querySelector('[data-display-song]');
    const table = display.querySelector('[data-display-table]');
    if (singer) singer.textContent = current.singerName;
    if (song) song.textContent = current.songTitle;
    if (table) table.textContent = `MESA ${current.tableNumber}`;
  }
  refreshMarquees(display);
  const queue = display.querySelector('[data-display-queue]');
  if (queue) queue.innerHTML = displayQueueMarkup();
  const count = display.querySelector('[data-display-count]');
  if (count) count.textContent = `${state.queue.length} turnos`;
  return true;
}
function updateWaiterInPlace() {
  const waiter = document.querySelector('.shell');
  const searchInput = document.querySelector('#search-input');
  if (!waiter || !searchInput) return false;
  const queueCount = document.querySelector('#queue-count');
  if (queueCount) queueCount.textContent = state.queue.length;
  const badge = document.querySelector('.page-head .badge');
  if (badge) badge.innerHTML = `${icon('queue_music')}${state.queue.length} en cola`;
  return true;
}
function bindRoomAccess() {
  document.querySelector('#create-room-button')?.addEventListener('click', createRoom);
  const form = document.querySelector('#join-room-form');
  const input = document.querySelector('#room-code-input');
  input?.addEventListener('input', () => {
    input.value = normalizeRoomId(input.value);
    input.setCustomValidity('');
  });
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const roomId = normalizeRoomId(input?.value);
    if (roomId.length !== ROOM_ID_LENGTH) {
      input?.setCustomValidity(`Escribe un código de ${ROOM_ID_LENGTH} caracteres.`);
      input?.reportValidity();
      return;
    }
    operatorLockError = '';
    location.hash = `#${currentRole()}?room=${roomId}`;
  });
}
function render() {
  const currentRoute = route();
  if (!activeRoomId) {
    stopPlaybackTelemetry();
    stopDisplayVisualizer();
    stopAnnouncementAudio();
    stopTransitionAmbientAudio();
    clearTimeout(displayTransitionTimer);
    window.speechSynthesis?.cancel();
    displayTransitionActive = false;
    app.innerHTML = roomAccessView();
    bindRoomAccess();
    return;
  }
  const waiterFormState = currentRoute === 'waiter' ? captureWaiterFormState() : null;
  if (currentRoute !== 'display') {
    stopPlaybackTelemetry();
    stopDisplayVisualizer();
    stopAnnouncementAudio();
    stopTransitionAmbientAudio();
    clearTimeout(displayTransitionTimer);
    window.speechSynthesis?.cancel();
    displayTransitionActive = false;
  }
  if (currentRoute === 'display' && updateDisplayInPlace()) {
    if (state.nowPlaying) stopAnnouncementAudio();
    attachDisplayPlayer();
    applyPlaybackCommand(playbackState().command);
    return;
  }
  const previousDisplay = document.querySelector('.display');
  const previousVideoId = previousDisplay?.dataset.videoId ?? '';
  const nextVideoId = state.nowPlaying?.youtubeVideoId ?? '';
  const transition = currentRoute === 'display' && Boolean(previousDisplay && nextVideoId && previousVideoId !== nextVideoId);
  if (currentRoute === 'display' && !state.nowPlaying) stopAnnouncementAudio();
  app.innerHTML = currentRoute === 'operator' ? operatorView() : currentRoute === 'display' ? displayView(transition) : waiterView();
  if (currentRoute === 'waiter') {
    document.querySelector('#search-button')?.addEventListener('click', searchYoutube);
    document.querySelector('#search-input')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') searchYoutube(); });
    renderSelection();
    restoreWaiterFormState(waiterFormState);
    renderResults(searchState.results);
    if (!searchState.results.length && !searchState.query) loadRecommendedVideos();
  }
  if (currentRoute === 'operator') bindOperator();
  if (currentRoute === 'display') {
    if (state.nowPlaying) stopAnnouncementAudio();
    refreshMarquees(document.querySelector('.display'));
    attachDisplayPlayer({ transition });
    if (!transition) applyPlaybackCommand(playbackState().command);
  }
}
async function handleRouteChange() {
  if (redirectUnauthorizedOperator()) return;
  const nextRoomId = roomIdFromLocation();
  if (nextRoomId !== activeRoomId) {
    const previousRoomId = activeRoomId;
    if (previousRoomId) await releaseOperatorLock(previousRoomId);
    activeRoomId = nextRoomId;
    await startRoomSession(nextRoomId);
    return;
  }
  render();
}
window.addEventListener('hashchange', handleRouteChange);
activeRoomId = roomIdFromLocation();
redirectUnauthorizedOperator();
activeRoomId = roomIdFromLocation();
startRoomSession(activeRoomId);
