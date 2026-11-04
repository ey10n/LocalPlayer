import * as db from './db.js?v=__BUILD__';
import { readTags } from './id3.js?v=__BUILD__';

// GitHub Actions でのデプロイ時にコミットIDへ置き換わる（.github/workflows/pages.yml）
const BUILD = '__BUILD__';

const LIBRARY = 'library';
const $ = (sel) => document.querySelector(sel);
const audio = $('#audio');
const seek = $('#seek');

const state = {
  tracks: new Map(),   // 曲ID -> メタ情報（追加順）
  playlists: [],       // {id, name, trackIds, createdAt}
  viewId: LIBRARY,     // 表示中のリスト
  editing: false,
  queueSource: null,   // 再生中のリスト（ライブラリ or プレイリストID）
  queue: [],           // 再生対象の曲ID
  order: [],           // queue のインデックスの再生順（シャッフル時はランダム）
  pos: -1,             // order 上の現在位置
  shuffle: false,
  repeat: 'off',       // off | all | one
};

// 曲ID -> object URL。再生開始を同期的に行えるよう、起動時にすべて用意しておく。
// （iOS はユーザー操作から非同期処理を挟むと play() を拒否することがあり、
//   ロック中の曲送りでも待ち時間なく次の曲へ切り替えたいため）
const urls = new Map();
const artUrls = new Map();
const artDataUrls = new Map();

let pendingSeek = 0;
let seeking = false;
let lastSave = 0;
let errorStreak = 0;
let toastTimer;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const titleOf = (t) => t.title || t.fileName.replace(/\.mp3$/i, '');
const playlistById = (id) => state.playlists.find((p) => p.id === id);
const idsOf = (source) => (source === LIBRARY ? [...state.tracks.keys()] : playlistById(source)?.trackIds ?? []);
const currentId = () => (state.pos >= 0 ? state.queue[state.order[state.pos]] : null);

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function artUrl(t) {
  if (!t?.art) return null;
  if (!artUrls.has(t.id)) artUrls.set(t.id, URL.createObjectURL(t.art));
  return artUrls.get(t.id);
}

// ロック画面のアートワークは blob: URL だと表示されない環境があるため data: URL を使う
function artDataUrl(t) {
  if (!artDataUrls.has(t.id)) {
    artDataUrls.set(t.id, new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(t.art);
    }));
  }
  return artDataUrls.get(t.id);
}

function toast(msg, ms = 2500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ---------------------------------------------------------------- 再生制御

function makeOrder(n, first) {
  const order = [...Array(n).keys()];
  if (!state.shuffle) return order;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  if (first >= 0) {
    order.splice(order.indexOf(first), 1);
    order.unshift(first);
  }
  return order;
}

function playAt(pos, autoplay = true, startAt = 0) {
  state.pos = pos;
  audio.src = urls.get(currentId());
  pendingSeek = startAt;
  if (autoplay) audio.play().catch((e) => console.warn(e));
  updateNowPlaying();
  renderList();
  saveState();
}

function startQueue(source, ids, index) {
  const id = ids[index];
  state.queueSource = source;
  state.queue = ids.filter((x) => urls.has(x));
  const i = state.queue.indexOf(id);
  if (i < 0) return toast('この曲のデータが見つかりません');
  state.order = makeOrder(state.queue.length, i);
  playAt(state.shuffle ? 0 : i);
}

function stop() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  state.pos = -1;
  updateNowPlaying();
}

function togglePlay() {
  if (currentId() == null) {
    const ids = idsOf(state.viewId);
    if (ids.length) startQueue(state.viewId, ids, 0);
    return;
  }
  if (audio.paused) audio.play().catch((e) => console.warn(e));
  else audio.pause();
}

function next(auto = false) {
  if (!state.queue.length) return;
  let p = state.pos + 1;
  if (p >= state.order.length) {
    if (state.shuffle) state.order = makeOrder(state.queue.length, -1);
    p = 0;
    // リピートなしで最後まで再生したら先頭に戻して停止
    if (auto && state.repeat === 'off') return playAt(0, false);
  }
  playAt(p, auto || !audio.paused);
}

