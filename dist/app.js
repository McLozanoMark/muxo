import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import { getFirestore, doc, getDoc, onSnapshot, setDoc, runTransaction } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';

const YOUTUBE_API_KEY = 'AIzaSyDs31A8sNQqSVESILNKv93qWLxEAq-33E4';
const FIREBASE_CONFIG = { apiKey: 'AIzaSyBwySV_jaJoQcow6u494XH7WkFmMY3eyG0', authDomain: 'muxo-karaoke.firebaseapp.com', projectId: 'muxo-karaoke', storageBucket: 'muxo-karaoke.firebasestorage.app', messagingSenderId: '290765040154', appId: '1:290765040154:web:eb204766dcdc3c58437fa3' };
const SESSION_REF = 'sessions/muxo-main';
const demoQueue = [
  { id: 'demo-1', tableNumber: '7', singerName: 'Diego', songTitle: 'Bohemian Rhapsody — Queen (Karaoke)', youtubeVideoId: 'fJ9rUzIMcZQ', thumbnail: 'https://i.ytimg.com/vi/fJ9rUzIMcZQ/hqdefault.jpg', channelTitle: 'Karaoke Version', status: 'queued', createdAt: Date.now() - 180000 },
  { id: 'demo-2', tableNumber: '3', singerName: 'Andrea', songTitle: 'Smells Like Teen Spirit — Nirvana (Karaoke)', youtubeVideoId: 'hTWKbfoikeg', thumbnail: 'https://i.ytimg.com/vi/hTWKbfoikeg/hqdefault.jpg', channelTitle: 'Sing King Karaoke', status: 'queued', createdAt: Date.now() - 120000 },
  { id: 'demo-3', tableNumber: '18', singerName: 'Luis', songTitle: 'Uptown Funk — Mark Ronson ft. Bruno Mars (Karaoke)', youtubeVideoId: 'OPf0YbXqDm0', thumbnail: 'https://i.ytimg.com/vi/OPf0YbXqDm0/hqdefault.jpg', channelTitle: 'Karaoke Hits', status: 'queued', createdAt: Date.now() - 60000 },
];
const freshSession = () => ({ nowPlaying: null, queue: structuredClone(demoQueue), recent: [] });
const app = document.querySelector('#app');
let state = freshSession();
let selectedSong = null;
let saveTimer = null;
let firebaseDb = null;
let firebaseReady = false;
let displayIframe = null;
let displayPlayer = null;
let youtubeApiPromise = null;
let lastAppliedPlaybackCommandId = null;
let playbackTelemetryTimer = null;
let displayTransitionTimer = null;
let displayTransitionActive = false;
let idleCommercialActive = false;
let displayVideoError = false;
const localKey = 'muxo-pages-session';

