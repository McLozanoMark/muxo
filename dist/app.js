import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import { getFirestore, doc, getDoc, onSnapshot, setDoc } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';

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
const localKey = 'muxo-pages-session';

function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function route() { return (location.hash.replace('#', '') || 'waiter').split('?')[0]; }
function id() { return crypto.randomUUID?.() || `muxo-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function notify(message) { const node = document.createElement('div'); node.className = 'toast'; node.textContent = message; document.body.append(node); setTimeout(() => node.remove(), 2600); }
function youtubeUrl(videoId) { return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=1&controls=1&rel=0&modestbranding=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}&widget_referrer=${encodeURIComponent(location.href)}`; }

async function initData() {
  try {
    firebaseDb = getFirestore(initializeApp(FIREBASE_CONFIG));
    firebaseReady = true;
    const sessionRef = doc(firebaseDb, SESSION_REF.split('/')[0], SESSION_REF.split('/')[1]);
    const snapshot = await getDoc(sessionRef);
    if (!snapshot.exists()) await setDoc(sessionRef, state);
    onSnapshot(sessionRef, (next) => { if (next.exists()) { state = next.data(); render(); } }, () => notify('La conexión en vivo se interrumpió.'));
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
  if (display) return `<header class="display-top"><a class="brand" href="#display"><span class="brand-mark"><i></i><i></i><i></i></span>MUXO</a><span class="top-meta"><span class="live-dot"></span>EN VIVO · LA NOCHE MIRAFLORES</span><span class="muted">${new Date().toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit'})}</span></header>`;
  return `<header class="topbar"><a class="brand" href="#waiter"><span class="brand-mark"><i></i><i></i><i></i></span>MUXO</a><span class="top-meta"><span class="live-dot"></span>Firebase ${firebaseReady ? 'activo' : 'local'}</span></header><nav class="nav"><a class="${active === 'waiter' ? 'active' : ''}" href="#waiter">＋ Mesero</a><a class="${active === 'operator' ? 'active' : ''}" href="#operator">≡ Encargado <span id="queue-count">${state.queue.length}</span></a><a class="${active === 'display' ? 'active' : ''}" href="#display">▣ Pantalla TV</a></nav>`;
}
function waiterView() {
  return `<div class="shell">${nav('waiter')}<main class="page"><div class="page-head"><div><div class="eyebrow">MESA DE OPERACIÓN</div><h1>Agrega una canción</h1><p>Busca una versión, confirma la mesa y deja que la música siga.</p></div><span class="badge">${state.queue.length} en cola</span></div><section class="card" style="padding:22px"><div class="eyebrow">BUSCAR EN YOUTUBE</div><div class="search" style="margin-top:12px"><input id="search-input" class="input" placeholder="Artista o canción…"/><button id="search-button" class="button">Buscar</button></div><div id="search-error"></div><div id="results" class="results"></div></section><div id="selection"></div></main></div>`;
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
  node.innerHTML = selectedSong ? `<section class="selected card"><img src="${escapeHtml(selectedSong.thumbnail)}" alt=""/><div><div class="eyebrow">CANCIÓN ELEGIDA</div><h2>${escapeHtml(selectedSong.title)}</h2><div class="muted">${escapeHtml(selectedSong.channelTitle)}</div><div class="form-grid"><input id="table-input" class="input" inputmode="numeric" placeholder="Mesa"/><input id="singer-input" class="input" placeholder="Nombre del cantante"/><button id="add-button" class="button">＋ Agregar a la cola</button></div></div></section>` : '';
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
  return `<div class="shell">${nav('operator')}<main class="page"><div class="page-head"><div><div class="eyebrow">CENTRAL DEL ENCARGADO</div><h1>La cola de esta noche</h1><p>Controla el ritmo del show. Solo el encargado puede avanzar el turno.</p></div><span class="badge">${state.queue.length} turnos pendientes</span></div><div class="operator-grid"><section class="card now-card">${current ? `<div><div class="eyebrow">AHORA CANTA</div><h2>${escapeHtml(current.singerName)}</h2><div class="song-name">${escapeHtml(current.songTitle)}</div></div><div class="now-bottom"><span class="table-pill">MESA ${escapeHtml(current.tableNumber)}</span><div class="toolbar"><button id="absent-button" class="button secondary">No está</button><button id="next-button" class="button">Siguiente</button></div></div>` : `<div><div class="eyebrow">TURNO ACTUAL</div><h2>Listo para el próximo turno</h2><div class="song-name">La pantalla mostrará la siguiente canción cuando avances.</div></div><div class="now-bottom"><span class="table-pill">${state.queue.length} EN ESPERA</span><button id="next-button" class="button">Reproducir siguiente</button></div>`}</section><section class="card queue-card"><div class="section-title"><h2>Próximos turnos</h2><span class="muted">${state.queue.length}</span></div><div id="queue-list">${queueRows()}</div></section></div></main></div>`;
}
function queueRows() { return state.queue.length ? state.queue.map((request,index) => `<div class="queue-row"><span class="queue-number">${String(index+1).padStart(2,'0')}</span><div><div class="queue-title">${escapeHtml(request.songTitle)}</div><div class="queue-meta">${escapeHtml(request.singerName)} · Mesa ${escapeHtml(request.tableNumber)}</div></div><div class="row-actions"><button class="icon-button up" data-id="${request.id}" ${index === 0 ? 'disabled' : ''}>↑</button><button class="icon-button down" data-id="${request.id}" ${index === state.queue.length-1 ? 'disabled' : ''}>↓</button><button class="icon-button danger remove" data-id="${request.id}">×</button></div></div>`).join('') : '<div class="empty">No hay canciones en espera.</div>'; }
function bindOperator() {
  document.querySelector('#next-button')?.addEventListener('click', () => { const [next,...rest] = state.queue; if (!next) return notify('La cola está vacía.'); save({ ...state, nowPlaying:{...next,status:'playing'}, queue:rest, recent:state.nowPlaying ? [{...state.nowPlaying,status:'finished'},...state.recent].slice(0,8) : state.recent }); });
  document.querySelector('#absent-button')?.addEventListener('click', () => { if (!state.nowPlaying) return; save({ ...state, nowPlaying:null, queue:[...state.queue,{...state.nowPlaying,status:'absent'}] }); });
  document.querySelectorAll('.up,.down,.remove').forEach((button) => button.addEventListener('click', () => { const index = state.queue.findIndex((item) => item.id === button.dataset.id); if (button.classList.contains('remove')) return save({ ...state, queue:state.queue.filter((item) => item.id !== button.dataset.id) }); const target = button.classList.contains('up') ? index-1 : index+1; if (target < 0 || target >= state.queue.length) return; const queue = [...state.queue]; [queue[index],queue[target]] = [queue[target],queue[index]]; save({...state,queue}); }));
}
function displayView() {
  const current = state.nowPlaying;
  return `<div class="display">${nav('display',true)}<main class="display-main">${current ? `<section class="display-hero"><div class="display-copy"><div class="eyebrow">AHORA CANTA</div><h1>${escapeHtml(current.singerName)}</h1><div class="display-song">${escapeHtml(current.songTitle)}</div><span class="table-pill" style="display:inline-block;margin-top:26px">MESA ${escapeHtml(current.tableNumber)}</span></div><div class="video"><iframe src="${youtubeUrl(current.youtubeVideoId)}" title="Video karaoke actual" allow="autoplay; encrypted-media; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div></section><section class="up-next"><div class="up-next-head"><div><div class="eyebrow">A CONTINUACIÓN</div><h2>Próximas voces</h2></div><span class="muted">${state.queue.length} turnos</span></div><div class="display-queue">${state.queue.slice(0,4).map((item,index) => `<div class="display-item"><strong>${String(index+1).padStart(2,'0')} · ${escapeHtml(item.singerName)}</strong><span>${escapeHtml(item.songTitle)}</span><span>Mesa ${escapeHtml(item.tableNumber)}</span></div>`).join('') || '<div class="empty">La próxima canción se está preparando…</div>'}</div></section>` : '<section class="idle"><div class="eyebrow">✦ MUXO KARAOKE</div><h1>El escenario es tuyo</h1><p>La próxima voz aparecerá aquí.</p></section>'}</main></div>`;
}
function render() {
  const currentRoute = route();
  app.innerHTML = currentRoute === 'operator' ? operatorView() : currentRoute === 'display' ? displayView() : waiterView();
  if (currentRoute === 'waiter') { document.querySelector('#search-button')?.addEventListener('click', searchYoutube); document.querySelector('#search-input')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') searchYoutube(); }); renderSelection(); }
  if (currentRoute === 'operator') bindOperator();
}
window.addEventListener('hashchange', render);
initData();