function prev() {
  if (!state.queue.length) return;
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  playAt(state.pos > 0 ? state.pos - 1 : state.order.length - 1, !audio.paused);
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  if (state.queue.length) {
    const idx = state.pos >= 0 ? state.order[state.pos] : -1;
    state.order = makeOrder(state.queue.length, idx);
    if (idx >= 0) state.pos = state.shuffle ? 0 : idx;
  }
  renderControls();
  saveState();
}

function cycleRepeat() {
  state.repeat = { off: 'all', all: 'one', one: 'off' }[state.repeat];
  audio.loop = state.repeat === 'one';
  renderControls();
  saveState();
}

// 再生中のリストが編集されたとき、キューを作り直す
function syncQueue() {
  if (state.queueSource == null) return;
  const cur = currentId();
  state.queue = idsOf(state.queueSource).filter((x) => urls.has(x));
  const i = state.queue.indexOf(cur);
  state.order = makeOrder(state.queue.length, i);
  if (cur != null && i < 0) stop();
  else if (i >= 0) state.pos = state.shuffle ? 0 : i;
  saveState();
}

function saveState() {
  lastSave = Date.now();
  const s = {
    viewId: state.viewId,
    queueSource: state.queueSource,
    queue: state.queue,
    order: state.order,
    currentId: currentId(),
    time: audio.readyState ? audio.currentTime : pendingSeek,
    shuffle: state.shuffle,
    repeat: state.repeat,
  };
  db.put('settings', s, 'state').catch(() => {});
}

function restoreState(s) {
  if (!s) return;
  state.shuffle = !!s.shuffle;
  state.repeat = s.repeat || 'off';
  audio.loop = state.repeat === 'one';
  if (s.viewId === LIBRARY || playlistById(s.viewId)) state.viewId = s.viewId;

  const queue = (s.queue || []).filter((id) => urls.has(id));
  if (!queue.length) return;
  state.queueSource = s.queueSource;
  state.queue = queue;
  state.order = s.order?.length === queue.length ? s.order : queue.map((_, i) => i);
  const idx = queue.indexOf(s.currentId);
  if (idx >= 0) playAt(state.order.indexOf(idx), false, s.time || 0);
}

// ---------------------------------------------------------------- Media Session（ロック画面・通知の操作）

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const handlers = {
    play: togglePlay,
    pause: () => audio.pause(),
    stop: () => audio.pause(),
    previoustrack: prev,
    nexttrack: () => next(),
    seekto: (d) => {
      audio.currentTime = d.seekTime;
      updatePositionState();
    },
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch { /* 未対応のアクション */ }
  }
}

function updatePositionState() {
  if (!navigator.mediaSession?.setPositionState) return;
  const d = audio.duration;
  if (!isFinite(d) || d <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: d,
      playbackRate: audio.playbackRate,
      position: Math.min(audio.currentTime, d),
    });
  } catch { /* ignore */ }
}