function escapeHtml(value) {
  const normalized = String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
  return normalized.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
function icon(name) { return `<span class="material-symbols-rounded" aria-hidden="true">${name}</span>`; }
function route() { return (location.hash.replace('#', '') || 'waiter').split('?')[0]; }
function id() { return crypto.randomUUID?.() || `muxo-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function notify(message) { const node = document.createElement('div'); node.className = 'toast'; node.textContent = message; document.body.append(node); setTimeout(() => node.remove(), 2600); }
function youtubeUrl(videoId, autoplay = 1) { return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=${autoplay}&controls=0&disablekb=1&fs=0&iv_load_policy=3&cc_load_policy=0&playsinline=1&rel=0&modestbranding=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}&widget_referrer=${encodeURIComponent(location.href)}`; }
function playbackState() { return state.playback ?? { volume: 100, command: null }; }
function playbackVolume() { const volume = Number(playbackState().volume); return Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : 100; }
function playbackLabel() { return playbackState().command?.action === 'pause' ? 'Pausado' : 'En reproducción'; }
function formatTime(seconds) { const safe = Math.max(0, Math.floor(Number(seconds) || 0)); return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`; }
function sessionDocument() { return doc(firebaseDb, 'sessions', 'muxo-main'); }
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
    await setDoc(sessionDocument(), { playback }, { merge: true });
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
function stopIdleCommercialLoop() {
  if (!idleCommercialActive) return;
  idleCommercialActive = false;
  window.speechSynthesis?.cancel();
}
function startIdleCommercialLoop() {
  if (idleCommercialActive || state.nowPlaying) return;
  if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return;
  idleCommercialActive = true;
  const commercial = 'Esto es Muxo. Disfruta tus canciones favoritas cantando en Muxo.';
  const speak = () => {
    if (!idleCommercialActive || state.nowPlaying) return;
    const utterance = createSpeechUtterance(commercial);
    utterance.onend = () => setTimeout(speak, 350);
    utterance.onerror = () => setTimeout(speak, 700);
    window.speechSynthesis.speak(utterance);
  };
  speak();
}
function speakDisplayTransition(current) {
  stopIdleCommercialLoop();
  if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
    finishDisplayTransition();
    return;
  }
  window.speechSynthesis.cancel();
  const phrases = [
    { text: 'Esto es Muxo. Disfruta tus canciones favoritas cantando en Muxo.', pauseAfter: 240 },
    { text: `Mesa ${current.tableNumber}.`, pauseAfter: 180 },
    { text: `Canta ${current.singerName}.`, pauseAfter: 180 },
    { text: `El tema ${current.songTitle}.`, pauseAfter: 340 },
    { text: `Mesa ${current.tableNumber}.`, pauseAfter: 180 },
    { text: `Canta ${current.singerName}.`, pauseAfter: 180 },
    { text: `El tema ${current.songTitle}.`, pauseAfter: 340 },
  ];
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
}
function showDisplayVideoError() {
  displayVideoError = true;
  displayTransitionActive = false;
  clearTimeout(displayTransitionTimer);
  displayTransitionTimer = null;
  window.speechSynthesis?.cancel();
  stopIdleCommercialLoop();
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
  stopIdleCommercialLoop();
  postYoutubeCommand('pauseVideo');
  const overlay = document.querySelector('#display-transition');
  if (overlay) {
    overlay.querySelector('[data-transition-singer]').textContent = current.singerName;
    overlay.querySelector('[data-transition-song]').textContent = current.songTitle;
    overlay.querySelector('[data-transition-table]').innerHTML = `${icon('table_restaurant')}MESA ${escapeHtml(current.tableNumber)}`;
    overlay.hidden = false;
  }
  speakDisplayTransition(current);
}
async function attachDisplayPlayer({ transition = false } = {}) {
  const iframe = document.querySelector('#display-video');
  if (!iframe) { stopPlaybackTelemetry(); displayIframe = null; displayPlayer = null; return; }
  if (iframe === displayIframe) return;
  stopPlaybackTelemetry();
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

async function initData() {
  try {
    firebaseDb = getFirestore(initializeApp(FIREBASE_CONFIG));
    firebaseReady = true;
    const sessionRef = doc(firebaseDb, SESSION_REF.split('/')[0], SESSION_REF.split('/')[1]);
    const snapshot = await getDoc(sessionRef);
    if (!snapshot.exists()) await setDoc(sessionRef, state);
    onSnapshot(sessionRef, (next) => {
      if (!next.exists()) return;
      state = next.data();
      if (route() === 'waiter' && updateWaiterInPlace()) return;
      render();
    }, () => notify('La conexión en vivo se interrumpió.'));
  } catch (error) {
    console.error(error);
    const stored = localStorage.getItem(localKey);
    if (stored) { try { state = JSON.parse(stored); } catch { state = freshSession(); } }
    notify('Modo local activo: Firebase no está disponible.');
  }
  render();
}
function save(next) {
  state = next;
  localStorage.setItem(localKey, JSON.stringify(state));
  render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (firebaseReady) await setDoc(doc(firebaseDb, 'sessions', 'muxo-main'), state);
  }, 120);
}
function nav(active, display = false) {
  if (display) return `<header class="display-top"><a class="brand" href="#display"><span class="brand-mark"><i></i><i></i><i></i></span>MUXO</a><span class="top-meta"><span class="live-dot"></span>${icon('mic_external_on')} EN VIVO · LA NOCHE MIRAFLORES</span><span class="muted">${new Date().toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit'})}</span></header>`;
  return `<header class="topbar"><a class="brand" href="#waiter"><span class="brand-mark"><i></i><i></i><i></i></span>MUXO</a><span class="top-meta"><span class="live-dot"></span>Firebase ${firebaseReady ? 'activo' : 'local'}</span></header><nav class="nav"><a class="${active === 'waiter' ? 'active' : ''}" href="#waiter">${icon('person')}<span>Mesero</span></a><a class="${active === 'operator' ? 'active' : ''}" href="#operator">${icon('queue_music')}<span>Encargado</span><span id="queue-count">${state.queue.length}</span></a><a class="${active === 'display' ? 'active' : ''}" href="#display">${icon('tv')}<span>Pantalla TV</span></a></nav>`;
}
function waiterView() {
  return `<div class="shell">${nav('waiter')}<main class="page"><div class="page-head"><div><div class="eyebrow">MESA DE OPERACIÓN</div><h1>Agrega una canción</h1><p>Busca una versión, confirma la mesa y deja que la música siga.</p></div><span class="badge">${icon('queue_music')}${state.queue.length} en cola</span></div><section class="card search-card" style="padding:22px"><div class="eyebrow">BUSCAR EN YOUTUBE</div><div class="search" style="margin-top:12px"><input id="search-input" class="input" placeholder="Artista o canción…"/><button id="search-button" class="button">${icon('search')}<span>Buscar</span></button></div><div id="search-error"></div><div id="results" class="results"></div></section><div id="selection"></div></main></div>`;
}
function renderResults(results) {
  const node = document.querySelector('#results');
  if (!node) return;
  node.innerHTML = results.length ? results.map((song) => `<article class="song card"><img src="${escapeHtml(song.thumbnail)}" alt=""/><div class="song-info"><div class="song-title">${escapeHtml(song.title)}</div><div class="song-channel">${escapeHtml(song.channelTitle)}</div><button class="button secondary choose-song" data-song="${escapeHtml(JSON.stringify(song))}">Elegir</button></div></article>`).join('') : '<div class="empty">No encontramos resultados.</div>';
  node.querySelectorAll('.choose-song').forEach((button) => button.addEventListener('click', () => { selectedSong = JSON.parse(button.dataset.song); renderSelection(); }));
}
function renderSelection() {
  const node = document.querySelector('#selection');
  if (!node) return;
  node.innerHTML = selectedSong ? `<section class="selected card"><img src="${escapeHtml(selectedSong.thumbnail)}" alt=""/><div><div class="eyebrow">CANCIÓN ELEGIDA</div><h2>${escapeHtml(selectedSong.title)}</h2><div class="muted">${escapeHtml(selectedSong.channelTitle)}</div><div class="form-grid"><input id="table-input" class="input" inputmode="numeric" placeholder="Mesa"/><input id="singer-input" class="input" placeholder="Nombre del cantante"/><button id="add-button" class="button">${icon('playlist_add')}<span>Agregar a la cola</span></button></div></div></section>` : '';
  node.querySelector('#add-button')?.addEventListener('click', () => {
    const tableNumber = node.querySelector('#table-input').value.trim();
    const singerName = node.querySelector('#singer-input').value.trim();
    if (!tableNumber || !singerName) return notify('Completa mesa y cantante.');
    save({ ...state, queue: [...state.queue, { id: id(), tableNumber, singerName, songTitle: selectedSong.title, youtubeVideoId: selectedSong.id, thumbnail: selectedSong.thumbnail, channelTitle: selectedSong.channelTitle, status: 'queued', createdAt: Date.now() }] });
    selectedSong = null; renderSelection(); notify('Canción agregada a la cola.');
  });
}
async function searchYoutube() {
  const input = document.querySelector('#search-input'); const button = document.querySelector('#search-button'); const error = document.querySelector('#search-error');
  const query = input.value.trim(); if (!query) return notify('Escribe una canción o artista.');
  button.disabled = true; button.textContent = 'Buscando…'; error.innerHTML = '';
  try {
    const params = new URLSearchParams({ part:'snippet', type:'video', maxResults:'12', videoEmbeddable:'true', videoSyndicated:'true', q:`${query} karaoke`, key:YOUTUBE_API_KEY });
    const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
    if (!response.ok) throw new Error('YouTube no respondió correctamente.');
    const data = await response.json();
    renderResults((data.items || []).map((item) => ({ id:item.id.videoId, title:item.snippet.title, channelTitle:item.snippet.channelTitle, thumbnail:item.snippet.thumbnails.medium.url })));
  } catch (err) { error.innerHTML = `<div class="error">${escapeHtml(err.message)} Revisa la configuración de YouTube.</div>`; }
  finally { button.disabled = false; button.textContent = 'Buscar'; }
}
function operatorView() {
  const current = state.nowPlaying;
  const position = Number(playbackState().position) || 0;
  const duration = Number(playbackState().duration) || 0;
  const progress = duration > 0 ? Math.max(0, Math.min(100, (position / duration) * 100)) : 0;
  return `<div class="shell">${nav('operator')}<main class="page"><div class="page-head"><div><div class="eyebrow">CENTRAL DEL ENCARGADO</div><h1>La cola de esta noche</h1><p>Controla el ritmo del show. Solo el encargado puede avanzar el turno.</p></div><span class="badge">${icon('queue_music')}${state.queue.length} turnos pendientes</span></div><div class="operator-grid"><section class="card now-card">${current ? `<div><div class="now-track"><img class="now-art" src="${escapeHtml(current.thumbnail)}" alt=""/><div class="now-track-copy"><div class="eyebrow">${icon('mic_external_on')} AHORA CANTA <span class="play-status">${icon(playbackState().command?.action === 'pause' ? 'pause_circle' : 'play_circle')} ${playbackLabel()}</span></div><h2>${escapeHtml(current.singerName)}</h2><div class="song-name">${escapeHtml(current.songTitle)}</div></div></div><div class="playback-controls"><button id="pause-button" class="button secondary icon-action" title="Pausar" aria-label="Pausar">${icon('pause')}<span>Pausar</span></button><button id="play-button" class="button secondary icon-action" title="Reproducir" aria-label="Reproducir">${icon('play_arrow')}<span>Reproducir</span></button><button id="restart-button" class="button secondary icon-action" title="Reproducir desde cero" aria-label="Reproducir desde cero">${icon('restart_alt')}<span>Desde cero</span></button><div class="volume-control"><button id="volume-down-button" class="icon-button" title="Bajar volumen" aria-label="Bajar volumen">${icon('volume_down')}</button><span id="volume-label">Volumen ${playbackVolume()}%</span><button id="volume-up-button" class="icon-button" title="Subir volumen" aria-label="Subir volumen">${icon('volume_up')}</button></div></div><div class="playback-progress"><div class="progress-meta"><span>${formatTime(position)}</span><span>${duration > 0 ? `-${formatTime(Math.max(0, duration - position))}` : '--:--'}</span></div><div class="progress-track" role="progressbar" aria-label="Progreso de la canción" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progress)}"><span style="width:${progress}%"></span></div></div></div><div class="now-bottom"><span class="table-pill">${icon('table_restaurant')}MESA ${escapeHtml(current.tableNumber)}</span><div class="toolbar"><button id="absent-button" class="button secondary icon-action" title="Marcar como ausente" aria-label="Marcar como ausente">${icon('person_off')}<span>No está</span></button><button id="next-button" class="button icon-action" title="Reproducir siguiente" aria-label="Reproducir siguiente">${icon('skip_next')}<span>Siguiente</span></button></div></div>` : `<div><div class="eyebrow">TURNO ACTUAL</div><h2>Listo para el próximo turno</h2><div class="song-name">La pantalla mostrará la siguiente canción cuando avances.</div></div><div class="now-bottom"><span class="table-pill">${icon('table_restaurant')}${state.queue.length} EN ESPERA</span><button id="next-button" class="button icon-action" title="Reproducir siguiente" aria-label="Reproducir siguiente">${icon('skip_next')}<span>Reproducir siguiente</span></button></div>`}</section><section class="card queue-card"><div class="section-title"><h2>${icon('queue_music')}Próximos turnos</h2><span class="muted">${state.queue.length}</span></div><div id="queue-list">${queueRows()}</div></section></div></main></div>`;
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
        const live = snapshot.exists() ? snapshot.data() : state;
        if (expectedVideoId && live.nowPlaying?.youtubeVideoId !== expectedVideoId) return;
        const [next, ...rest] = live.queue ?? [];
        const recent = live.nowPlaying ? [{ ...live.nowPlaying, status: 'finished' }, ...(live.recent ?? [])].slice(0, 8) : (live.recent ?? []);
        const volume = Number(live.playback?.volume);
        const safeVolume = Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : 100;
        transaction.set(sessionDocument(), {
          ...live,
          nowPlaying: next ? { ...next, status: 'playing' } : null,
          queue: rest,
          recent,
          playback: { ...(live.playback ?? {}), volume: safeVolume, position: 0, duration: 0, videoId: next?.youtubeVideoId ?? null, command: { id: id(), action: next ? 'play' : 'pause', volume: safeVolume, createdAt: Date.now() } },
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
function displayView(transition = false) {
  const current = state.nowPlaying;
  const videoId = current?.youtubeVideoId ?? '';
  return `<div class="display" data-video-id="${escapeHtml(videoId)}">${nav('display',true)}<main class="display-main">${current ? `<section class="display-hero display-stage"><div class="video display-video-frame"><iframe id="display-video" src="${youtubeUrl(current.youtubeVideoId, transition ? 0 : 1)}" title="Video karaoke actual" allow="autoplay; encrypted-media" referrerpolicy="strict-origin-when-cross-origin"></iframe></div><div class="display-copy display-overlay"><div class="eyebrow">${icon('mic_external_on')} AHORA CANTA</div><h1 data-display-singer>${escapeHtml(current.singerName)}</h1><div class="display-song" data-display-song>${escapeHtml(current.songTitle)}</div><span class="table-pill" data-display-table>${icon('table_restaurant')}MESA ${escapeHtml(current.tableNumber)}</span></div><section class="up-next display-next-card"><div class="up-next-head"><div><div class="eyebrow">${icon('queue_music')} A CONTINUACIÓN</div><h2>Próximas voces</h2></div><span class="muted" data-display-count>${state.queue.length} turnos</span></div><div class="display-queue" data-display-queue>${displayQueueMarkup()}</div></section></section>` : '<section class="idle"><div class="eyebrow">✦ MUXO KARAOKE</div><h1>El escenario es tuyo</h1><p>La próxima voz aparecerá aquí.</p></section>'}</main><div id="display-transition" class="display-transition" hidden><div class="transition-card"><div class="eyebrow">${icon('mic_external_on')} A CONTINUACIÓN</div><div class="transition-brand">MUXO</div><h2 data-transition-singer>${escapeHtml(current?.singerName ?? '')}</h2><p data-transition-song>${escapeHtml(current?.songTitle ?? '')}</p><span class="table-pill" data-transition-table>${current ? `${icon('table_restaurant')}MESA ${escapeHtml(current.tableNumber)}` : ''}</span></div></div><div id="display-video-error" class="display-video-error" hidden><div class="display-video-error-card"><div class="display-error-logo"><span class="brand-mark"><i></i><i></i><i></i></span>MUXO</div><p>Espere por favor, estamos seleccionando tu canción.</p></div></div><div id="audio-activation" class="audio-activation" hidden><div class="audio-activation-card"><div class="eyebrow">${icon('volume_up')} AUDIO DEL SHOW</div><h2>Activa el audio de Muxo</h2><p>El navegador bloqueó el inicio automático del sonido. Se habilita una sola vez para esta pantalla.</p><button id="activate-audio" class="button">${icon('play_arrow')} Activar audio</button></div></div></div>`;
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
    if (table) table.innerHTML = `${icon('table_restaurant')}MESA ${escapeHtml(current.tableNumber)}`;
  }
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
function render() {
  const currentRoute = route();
  const waiterFormState = currentRoute === 'waiter' ? captureWaiterFormState() : null;
  if (currentRoute !== 'display') {
    stopPlaybackTelemetry();
    clearTimeout(displayTransitionTimer);
    window.speechSynthesis?.cancel();
    idleCommercialActive = false;
    displayTransitionActive = false;
  }
  if (currentRoute === 'display' && updateDisplayInPlace()) {
    if (state.nowPlaying) stopIdleCommercialLoop();
    else startIdleCommercialLoop();
    attachDisplayPlayer();
    applyPlaybackCommand(playbackState().command);
    return;
  }
  const previousDisplay = document.querySelector('.display');
  const previousVideoId = previousDisplay?.dataset.videoId ?? '';
  const nextVideoId = state.nowPlaying?.youtubeVideoId ?? '';
  const transition = currentRoute === 'display' && Boolean(previousDisplay && nextVideoId && previousVideoId !== nextVideoId);
  app.innerHTML = currentRoute === 'operator' ? operatorView() : currentRoute === 'display' ? displayView(transition) : waiterView();
  if (currentRoute === 'waiter') {
    document.querySelector('#search-button')?.addEventListener('click', searchYoutube);
    document.querySelector('#search-input')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') searchYoutube(); });
    renderSelection();
    restoreWaiterFormState(waiterFormState);
  }
  if (currentRoute === 'operator') bindOperator();
  if (currentRoute === 'display') {
    if (state.nowPlaying) stopIdleCommercialLoop();
    else startIdleCommercialLoop();
    attachDisplayPlayer({ transition });
    if (!transition) applyPlaybackCommand(playbackState().command);
  }
}
window.addEventListener('hashchange', render);
initData();