function updateNowPlaying() {
  const t = state.tracks.get(currentId());
  $('#npTitle').textContent = t ? titleOf(t) : '曲が選択されていません';
  $('#npArtist').textContent = t ? [t.artist, t.album].filter(Boolean).join(' — ') : '';
  const art = $('#npArt');
  const src = artUrl(t);
  if (src) {
    const img = new Image();
    img.src = src;
    img.alt = '';
    art.replaceChildren(img);
  } else {
    art.innerHTML = '<svg><use href="#i-note"/></svg>';
  }
  document.title = t ? `${titleOf(t)} - Local Player` : 'Local Player';
  updateProgress();

  if (!('mediaSession' in navigator)) return;
  if (!t) {
    navigator.mediaSession.metadata = null;
    return;
  }
  const meta = {
    title: titleOf(t),
    artist: t.artist || '',
    album: t.album || '',
    artwork: [{ src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }],
  };
  navigator.mediaSession.metadata = new MediaMetadata(meta);
  if (t.art) {
    artDataUrl(t).then((src) => {
      if (currentId() !== t.id) return;
      navigator.mediaSession.metadata = new MediaMetadata({ ...meta, artwork: [{ src, sizes: '512x512', type: t.art.type }] });
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------- ライブラリ・プレイリスト操作

async function importFiles(fileList) {
  const files = [...fileList].filter((f) => /\.mp3$/i.test(f.name) || /audio\/(mpeg|mp3)/.test(f.type));
  if (!files.length) return toast('MP3ファイルが選択されていません');
  navigator.storage?.persist?.().catch(() => {});

  const added = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    toast(`読み込み中… ${i + 1} / ${files.length}`, 0);
    let t = [...state.tracks.values()].find((x) => x.fileName === f.name && x.size === f.size);
    if (!t) {
      const tags = await readTags(f).catch(() => ({}));
      t = {
        id: uid(),
        fileName: f.name,
        size: f.size,
        title: tags.title || '',
        artist: tags.artist || '',
        album: tags.album || '',
        art: tags.picture || null,
        duration: null,
        addedAt: Date.now(),
      };
      try {
        await db.addTrack(t, f);
      } catch (e) {
        console.error(e);
        toast('保存に失敗しました（端末の空き容量が不足している可能性があります）', 5000);
        break;
      }
      state.tracks.set(t.id, t);
      urls.set(t.id, URL.createObjectURL(f));
    }
    added.push(t.id);
  }

  const p = playlistById(state.viewId);
  if (p) {
    p.trackIds.push(...added.filter((id) => !p.trackIds.includes(id)));
    await db.put('playlists', p);
  }
  syncQueue();
  renderAll();
  if (added.length) toast(`${added.length}曲を追加しました`);
}

async function addToPlaylist(ids) {
  const p = playlistById(state.viewId);
  if (!p) return;
  p.trackIds.push(...ids.filter((id) => !p.trackIds.includes(id)));
  await db.put('playlists', p);
  syncQueue();
  renderAll();
}

async function moveTrack(i, delta) {
  const p = playlistById(state.viewId);
  const j = i + delta;
  if (!p || j < 0 || j >= p.trackIds.length) return;
  [p.trackIds[i], p.trackIds[j]] = [p.trackIds[j], p.trackIds[i]];
  await db.put('playlists', p);
  syncQueue();
  renderList();
}

async function removeTrack(i) {
  const p = playlistById(state.viewId);
  if (p) {
    p.trackIds.splice(i, 1);
    await db.put('playlists', p);
  } else {
    const id = idsOf(LIBRARY)[i];
    const t = state.tracks.get(id);
    if (!confirm(`「${titleOf(t)}」を削除しますか？\nすべてのプレイリストからも削除されます。`)) return;
    await db.deleteTrack(id);
    state.tracks.delete(id);
    for (const map of [urls, artUrls]) {
      if (map.has(id)) URL.revokeObjectURL(map.get(id));
      map.delete(id);
    }
    artDataUrls.delete(id);
    for (const pl of state.playlists) {
      if (!pl.trackIds.includes(id)) continue;
      pl.trackIds = pl.trackIds.filter((x) => x !== id);
      await db.put('playlists', pl);
    }
  }
  syncQueue();
  renderAll();
}

async function createPlaylist() {
  const name = prompt('プレイリスト名', `プレイリスト ${state.playlists.length + 1}`)?.trim();
  if (!name) return;
  const p = { id: uid(), name, trackIds: [], createdAt: Date.now() };
  await db.put('playlists', p);
  state.playlists.push(p);
  state.viewId = p.id;
  state.editing = false;
  renderAll();
  saveState();
}

async function renamePlaylist() {
  const p = playlistById(state.viewId);
  const name = p && prompt('新しいプレイリスト名', p.name)?.trim();
  if (!name) return;
  p.name = name;
  await db.put('playlists', p);
  renderAll();
}

async function deletePlaylist() {
  const p = playlistById(state.viewId);
  if (!p || !confirm(`プレイリスト「${p.name}」を削除しますか？\n曲はライブラリに残ります。`)) return;
  await db.del('playlists', p.id);
  state.playlists = state.playlists.filter((x) => x !== p);
  state.viewId = LIBRARY;
  state.editing = false;
  syncQueue();
  renderAll();
  saveState();
}

// ---------------------------------------------------------------- 描画

function renderAll() {
  renderPlaylistSelect();
  renderToolbar();
  renderList();
  renderControls();
}

function renderPlaylistSelect() {
  const sel = $('#playlistSelect');
  sel.replaceChildren(
    new Option('ライブラリ', LIBRARY),
    ...state.playlists.map((p) => new Option(p.name, p.id)),
  );
  sel.value = state.viewId;
}

function renderToolbar() {
  const ids = idsOf(state.viewId);
  $('#fromLibraryBtn').hidden = state.viewId === LIBRARY;
  $('#countLabel').textContent = `${ids.length}曲`;
  const edit = $('#editBtn');
  edit.textContent = state.editing ? '完了' : '編集';
  edit.disabled = !ids.length && !state.editing;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function rowButton(act, label, aria, disabled = false) {
  const b = el('button', null, label);
  b.dataset.act = act;
  b.setAttribute('aria-label', aria);
  b.disabled = disabled;
  return b;
}

function renderList() {
  const ids = idsOf(state.viewId);
  const cur = currentId();
  const isLibrary = state.viewId === LIBRARY;

  const rows = ids.map((id, i) => {
    const t = state.tracks.get(id);
    const li = el('li', 'track');
    li.dataset.index = i;
    if (id === cur) li.classList.add('current');
    if (!urls.has(id)) li.classList.add('missing');

    const src = artUrl(t);
    let thumb;
    if (src) {
      thumb = el('img', 'thumb');
      thumb.src = src;
      thumb.alt = '';
      thumb.loading = 'lazy';
    } else {
      thumb = el('div', 'thumb');
      thumb.innerHTML = '<svg><use href="#i-note"/></svg>';
    }

    const info = el('div', 'info');
    const sub = [t.artist, t.duration ? formatTime(t.duration) : ''].filter(Boolean).join(' · ');
    info.append(el('div', 'title', titleOf(t)), el('div', 'sub', sub || t.fileName));
    li.append(thumb, info);

    if (state.editing) {
      const actions = el('div', 'row-actions');
      if (!isLibrary) {
        actions.append(
          rowButton('up', '▲', '上へ', i === 0),
          rowButton('down', '▼', '下へ', i === ids.length - 1),
        );
      }
      actions.append(rowButton('remove', '✕', isLibrary ? 'ライブラリから削除' : 'プレイリストから外す'));
      li.append(actions);
    } else if (id === cur) {
      const eq = el('span', 'eq');
      eq.append(el('i'), el('i'), el('i'));
      li.append(eq);
    }
    return li;
  });

  $('#trackList').replaceChildren(...rows);
  const empty = $('#emptyMsg');
  empty.hidden = ids.length > 0;
  empty.textContent = isLibrary
    ? '「＋ MP3を追加」から端末内のMP3ファイルを選んでください。複数まとめて選択できます。'
    : '「＋ MP3を追加」または「ライブラリから」で曲を追加してください。';
}

function renderControls() {
  const playing = !audio.paused;
  document.body.classList.toggle('is-playing', playing);
  $('#playIcon').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('#playBtn').setAttribute('aria-label', playing ? '一時停止' : '再生');
  $('#shuffleBtn').classList.toggle('active', state.shuffle);
  $('#shuffleBtn').setAttribute('aria-pressed', state.shuffle);
  const rep = $('#repeatBtn');
  rep.classList.toggle('active', state.repeat !== 'off');
  rep.classList.toggle('one', state.repeat === 'one');
  rep.setAttribute('aria-label', { off: 'リピート：オフ', all: 'リピート：全曲', one: 'リピート：1曲' }[state.repeat]);
}

function updateProgress() {
  const d = isFinite(audio.duration) ? audio.duration : state.tracks.get(currentId())?.duration || 0;
  const t = seeking ? Number(seek.value) : audio.readyState ? audio.currentTime : pendingSeek;
  seek.max = d;
  if (!seeking) seek.value = t;
  seek.style.setProperty('--p', d ? `${(t / d) * 100}%` : '0%');
  $('#curTime').textContent = formatTime(t);
  $('#durTime').textContent = formatTime(d);
}

// ---------------------------------------------------------------- ダイアログ

function openMenu() {
  const dlg = $('#menuDialog');
  for (const b of dlg.querySelectorAll('[data-playlist-only]')) b.disabled = state.viewId === LIBRARY;
  const info = $('#storageInfo');
  const version = `バージョン ${BUILD}`;
  info.textContent = version;
  navigator.storage?.estimate?.().then(({ usage, quota }) => {
    const mb = (n) => (n / 1024 / 1024).toFixed(0);
    info.textContent = `保存領域：${mb(usage)} MB 使用中（上限の目安 ${mb(quota)} MB）\n${version}`;
  }).catch(() => {});
  dlg.returnValue = '';
  dlg.showModal();
}

function onMenuClose() {
  const action = $('#menuDialog').returnValue;
  if (action === 'new') createPlaylist();
  else if (action === 'rename') renamePlaylist();
  else if (action === 'delete') deletePlaylist();
}

function openLibraryDialog() {
  const p = playlistById(state.viewId);
  if (!p) return;
  if (!state.tracks.size) return toast('ライブラリに曲がありません');
  const items = [...state.tracks.values()].map((t) => {
    const li = el('li');
    const label = el('label');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.value = t.id;
    if (p.trackIds.includes(t.id)) {
      cb.checked = true;
      cb.disabled = true;
    }
    const info = el('div', 'info');
    info.append(el('div', 'title', titleOf(t)), el('div', 'sub', t.artist || t.fileName));
    label.append(cb, info);
    li.append(label);
    return li;
  });
  $('#libraryList').replaceChildren(...items);
  const dlg = $('#libraryDialog');
  dlg.returnValue = '';
  dlg.showModal();
}

function onLibraryClose() {
  if ($('#libraryDialog').returnValue !== 'add') return;
  const ids = [...$('#libraryList').querySelectorAll('input:checked:not(:disabled)')].map((cb) => cb.value);
  if (ids.length) addToPlaylist(ids).then(() => toast(`${ids.length}曲を追加しました`));
}

function closeOnBackdrop(dlg) {
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close('');
  });
}

// ---------------------------------------------------------------- イベント

function onListClick(e) {
  const li = e.target.closest('li[data-index]');
  if (!li) return;
  const i = Number(li.dataset.index);
  const act = e.target.closest('button[data-act]')?.dataset.act;
  if (act === 'up') moveTrack(i, -1);
  else if (act === 'down') moveTrack(i, 1);
  else if (act === 'remove') removeTrack(i);
  else if (!state.editing) {
    const ids = idsOf(state.viewId);
    if (ids[i] === currentId() && state.queueSource === state.viewId) togglePlay();
    else startQueue(state.viewId, ids, i);
  }
}

function bindUI() {
  $('#fileInput').addEventListener('change', (e) => {
    importFiles(e.target.files).finally(() => { e.target.value = ''; });
  });
  $('#playlistSelect').addEventListener('change', (e) => {
    state.viewId = e.target.value;
    state.editing = false;
    renderAll();
    $('#main').scrollTop = 0;
    saveState();
  });
  $('#editBtn').addEventListener('click', () => {
    state.editing = !state.editing;
    renderToolbar();
    renderList();
  });
  $('#fromLibraryBtn').addEventListener('click', openLibraryDialog);
  $('#menuBtn').addEventListener('click', openMenu);
  $('#trackList').addEventListener('click', onListClick);

  $('#playBtn').addEventListener('click', togglePlay);
  $('#prevBtn').addEventListener('click', prev);
  $('#nextBtn').addEventListener('click', () => next());
  $('#shuffleBtn').addEventListener('click', toggleShuffle);
  $('#repeatBtn').addEventListener('click', cycleRepeat);

  seek.addEventListener('input', () => {
    seeking = true;
    updateProgress();
  });
  seek.addEventListener('change', () => {
    const v = Number(seek.value);
    seeking = false;
    if (audio.readyState) audio.currentTime = v;
    else pendingSeek = v;
    updateProgress();
    updatePositionState();
    saveState();
  });

  const menu = $('#menuDialog');
  const lib = $('#libraryDialog');
  menu.addEventListener('close', onMenuClose);
  lib.addEventListener('close', onLibraryClose);
  closeOnBackdrop(menu);
  closeOnBackdrop(lib);
  $('#selectAllBtn').addEventListener('click', () => {
    const boxes = [...$('#libraryList').querySelectorAll('input:not(:disabled)')];
    const all = boxes.every((b) => b.checked);
    boxes.forEach((b) => { b.checked = !all; });
  });

  audio.addEventListener('play', onPlayState);
  audio.addEventListener('pause', onPlayState);
  audio.addEventListener('playing', () => {
    errorStreak = 0;
    updatePositionState();
  });
  audio.addEventListener('ended', () => next(true));
  audio.addEventListener('loadedmetadata', () => {
    if (pendingSeek) {
      const d = audio.duration;
      audio.currentTime = isFinite(d) ? Math.min(pendingSeek, Math.max(0, d - 1)) : pendingSeek;
      pendingSeek = 0;
    }
    const t = state.tracks.get(currentId());
    if (t && isFinite(audio.duration) && !t.duration) {
      t.duration = audio.duration;
      db.put('tracks', t).catch(() => {});
      renderList();
    }
    updateProgress();
    updatePositionState();
  });
  audio.addEventListener('timeupdate', () => {
    updateProgress();
    if (Date.now() - lastSave > 5000) saveState();
  });
  audio.addEventListener('seeked', updatePositionState);
  audio.addEventListener('error', () => {
    if (!audio.getAttribute('src')) return;
    toast('この曲を再生できませんでした');
    if (++errorStreak < state.queue.length) next(true);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveState();
    else checkForUpdate();
  });
  window.addEventListener('pagehide', saveState);
}

function onPlayState() {
  renderControls();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
  updatePositionState();
  if (audio.paused) saveState();
}

// ---------------------------------------------------------------- 起動

async function init() {
  bindUI();
  setupMediaSession();
  try {
    const [tracks, playlists, blobs, saved] = await Promise.all([
      db.getAll('tracks'),
      db.getAll('playlists'),
      db.entries('blobs'),
      db.get('settings', 'state'),
    ]);
    tracks.sort((a, b) => a.addedAt - b.addedAt).forEach((t) => state.tracks.set(t.id, t));
    for (const [id, blob] of blobs) urls.set(id, URL.createObjectURL(blob));
    state.playlists = playlists.sort((a, b) => a.createdAt - b.createdAt);
    restoreState(saved);
  } catch (e) {
    console.error(e);
    toast('保存データを読み込めませんでした', 5000);
  }
  renderAll();
  updateNowPlaying();

  registerServiceWorker();
}

// ---------------------------------------------------------------- アプリ本体の更新

let swRegistration = null;
let updateReady = false;

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then((reg) => { swRegistration = reg; })
    .catch((e) => console.warn(e));
  // 新しい版の Service Worker が有効になったら読み込み直す（初回インストール時は除く）
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    updateReady = true;
    applyUpdate();
  });
}

// ホーム画面のアプリは再読み込みされずに復帰することが多いため、前面に戻るたびに確認する
function checkForUpdate() {
  swRegistration?.update().catch(() => {});
  applyUpdate();
}

// 再生中に読み込み直すと音が止まるので、停止中のときだけ反映する
function applyUpdate() {
  if (!updateReady || !audio.paused) return;
  saveState();
  location.reload();
}

init();
