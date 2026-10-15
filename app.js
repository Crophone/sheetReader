/* =========================================================
   SheetReader · 滑动读谱器
   纯前端实现：IndexedDB 本地存储曲谱库，无需后端
   ---------------------------------------------------------
   结构：
     1. 通用工具（图标 / toast / 对象URL池）
     2. IndexedDB 数据层（songs / pages）
     3. 图片工具（测量 / 旋转 / 合并导出）
     4. 路由
     5. 曲谱库视图
     6. 管理视图（上传 / 拖拽排序）
     7. 播放器视图（合并长谱 + 进度自动滚动）
     8. 示例曲谱生成
   ========================================================= */
'use strict';

/* ---------------- 通用工具 ---------------- */
const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/* 播放指示线固定在视口 35% 高度处，滚动映射与 CSS .playhead 的 top 保持一致 */
const PH_RATIO = 0.35;

function uid() {
  return (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

const ICONS = {
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7.5 5h3.4v14H7.5zM13.1 5h3.4v14h-3.4z" fill="currentColor" stroke="none"/>',
  rewind: '<path d="M6 5h2.2v14H6zM19.5 5.5v13L10 12z" fill="currentColor" stroke="none"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M12 16V4M6.5 9.5L12 4l5.5 5.5M4.5 20h15"/>',
  download: '<path d="M12 4v12M6.5 10.5L12 16l5.5-5.5M4.5 20h15"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.4-5.7M20 3.5V8h-4.5"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.2M12 19.8V22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2 12h2.2M19.8 12H22M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6"/>',
  moon: '<path d="M20.6 13.3A8.5 8.5 0 1 1 10.7 3.4a7 7 0 0 0 9.9 9.9z"/>',
};

function icon(name, size) {
  size = size || 18;
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none"' +
    ' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    (ICONS[name] || '') + '</svg>';
}

function toast(msg, type) {
  const box = $('#toast-box');
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  el.textContent = msg;
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 2400);
}

/* 对象 URL 池：视图切换时统一回收，避免内存泄漏 */
const URLPool = {
  list: [],
  make(blob) {
    const u = URL.createObjectURL(blob);
    this.list.push(u);
    return u;
  },
  clear() {
    this.list.forEach(u => URL.revokeObjectURL(u));
    this.list = [];
  },
};

/* ---------------- IndexedDB 数据层 ---------------- */
const DB_NAME = 'sheetreader';
const DB_VERSION = 1;
let _dbPromise = null;

function db() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('songs')) d.createObjectStore('songs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('pages')) {
        d.createObjectStore('pages', { keyPath: 'id' }).createIndex('songId', 'songId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function req2p(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

async function dbGet(store, id) {
  const d = await db();
  return req2p(d.transaction(store).objectStore(store).get(id));
}
async function dbPut(store, val) {
  const d = await db();
  return req2p(d.transaction(store, 'readwrite').objectStore(store).put(val));
}
async function dbDelete(store, id) {
  const d = await db();
  return req2p(d.transaction(store, 'readwrite').objectStore(store).delete(id));
}

/* song: { id, name, artist, createdAt, updatedAt, durationSec } */
/* page: { id, songId, order, name, type, blob, w, h } */

async function listSongs() {
  const d = await db();
  const all = await req2p(d.transaction('songs').objectStore('songs').getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}
async function getSong(id) { return dbGet('songs', id); }
async function saveSong(song) {
  song.updatedAt = Date.now();
  await dbPut('songs', song);
  return song;
}
async function deleteSong(id) {
  const pages = await listPages(id);
  for (const p of pages) await dbDelete('pages', p.id);
  await dbDelete('songs', id);
}
async function listPages(songId) {
  const d = await db();
  const idx = d.transaction('pages').objectStore('pages').index('songId');
  const rows = await req2p(idx.getAll(songId));
  return rows.sort((a, b) => a.order - b.order);
}
async function putPage(page) { return dbPut('pages', page); }
async function removePage(id) { return dbDelete('pages', id); }

/* 将仓库“吉他谱”目录清单首次导入浏览器曲谱库；sourceKey 防止重复生成。 */
async function importBundledGuitarSheets() {
  let manifest;
  try {
    const res = await fetch('guitar-sheets.json', { cache: 'no-cache' });
    if (!res.ok) return 0;
    manifest = await res.json();
  } catch (_) { return 0; }
  if (!manifest || !Array.isArray(manifest.songs)) return 0;
  let existing = await listSongs();
  const manifestVersion = Number(manifest.version) || 1;
  const stale = existing.filter(s => s.sourceKey && s.sourceKey.startsWith('bundled:') && s.sourceVersion !== manifestVersion);
  for (const song of stale) await deleteSong(song.id);
  if (stale.length) existing = await listSongs();
  const keys = new Set(existing.map(s => s.sourceKey).filter(Boolean));
  let created = 0;
  for (const item of manifest.songs) {
    const sourceKey = 'bundled:' + item.name + ':' + item.variant;
    if (keys.has(sourceKey) || !Array.isArray(item.pages) || !item.pages.length) continue;
    const loaded = [];
    for (const path of item.pages) {
      try {
        const res = await fetch(encodeURI(path));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        const meta = await imageMeta(blob);
        loaded.push({ path, blob, meta });
      } catch (err) { console.error('内置谱图加载失败', path, err); }
    }
    if (!loaded.length) continue;
    const song = await saveSong({
      id: uid(), name: item.name, artist: '', createdAt: Date.now(), durationSec: 0,
      originalBpm: 70, playBpm: 70, playbackSpeed: 1, sourceKey, sourceVersion: manifestVersion,
    });
    for (let i = 0; i < loaded.length; i++) {
      const x = loaded[i];
      await putPage({ id: uid(), songId: song.id, order: i, name: x.path.split('/').pop(), type: x.blob.type, blob: x.blob, w: x.meta.w, h: x.meta.h, sourcePath: x.path });
    }
    created++;
  }
  return created;
}

/* ---------------- 图片工具 ---------------- */
function blobToImage(blob) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('图片解析失败'));
    img.src = URL.createObjectURL(blob);
  });
}

function imageMeta(blob) {
  return blobToImage(blob).then(img => {
    const m = { w: img.naturalWidth, h: img.naturalHeight };
    URL.revokeObjectURL(img.src);
    return m;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise(res => canvas.toBlob(b => res(b), type, quality));
}

/* 识别并裁掉图片底部接近白色的连续空白，保留少量安全边距。 */
function detectContentBottom(img) {
  const sampleW = Math.min(900, img.naturalWidth);
  const sampleH = Math.max(1, Math.round(img.naturalHeight * sampleW / img.naturalWidth));
  const c = document.createElement('canvas');
  c.width = sampleW; c.height = sampleH;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, sampleW, sampleH);
  const data = ctx.getImageData(0, 0, sampleW, sampleH).data;
  const stepX = Math.max(1, Math.floor(sampleW / 180));
  let bottom = sampleH - 1;
  for (let y = sampleH - 1; y >= 0; y--) {
    let dark = 0, sampled = 0;
    for (let x = 0; x < sampleW; x += stepX) {
      const i = (y * sampleW + x) * 4;
      if (data[i + 3] > 20 && Math.min(data[i], data[i + 1], data[i + 2]) < 242) dark++;
      sampled++;
    }
    if (dark / sampled > 0.012) { bottom = y; break; }
  }
  const padding = Math.max(8, Math.round(sampleH * 0.012));
  const keptSampleH = Math.min(sampleH, bottom + 1 + padding);
  return Math.max(1, Math.round(keptSampleH * img.naturalHeight / sampleH));
}

async function fetchImageBlob(url) {
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error('图片下载失败（HTTP ' + res.status + '）');
  const blob = await res.blob();
  if (!blob.type.startsWith('image/')) throw new Error('网址返回的不是图片');
  return blob;
}

/* 顺时针旋转 90°：画布宽高互换后重绘 */
async function rotatePageBlob(page) {
  const img = await blobToImage(page.blob);
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = H; c.height = W;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(img, -W / 2, -H / 2);
  URL.revokeObjectURL(img.src);
  const type = page.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await canvasToBlob(c, type, 0.92);
  page.blob = blob;
  page.w = c.width;
  page.h = c.height;
  page.type = type;
  await putPage(page);
}

/* 多页合并为一张长图并下载 */
async function exportMergedPages(pages, songName) {
  const imgs = [];
  for (const p of pages) imgs.push(await blobToImage(p.blob));
  const cropHeights = imgs.map(detectContentBottom);
  const W0 = Math.max.apply(null, imgs.map(i => i.naturalWidth));
  const rawH = imgs.reduce((s, i, idx) => s + cropHeights[idx] * W0 / i.naturalWidth, 0);
  if (!(rawH > 0)) throw new Error('无法计算合并尺寸');
  /* 浏览器画布单边上限约 16000px，超出则整体缩小 */
  const scale = Math.min(1, 16000 / rawH);
  const W = Math.round(W0 * scale);
  const H = Math.round(rawH * scale);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  let y = 0;
  for (let idx = 0; idx < imgs.length; idx++) {
    const im = imgs[idx];
    const sourceH = cropHeights[idx];
    const h = sourceH * W / im.naturalWidth;
    ctx.drawImage(im, 0, 0, im.naturalWidth, sourceH, 0, y, W, h);
    y += h;
    URL.revokeObjectURL(im.src);
  }
  const blob = await canvasToBlob(c, 'image/png');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (songName || '曲谱') + '-合并长图.png';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ---------------- 路由 ---------------- */
let currentDestroy = null;
let renderToken = 0;

function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

async function render() {
  const token = ++renderToken;
  if (currentDestroy) { try { currentDestroy(); } catch (_) {} currentDestroy = null; }
  URLPool.clear();

  const app = $('#app');
  const h = location.hash || '#/library';
  const mSong = h.match(/^#\/song\/(.+)$/);
  const mPlay = h.match(/^#\/play\/(.+)$/);
  try {
    if (mSong) await renderEditor(app, decodeURIComponent(mSong[1]), token);
    else if (mPlay) await renderPlayer(app, decodeURIComponent(mPlay[1]), token);
    else await renderLibrary(app, token);
  } catch (err) {
    console.error(err);
    showStorageError(app, err);
  }
}

function showStorageError(app, err) {
  console.error(err);
  app.innerHTML =
    '<div class="view"><div class="error-panel">' +
    '<b>⚠️ 无法访问本地数据库（IndexedDB）</b>' +
    '<p>当前浏览器的存储不可用。请改用本地 HTTP 服务打开本应用：</p>' +
    '<p>在项目目录运行 <code>python -m http.server 8000</code>，' +
    '然后访问 <code>http://localhost:8000</code>。</p>' +
    '</div></div>';
}

/* ---------------- 曲谱库视图 ---------------- */
async function renderLibrary(app, token) {
  let songs = await listSongs();
  let bundledEnabled = false;
  try { bundledEnabled = localStorage.getItem('sr-bundled-sheets') === 'on'; } catch (_) {}
  const imported = bundledEnabled ? await importBundledGuitarSheets() : 0;
  if (imported) songs = await listSongs();
  let sortMode = 'recent', viewMode = 'album';
  try {
    sortMode = localStorage.getItem('sr-library-sort') || 'recent';
    viewMode = localStorage.getItem('sr-library-view') || 'album';
  } catch (_) {}
  const nameCompare = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN', { numeric: true, sensitivity: 'base' });
  function sortSongs() {
    songs.sort((a, b) => {
      let result = 0;
      if (sortMode === 'name') result = nameCompare(a, b);
      else if (sortMode === 'count') result = (Number(b.useCount) || 0) - (Number(a.useCount) || 0);
      else result = (Number(b.lastUsedAt) || 0) - (Number(a.lastUsedAt) || 0);
      return result || nameCompare(a, b) || String(a.sourceKey || a.id || '').localeCompare(String(b.sourceKey || b.id || ''), 'zh-CN', { numeric: true });
    });
  }
  sortSongs();
  if (token !== renderToken) return;

  app.innerHTML =
    '<div class="view library-view">' +
      '<div class="lib-head">' +
        '<div><h2>我的曲谱库</h2>' +
        '<p class="muted">上传多张六线谱自动合并 · 演奏时曲谱随进度自动滚动，解放双手</p></div>' +
        '<div class="lib-actions">' +
          '<label class="library-import-toggle" title="选择是否导入仓库“吉他谱”文件夹中的歌单">' +
            '<input type="checkbox" id="bundled-sheets-toggle"' + (bundledEnabled ? ' checked' : '') + '>' +
            '<span class="switch" aria-hidden="true"></span><span>导入“吉他谱”歌单</span>' +
          '</label>' +
          '<button class="btn ghost" id="btn-demo">' + icon('music') + ' 载入示例曲谱</button>' +
          '<button class="btn primary" id="btn-new">' + icon('plus') + ' 新建曲谱</button>' +
        '</div>' +
      '</div>' +
      '<div class="library-toolbar">' +
        '<div class="library-search">' +
          '<input id="song-search" type="search" placeholder="搜索歌曲名、歌手或来源…" autocomplete="off" aria-label="搜索曲谱">' +
          '<span id="search-count" class="muted"></span>' +
        '</div>' +
        '<label class="library-select">排序<select id="library-sort">' +
          '<option value="recent"' + (sortMode === 'recent' ? ' selected' : '') + '>最近使用</option>' +
          '<option value="name"' + (sortMode === 'name' ? ' selected' : '') + '>名称</option>' +
          '<option value="count"' + (sortMode === 'count' ? ' selected' : '') + '>使用次数</option>' +
        '</select></label>' +
        '<label class="library-select">展示<select id="library-view">' +
          '<option value="album"' + (viewMode === 'album' ? ' selected' : '') + '>相册框</option>' +
          '<option value="list"' + (viewMode === 'list' ? ' selected' : '') + '>简化列表</option>' +
        '</select></label>' +
      '</div>' +
      '<div class="songs-grid ' + (viewMode === 'list' ? 'list-view' : '') + '" id="songs-grid"></div>' +
      '<div class="empty small" id="search-empty" style="display:none"><p>没有找到匹配的曲谱</p><span>换一个歌曲名或歌手试试</span></div>' +
      '<div class="empty" id="empty-state" style="display:none">' + icon('music', 42) +
        '<p>曲谱库还是空的</p>' +
        '<span>点击「新建曲谱」上传你喜欢的歌曲六线谱图片，或先载入示例曲谱体验自动滚动演奏</span>' +
      '</div>' +
    '</div>';

  if (imported) toast('已从“吉他谱”目录生成 ' + imported + ' 首曲谱');
  const gridEl = $('#songs-grid');
  if (!songs.length) {
    gridEl.style.display = 'none';
    $('#empty-state').style.display = '';
  } else {
    songs.forEach(s => {
      gridEl.insertAdjacentHTML('beforeend',
        '<div class="song-card" data-id="' + esc(s.id) + '">' +
          '<div class="cover">' + icon('music', 44) + '<img alt="曲谱封面"></div>' +
          '<div class="song-info"><b class="song-name">' + esc(s.name) + '</b>' +
          '<span class="muted">' + esc(s.artist || '未知歌手') + ' · <span class="page-n">…</span> 页 · 使用 ' + (Number(s.useCount) || 0) + ' 次</span></div>' +
          '<div class="song-actions">' +
            '<button class="btn primary sm act-play">' + icon('play', 15) + ' 演奏</button>' +
            '<button class="btn ghost sm act-edit">管理</button>' +
            '<button class="btn danger sm act-del" title="删除曲谱">' + icon('trash', 14) + '</button>' +
          '</div>' +
        '</div>');
      bindSongCard(gridEl.lastElementChild, s, token);
    });
  }

  const searchInput = $('#song-search');
  const searchCount = $('#search-count');
  const searchEmpty = $('#search-empty');
  function filterSongs() {
    const q = searchInput.value.trim().toLocaleLowerCase();
    let visible = 0;
    $$('.song-card', gridEl).forEach(card => {
      const song = songs.find(s => s.id === card.dataset.id);
      const haystack = ((song && song.name) || '') + ' ' + ((song && song.artist) || '');
      const match = !q || haystack.toLocaleLowerCase().includes(q);
      card.style.display = match ? '' : 'none';
      if (match) visible++;
    });
    searchCount.textContent = q ? '找到 ' + visible + ' 首' : '共 ' + songs.length + ' 首';
    searchEmpty.style.display = songs.length && !visible ? '' : 'none';
    gridEl.style.display = songs.length && visible ? '' : 'none';
  }
  searchInput.addEventListener('input', filterSongs);
  filterSongs();

  $('#library-sort').addEventListener('change', e => {
    try { localStorage.setItem('sr-library-sort', e.target.value); } catch (_) {}
    render();
  });
  $('#library-view').addEventListener('change', e => {
    try { localStorage.setItem('sr-library-view', e.target.value); } catch (_) {}
    gridEl.classList.toggle('list-view', e.target.value === 'list');
  });

  $('#bundled-sheets-toggle').addEventListener('change', async e => {
    const enabled = e.target.checked;
    try { localStorage.setItem('sr-bundled-sheets', enabled ? 'on' : 'off'); } catch (_) {}
    e.target.disabled = true;
    if (enabled) {
      toast('正在导入“吉他谱”目录歌单…');
      const count = await importBundledGuitarSheets();
      toast(count ? '已导入 ' + count + ' 首曲谱' : '曲谱歌单已是最新');
    } else {
      const current = await listSongs();
      const bundled = current.filter(s => s.sourceKey && s.sourceKey.startsWith('bundled:'));
      for (const song of bundled) await deleteSong(song.id);
      toast('已关闭并移除“吉他谱”目录歌单');
    }
    if (token === renderToken) render();
  });

  $('#btn-new').onclick = () => openNewSongModal(async (name, artist) => {
    const song = await saveSong({
      id: uid(), name, artist, createdAt: Date.now(), durationSec: 0,
    });
    navigate('#/song/' + song.id);
  });

  $('#btn-demo').onclick = async () => {
    const btn = $('#btn-demo');
    btn.disabled = true;
    try {
      const s = await createDemoSong();
      if (token !== renderToken) return;
      toast('示例曲谱已加入曲谱库');
      navigate('#/song/' + s.id);
    } catch (err) {
      console.error(err);
      toast('示例曲谱生成失败', 'error');
      btn.disabled = false;
    }
  };
}

function bindSongCard(card, song, token) {
  /* 异步填充封面与页数 */
  listPages(song.id).then(ps => {
    if (token !== renderToken || !card.isConnected) return;
    const n = $('.page-n', card);
    if (n) n.textContent = ps.length;
    if (ps.length) {
      const img = $('img', card);
      img.src = URLPool.make(ps[0].blob);
      img.alt = song.name;
    } else {
      $('img', card).remove();
    }
  }).catch(() => {});

  $('.act-play', card).onclick = async () => {
    song.lastUsedAt = Date.now();
    song.useCount = (Number(song.useCount) || 0) + 1;
    await saveSong(song);
    navigate('#/play/' + song.id);
  };
  $('.act-edit', card).onclick = () => navigate('#/song/' + song.id);
  $('.act-del', card).onclick = async () => {
    if (!confirm('确定删除曲谱「' + song.name + '」？该操作不可恢复。')) return;
    await deleteSong(song.id);
    if (token !== renderToken) return;
    toast('已删除「' + song.name + '」');
    render();
  };
}

function openNewSongModal(onOk) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML =
    '<div class="modal"><h3>新建曲谱</h3>' +
    '<label class="field">歌曲名称<input id="m-name" placeholder="例如：晴天（间奏 SOLO）" maxlength="80"></label>' +
    '<label class="field">歌手 / 来源（可选）<input id="m-artist" placeholder="例如：周杰伦 / Guitar Pro 导出图" maxlength="80"></label>' +
    '<div class="modal-actions"><button class="btn ghost" id="m-cancel">取消</button>' +
    '<button class="btn primary" id="m-ok">创建并上传谱图</button></div></div>';
  document.body.appendChild(mask);

  const close = () => mask.remove();
  let busy = false;
  const ok = async () => {
    if (busy) return;
    const name = $('#m-name', mask).value.trim();
    if (!name) { toast('请先填写歌曲名称'); $('#m-name', mask).focus(); return; }
    busy = true;
    const artist = $('#m-artist', mask).value.trim();
    close();
    await onOk(name, artist);
  };
  $('#m-cancel', mask).onclick = close;
  $('#m-ok', mask).onclick = ok;
  mask.addEventListener('click', e => { if (e.target === mask) close(); });
  mask.addEventListener('keydown', e => {
    if (e.key === 'Enter') ok();
    else if (e.key === 'Escape') close();
  });
  setTimeout(() => $('#m-name', mask).focus(), 60);
}

/* ---------------- 管理视图（上传 / 拖拽排序） ---------------- */
async function renderEditor(app, songId, token) {
  const song = await getSong(songId);
  if (token !== renderToken) return;
  if (!song) { toast('未找到该曲谱'); return navigate('#/library'); }
  let pages = await listPages(songId);
  if (token !== renderToken) return;

  app.innerHTML =
    '<div class="view editor-view">' +
      '<div class="page-head">' +
        '<div class="ph-left">' +
          '<button class="btn icon-btn" id="btn-back-lib" title="返回曲谱库">' + icon('back') + '</button>' +
          '<div class="head-inputs">' +
            '<input id="song-name" class="song-input name" value="' + esc(song.name) + '" placeholder="歌曲名称" maxlength="80">' +
            '<input id="song-artist" class="song-input artist" value="' + esc(song.artist || '') + '" placeholder="歌手 / 来源（可选）" maxlength="80">' +
          '</div>' +
        '</div>' +
        '<div class="ph-actions">' +
          '<span class="muted">共 <b id="page-count">0</b> 页</span>' +
          '<button class="btn ghost" id="btn-export">' + icon('download') + ' 导出合并长图</button>' +
          '<button class="btn primary" id="btn-play-song">' + icon('play') + ' 开始演奏</button>' +
        '</div>' +
      '</div>' +
      '<div class="web-import">' +
        '<div class="web-import-title"><b>从吉他谱网站导入</b><span>粘贴曲谱页面网址，自动提取并保存谱图</span></div>' +
        '<div class="web-import-row">' +
          '<input id="sheet-url" type="url" inputmode="url" placeholder="https://example.com/song/tab" aria-label="吉他谱网站地址">' +
          '<button class="btn primary" id="btn-import-url">导入网站谱图</button>' +
        '</div>' +
      '</div>' +
      '<div class="upload-zone" id="upload-zone">' + icon('upload', 26) +
        '<p>点击选择谱图，或将图片拖拽到此处（支持一次多选）</p>' +
        '<span class="uz-tip">上传后可点击预览，拖拽缩略图调整页序，编号会实时更新</span>' +
        '<input type="file" id="file-input" accept="image/*" multiple hidden>' +
      '</div>' +
      '<div class="pages-scroll">' +
        '<div class="pages-grid" id="pages-grid"></div>' +
        '<div class="empty small" id="empty-pages" style="display:none">还没有谱页，先上传几张六线谱图片吧</div>' +
      '</div>' +
    '</div>';

  const gridEl = $('#pages-grid');
  const zone = $('#upload-zone');
  const fileInput = $('#file-input');
  const sheetUrlInput = $('#sheet-url');
  const importUrlBtn = $('#btn-import-url');

  function cardHTML(page, i) {
    return '<div class="page-card" draggable="true" data-id="' + esc(page.id) + '" title="拖拽调整顺序">' +
      '<div class="badge">' + (i + 1) + '</div>' +
      '<button class="thumb preview-page" type="button" title="点击查看第 ' + (i + 1) + ' 页完整内容"><img src="' + URLPool.make(page.blob) + '" alt="第' + (i + 1) + '页" draggable="false"></button>' +
      '<div class="card-tools">' +
        '<button class="tool tool-rotate" title="顺时针旋转 90°">' + icon('rotate', 15) + '</button>' +
        '<button class="tool tool-del" title="删除本页">' + icon('trash', 15) + '</button>' +
      '</div></div>';
  }

  function refreshGrid() {
    gridEl.innerHTML = pages.map(cardHTML).join('');
    $('#page-count').textContent = pages.length;
    $('#empty-pages').style.display = pages.length ? 'none' : '';
  }

  function renumber() {
    $$('.page-card', gridEl).forEach((c, i) => { $('.badge', c).textContent = i + 1; });
  }

  /* 按 DOM 顺序回写页序 */
  async function persistOrder() {
    const ids = $$('.page-card', gridEl).map(c => c.dataset.id);
    pages.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    let i = 0;
    for (const p of pages) {
      if (p.order !== i) { p.order = i; await putPage(p); }
      i++;
    }
    await saveSong(song);
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList).filter(f => f.type && f.type.startsWith('image/'));
    if (!files.length) { toast('请选择图片文件（PNG / JPG 等）'); return; }
    let order = pages.length ? Math.max.apply(null, pages.map(p => p.order)) + 1 : 0;
    let ok = 0;
    for (const f of files) {
      try {
        const meta = await imageMeta(f);
        await putPage({
          id: uid(), songId: song.id, order: order++,
          name: f.name, type: f.type, blob: f, w: meta.w, h: meta.h,
        });
        ok++;
      } catch (err) {
        console.error(err);
        toast('导入失败：' + f.name, 'error');
      }
    }
    if (!ok) return;
    pages = await listPages(songId);
    if (token !== renderToken) return;
    await saveSong(song);
    refreshGrid();
    toast('已添加 ' + ok + ' 页，拖拽缩略图可调整顺序');
  }

  async function importFromWebsite() {
    const sourceUrl = sheetUrlInput.value.trim();
    try { new URL(sourceUrl); } catch (_) { toast('请输入完整有效的网址'); return; }
    const cfg = window.SHEETREADER_SHEET_IMPORT_API || {};
    if (!cfg.endpoint) {
      toast('未配置网站谱图导入服务，请在 index.html 配置 SHEETREADER_SHEET_IMPORT_API', 'error');
      return;
    }
    importUrlBtn.disabled = true;
    importUrlBtn.textContent = '正在提取…';
    try {
      const apiUrl = cfg.endpoint.replaceAll('{url}', encodeURIComponent(sourceUrl));
      const headers = { Accept: 'application/json' };
      if (cfg.apiKey) headers[cfg.headerName || 'X-Api-Key'] = cfg.apiKey;
      const res = await fetch(apiUrl, { headers });
      if (!res.ok) throw new Error('提取服务返回 HTTP ' + res.status);
      const data = await res.json();
      const imageUrls = Array.isArray(data) ? data : data.images;
      if (!Array.isArray(imageUrls) || !imageUrls.length) throw new Error('没有找到可导入的曲谱图片');
      let order = pages.length ? Math.max.apply(null, pages.map(p => p.order)) + 1 : 0;
      let ok = 0;
      for (const imageUrl of imageUrls) {
        try {
          const blob = await fetchImageBlob(new URL(imageUrl, sourceUrl).href);
          const meta = await imageMeta(blob);
          await putPage({ id: uid(), songId: song.id, order: order++, name: '网页谱图-' + (ok + 1), type: blob.type, blob, w: meta.w, h: meta.h, sourceUrl });
          ok++;
        } catch (err) { console.error(err); }
      }
      if (!ok) throw new Error('图片受跨域或防盗链限制，无法下载');
      song.sheetSourceUrl = sourceUrl;
      await saveSong(song);
      pages = await listPages(songId);
      refreshGrid();
      toast('已从网站导入 ' + ok + ' 张谱图');
    } catch (err) {
      console.error(err);
      toast('网站导入失败：' + err.message, 'error');
    } finally {
      importUrlBtn.disabled = false;
      importUrlBtn.textContent = '导入网站谱图';
    }
  }
  importUrlBtn.onclick = importFromWebsite;
  sheetUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') importFromWebsite(); });

  /* --- 上传交互 --- */
  /* input 是 zone 的子元素，input.click() 的冒泡需要拦下，避免递归触发文件框 */
  zone.addEventListener('click', e => {
    if (e.target === fileInput) return;
    fileInput.click();
  });
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach(ev =>
    zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev =>
    zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('over'); }));
  zone.addEventListener('drop', e => addFiles(e.dataTransfer.files));

  /* --- 缩略图拖拽排序（拖拽过程中编号实时更新） --- */
  let dragEl = null;
  gridEl.addEventListener('dragstart', e => {
    const card = e.target.closest('.page-card');
    if (!card) return;
    dragEl = card;
    card.classList.add('dragging');
    gridEl.classList.add('dnd-active');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', card.dataset.id); } catch (_) {}
  });
  gridEl.addEventListener('dragover', e => {
    if (!dragEl) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.page-card');
    if (!target || target === dragEl) {
      if (!target && gridEl.lastElementChild !== dragEl) gridEl.appendChild(dragEl);
    } else {
      const r = target.getBoundingClientRect();
      const before = (e.clientY - r.top) < r.height / 2;
      const ref = before ? target : target.nextSibling;
      if (ref !== dragEl) gridEl.insertBefore(dragEl, ref);
    }
    renumber();
  });
  gridEl.addEventListener('drop', e => e.preventDefault());
  gridEl.addEventListener('dragend', async () => {
    if (!dragEl) return;
    dragEl.classList.remove('dragging');
    gridEl.classList.remove('dnd-active');
    dragEl = null;
    renumber();
    await persistOrder();
    toast('页序已保存');
  });

  function openPagePreview(page, index) {
    const mask = document.createElement('div');
    mask.className = 'preview-mask';
    const url = URLPool.make(page.blob);
    mask.innerHTML = '<div class="preview-panel">' +
      '<div class="preview-head"><b>第 ' + (index + 1) + ' 页</b><button class="btn icon-btn preview-close" type="button" aria-label="关闭">×</button></div>' +
      '<div class="preview-body"><img src="' + url + '" alt="第 ' + (index + 1) + ' 页曲谱完整内容"></div></div>';
    document.body.appendChild(mask);
    const close = () => mask.remove();
    $('.preview-close', mask).onclick = close;
    mask.addEventListener('click', e => { if (e.target === mask) close(); });
  }

  /* --- 工具按钮（预览 / 旋转 / 删除） --- */
  gridEl.addEventListener('click', async e => {
    const card = e.target.closest('.page-card');
    if (!card) return;
    const page = pages.find(p => p.id === card.dataset.id);
    if (!page) return;
    if (e.target.closest('.preview-page')) {
      openPagePreview(page, pages.indexOf(page));
    } else if (e.target.closest('.tool-rotate')) {
      const btn = e.target.closest('.tool-rotate');
      btn.disabled = true;
      try {
        await rotatePageBlob(page);
        const img = $('.thumb img', card);
        if (img) img.src = URLPool.make(page.blob);
      } catch (err) {
        console.error(err);
        toast('旋转失败', 'error');
      }
      btn.disabled = false;
    } else if (e.target.closest('.tool-del')) {
      const idx = $$('.page-card', gridEl).indexOf(card);
      if (!confirm('确定删除第 ' + (idx + 1) + ' 页吗？')) return;
      await removePage(page.id);
      pages = await listPages(songId);
      let i = 0;
      for (const p of pages) { if (p.order !== i) { p.order = i; await putPage(p); } i++; }
      await saveSong(song);
      if (token !== renderToken) return;
      refreshGrid();
      toast('已删除第 ' + (idx + 1) + ' 页');
    }
  });

  /* --- 顶部操作 --- */
  $('#btn-back-lib').onclick = () => navigate('#/library');
  $('#btn-play-song').onclick = () => navigate('#/play/' + song.id);
  $('#btn-export').onclick = async () => {
    if (!pages.length) { toast('还没有谱页可导出'); return; }
    toast('正在生成合并长图，请稍候…');
    try {
      await exportMergedPages(pages, song.name);
      toast('已导出合并长图（浏览器下载中）');
    } catch (err) {
      console.error(err);
      toast('导出失败：' + err.message, 'error');
    }
  };
  $('#song-name').addEventListener('change', async e => {
    song.name = e.target.value.trim() || '未命名曲谱';
    e.target.value = song.name;
    await saveSong(song);
  });
  $('#song-artist').addEventListener('change', async e => {
    song.artist = e.target.value.trim();
    await saveSong(song);
  });

  refreshGrid();
}

/* ---------------- 播放器视图 ---------------- */
async function renderPlayer(app, songId, token) {
  const song = await getSong(songId);
  if (token !== renderToken) return;
  if (!song) { toast('未找到该曲谱'); return navigate('#/library'); }
  const pages = await listPages(songId);
  if (token !== renderToken) return;

  if (!pages.length) {
    app.innerHTML =
      '<div class="view"><div class="empty">' + icon('music', 42) +
      '<p>这首歌还没有谱页</p><span>先到管理页上传六线谱图片，再回来演奏</span>' +
      '<button class="btn primary" id="btn-go-manage" style="margin-top:10px">去上传谱图</button></div></div>';
    $('#btn-go-manage').onclick = () => navigate('#/song/' + songId);
    return;
  }

  /* BPM：优先使用用户设置值，否则使用自动查询到的原版 BPM；纯前端无开放音乐数据库时提供可靠回退值。 */
  const fallbackBpm = 70;
  let originalBpm = clamp(Number(song.originalBpm) || fallbackBpm, 30, 300);
  let playBpm = clamp(Number(song.playBpm) || originalBpm, 30, 300);
  let duration = song.durationSec > 0 ? song.durationSec * originalBpm / playBpm : pages.length * 64 * 60 / playBpm;
  let progress = 0;
  let playing = false;
  /* 底部倍速直接控制播放时间推进和曲谱滑动速度，并在歌曲间保留设置。 */
  let speed = clamp(Number(song.playbackSpeed) || 1, 0.25, 5);
  /* 桌面端当前视觉尺寸标记为 100%；内部宽度基准为容器的 55%。 */
  let zoom = 100;
  let rafId = 0;
  let lastTs = 0;
  let autoScrolling = false;

  app.innerHTML =
    '<div class="view player-view">' +
      '<div class="player-top">' +
        '<button class="btn icon-btn" id="btn-back" title="返回曲谱库">' + icon('back') + '</button>' +
        '<div class="pt-title"><b>' + esc(song.name) + '</b>' +
        '<span>' + esc(song.artist || '未知歌手') + ' · ' + pages.length + ' 页 · 已合并为连续长谱</span></div>' +
        '<div class="pt-controls">' +
          '<div class="bpm-controls">' +
            '<label class="bpm-label original-label" for="original-bpm">原版 BPM</label>' +
            '<input id="original-bpm" type="number" min="30" max="300" step="1">' +
            '<button class="btn ghost sm" id="search-bpm">重新查询</button>' +
            '<span class="bpm-status" id="bpm-status">自动查询</span>' +
            '<label class="bpm-label play-label" for="play-bpm">播放 BPM</label>' +
            '<input id="play-bpm" type="number" min="30" max="300" step="1">' +
            '<button class="btn ghost sm" id="reset-bpm">使用原版</button>' +
            '<span class="bpm-spacer" aria-hidden="true"></span>' +
          '</div>' +
          '<label class="zoom-ctl">缩放 ' +
            '<input id="zoom-val" type="number" min="10" max="500" step="1" inputmode="numeric" value="100" aria-label="曲谱缩放百分比">%' +
          '</label>' +
        '</div>' +
      '</div>' +
      '<div class="stage">' +
        '<div class="scroller" id="scroller"><div class="sheet" id="sheet"></div></div>' +
        '<div class="measure-highlight" aria-hidden="true"><span>正在演奏</span></div>' +
        '<div class="playhead" aria-hidden="true"></div>' +
      '</div>' +
      '<div class="player-bar">' +
        '<button class="btn icon-btn" id="btn-begin" title="回到开头">' + icon('rewind') + '</button>' +
        '<button class="btn primary round" id="btn-play" title="播放（空格）">' + icon('play', 22) + '</button>' +
        '<div class="progress-ctl">' +
          '<span class="time" id="time-cur">0:00</span>' +
          '<input type="range" id="seek" min="0" max="1000" value="0" step="1" title="演奏进度">' +
          '<span class="time" id="time-total">0:00</span>' +
        '</div>' +
        '<div class="speed-ctl">' +
          '<button id="speed-down" class="btn icon-btn" title="滚动减速（-）">−</button>' +
          '<input id="speed-range" type="range" min="0.25" max="5" step="0.01" value="1" aria-label="滑动播放速度">' +
          '<label class="speed-input-wrap"><input id="speed-val" type="number" min="0.25" max="5" step="0.01" inputmode="decimal" value="1.00" aria-label="播放速度"></label>' +
          '<button id="speed-up" class="btn icon-btn" title="滚动加速（+）">＋</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  const scroller = $('#scroller');
  const sheet = $('#sheet');
  const btnPlay = $('#btn-play');
  const seek = $('#seek');

  /* 拼接谱页：多页图片纵向无缝合并，播放结束即停在最后一页，不追加末尾空白。 */
  const imgEls = pages.map(p => {
    const im = new Image();
    im.src = URLPool.make(p.blob);
    im.alt = '谱页';
    sheet.appendChild(im);
    return im;
  });
  await Promise.all(imgEls.map(im => (im.decode ? im.decode().catch(() => {}) : Promise.resolve())));
  if (token !== renderToken) return;

  function contentHeight() {
    return imgEls.reduce((sum, im) => sum + im.offsetHeight, 0);
  }

  /* 按页识别头尾留白：留白只占 8% 时间，曲谱主体获得 92% 时间，跨页时快速平滑掠过空白。 */
  function timeToSheetY(ratio) {
    const heights = imgEls.map(im => im.offsetHeight);
    const content = heights.reduce((a, b) => a + b, 0);
    if (!content) return 0;
    const units = heights.map(h => ({ fast: h * 0.18, slow: h * 0.82 }));
    const totalWeight = units.reduce((s, u) => s + u.fast * 0.08 + u.slow * 0.92, 0);
    let target = clamp(ratio, 0, 1) * totalWeight;
    let y = 0;
    for (const u of units) {
      const slowWeight = u.slow * 0.92;
      const fastWeight = u.fast * 0.08;
      if (target <= slowWeight) return y + target / 0.92;
      target -= slowWeight;
      y += u.slow;
      if (target <= fastWeight) return y + target / 0.08;
      target -= fastWeight;
      y += u.fast;
    }
    return content;
  }

  function sheetYToTime(y) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      if (timeToSheetY(mid) < y) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  function leadInSec() { return clamp(60 / playBpm * 4, 1.5, 5); }

  /* 播放时间映射到曲谱位置：开场预留 4 拍，正文慢速，页尾空白快速掠过。 */
  function progressToScrollY(value) {
    const maxY = Math.max(0, contentHeight() - scroller.clientHeight);
    const lead = leadInSec();
    if (value <= lead) return 0;
    const bodyRatio = clamp((value - lead) / Math.max(0.001, duration - lead), 0, 1);
    const sheetY = timeToSheetY(bodyRatio);
    return clamp(sheetY - PH_RATIO * scroller.clientHeight, 0, maxY);
  }

  function scrollYToProgress(y) {
    const maxY = Math.max(0, contentHeight() - scroller.clientHeight);
    if (!maxY) return 0;
    /* 滚动位置代表演奏提示线所指向的谱面内容点。 */
    const sheetY = clamp(y + PH_RATIO * scroller.clientHeight, 0, contentHeight());
    return leadInSec() + sheetYToTime(sheetY) * Math.max(0, duration - leadInSec());
  }

  function applyScroll() {
    /* 演奏提示线与粉色区域始终保持 CSS 中的固定位置。 */
    autoScrolling = true;
    scroller.scrollTop = progressToScrollY(progress);
  }

  function updateHud() {
    $('#time-cur').textContent = fmtTime(progress);
    $('#time-total').textContent = fmtTime(duration);
    seek.value = duration ? Math.round(progress / duration * 1000) : 0;
  }

  function setProgress(p, scroll) {
    progress = clamp(p, 0, duration);
    updateHud();
    if (scroll !== false) applyScroll();
  }

  function setPlayIcon() {
    btnPlay.innerHTML = playing ? icon('pause', 22) : icon('play', 22);
    btnPlay.title = playing ? '暂停（空格）' : '播放（空格）';
  }

  function togglePlay() {
    if (!playing && progress >= duration) progress = 0;
    playing = !playing;
    lastTs = 0;
    setPlayIcon();
  }

  let speedSaveTimer = 0;
  function setSpeed(next, persist) {
    speed = clamp(Math.round(next * 100) / 100, 0.25, 5);
    $('#speed-val').value = speed.toFixed(2);
    $('#speed-range').value = String(speed);
    $('#speed-down').disabled = speed <= 0.25;
    $('#speed-up').disabled = speed >= 5;
    if (persist !== false) {
      song.playbackSpeed = speed;
      clearTimeout(speedSaveTimer);
      speedSaveTimer = setTimeout(() => saveSong(song).catch(console.error), 180);
    }
    /* 重置时间戳，避免调整瞬间把按钮操作耗时计入播放进度。 */
    lastTs = 0;
  }

  function bumpSpeed(d) {
    setSpeed(speed + d);
  }

  function setZoom(z) {
    zoom = clamp(Math.round(Number(z) || 100), 10, 500);

   if (matchMedia('(max-width: 767px)').matches) {
              console.log("手机端");
          sheet.style.width = zoom  + '%';
    }
    else if (matchMedia('(max-width:  1024 px)').matches) {
              console.log("平板端");
          sheet.style.width = zoom * 0.8 + '%';
    } 
    else{
          console.log("PC端");
          /* 显示 100% 对应当前 55% 的实际宽度。 */
          sheet.style.width = zoom * 0.55 + '%';
    } 
    

       
    $('#zoom-val').value = String(zoom);
    requestAnimationFrame(applyScroll);
  }

  /* --- 控件绑定 --- */
  btnPlay.onclick = togglePlay;
  $('#btn-begin').onclick = () => setProgress(0);
  $('#btn-back').onclick = () => navigate('#/library');
  $('#speed-up').onclick = () => bumpSpeed(0.05);
  $('#speed-down').onclick = () => bumpSpeed(-0.05);
  const speedInput = $('#speed-val');
  function commitSpeedInput() {
    const value = Number(speedInput.value);
    if (!Number.isFinite(value)) {
      speedInput.value = speed.toFixed(2);
      toast('请输入 0.25 到 5.00 之间的速度');
      return;
    }
    setSpeed(value);
  }
  const speedRange = $('#speed-range');
  speedRange.addEventListener('input', () => setSpeed(Number(speedRange.value)));
  speedInput.addEventListener('change', commitSpeedInput);
  speedInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commitSpeedInput(); speedInput.blur(); }
  });
  const zoomInput = $('#zoom-val');
  function commitZoomInput() { setZoom(zoomInput.value); }
  zoomInput.addEventListener('change', commitZoomInput);
  zoomInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commitZoomInput(); zoomInput.blur(); }
  });
  seek.addEventListener('input', e => {
    const value = e.target.value / 1000 * duration;
    setProgress(value);
    lastTs = 0;
  });

  /* BPM 设置：原版值可由查询服务回填，也允许校正；播放 BPM 持久保存并实时改变滚动时长。 */
  const originalBpmEl = $('#original-bpm');
  const playBpmEl = $('#play-bpm');
  const bpmStatusEl = $('#bpm-status');
  const searchBpmBtn = $('#search-bpm');
  originalBpmEl.value = originalBpm;
  playBpmEl.value = playBpm;
  bpmStatusEl.textContent = song.originalBpm ? '已写入' : '准备查询';

  function getBpmApiConfig() {
    /* 部署方可在 index.html 的 app.js 之前设置 window.SHEETREADER_BPM_API。
       endpoint 支持 {title}/{artist} 占位符；responsePath 默认为 bpm。 */
    const cfg = window.SHEETREADER_BPM_API || {};
    return {
      endpoint: cfg.endpoint || '',
      apiKey: cfg.apiKey || '',
      headerName: cfg.headerName || 'X-Api-Key',
      responsePath: cfg.responsePath || 'bpm',
    };
  }

  function readPath(obj, path) {
    return String(path).split('.').reduce((v, key) => v == null ? undefined : v[key], obj);
  }

  async function searchOriginalBpm(force) {
    if (song.originalBpm && !force) return;
    const cfg = getBpmApiConfig();
    if (!cfg.endpoint) {
      bpmStatusEl.textContent = '未配置查询服务';
      return;
    }
    searchBpmBtn.disabled = true;
    bpmStatusEl.textContent = '正在按歌名搜索…';
    try {
      const url = cfg.endpoint
        .replaceAll('{title}', encodeURIComponent(song.name))
        .replaceAll('{artist}', encodeURIComponent(song.artist || ''));
      const headers = { Accept: 'application/json' };
      if (cfg.apiKey) headers[cfg.headerName] = cfg.apiKey;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const found = Math.round(Number(readPath(data, cfg.responsePath)));
      if (!(found >= 30 && found <= 300)) throw new Error('未找到有效 BPM');
      const wasDefaultPlayBpm = !song.playBpm || playBpm === originalBpm;
      originalBpm = found;
      song.originalBpm = found;
      song.bpmSource = url.replace(/([?&](?:key|api_key|token)=)[^&]+/gi, '$1***');
      originalBpmEl.value = found;
      if (wasDefaultPlayBpm) {
        playBpm = found;
        song.playBpm = found;
        playBpmEl.value = found;
      }
      await saveSong(song);
      await saveBpm(false);
      bpmStatusEl.textContent = '自动查询并写入';
      toast('已找到原曲速度：' + found + ' BPM');
    } catch (err) {
      console.error(err);
      bpmStatusEl.textContent = '未找到，可手动填写';
      toast('未查到原曲 BPM：' + err.message, 'error');
    } finally {
      searchBpmBtn.disabled = false;
    }
  }

  async function saveBpm(showToast) {
    const oldDuration = duration;
    originalBpm = clamp(Number(originalBpmEl.value) || fallbackBpm, 30, 300);
    playBpm = clamp(Number(playBpmEl.value) || originalBpm, 30, 300);
    originalBpmEl.value = originalBpm;
    playBpmEl.value = playBpm;
    song.originalBpm = originalBpm;
    song.playBpm = playBpm;
    const baseDuration = song.durationSec > 0 ? song.durationSec : pages.length * 64 * 60 / originalBpm;
    duration = baseDuration * originalBpm / playBpm;
    progress = oldDuration ? progress / oldDuration * duration : 0;
    await saveSong(song);
    updateHud();
    applyScroll();
    if (showToast !== false) toast('播放速度已设为 ' + playBpm + ' BPM');
  }
  originalBpmEl.addEventListener('change', () => saveBpm());
  playBpmEl.addEventListener('change', () => saveBpm());
  searchBpmBtn.onclick = () => searchOriginalBpm(true);
  $('#reset-bpm').onclick = () => { playBpmEl.value = originalBpmEl.value; saveBpm(); };
  searchOriginalBpm(false);

  function progressFromScroll() {
    if (contentHeight() <= 0 || scroller.clientHeight <= 0) return;
    progress = clamp(scrollYToProgress(scroller.scrollTop), 0, duration);
    lastTs = 0;
    updateHud();
  }

  /* 用户手动滚动条定位：同步进度，播放中从新位置继续。 */
  scroller.addEventListener('scroll', () => {
    if (autoScrolling) { autoScrolling = false; return; }
    progressFromScroll();
  }, { passive: true });

  /* 手动定位统一走动画帧插值：速度更快，但视觉连续不跳变。 */
  const MANUAL_SCROLL_FACTOR = 1.75;
  let manualTargetY = scroller.scrollTop;
  let manualRaf = 0;
  function animateManualScroll() {
    const diff = manualTargetY - scroller.scrollTop;
    if (Math.abs(diff) < 0.5) {
      scroller.scrollTop = manualTargetY;
      progressFromScroll();
      manualRaf = 0;
      return;
    }
    autoScrolling = true;
    scroller.scrollTop += diff * 0.34;
    progressFromScroll();
    manualRaf = requestAnimationFrame(animateManualScroll);
  }
  function smoothScrollTo(y, targetProgress) {
    const maxY = Math.max(0, contentHeight() - scroller.clientHeight);
    manualTargetY = clamp(y, 0, maxY);
    if (Number.isFinite(targetProgress)) {
      progress = clamp(targetProgress, 0, duration);
      updateHud();
    }
    lastTs = 0;
    if (!manualRaf) manualRaf = requestAnimationFrame(animateManualScroll);
  }

  function seekToSheetY(sheetY, smooth) {
    const vh = scroller.clientHeight;
    const maxY = Math.max(0, contentHeight() - vh);
    /* 将点击的谱面内容点移动到固定演奏提示线处。 */
    const targetScrollY = clamp(sheetY - PH_RATIO * vh, 0, maxY);
    const target = clamp(scrollYToProgress(targetScrollY), 0, duration);
    if (smooth) smoothScrollTo(targetScrollY, target);
    else setProgress(target);
  }

  function seekScrollPosition(y) {
    const targetY = clamp(y, 0, Math.max(0, contentHeight() - scroller.clientHeight));
    smoothScrollTo(targetY, scrollYToProgress(targetY));
  }

  /* 鼠标滚轮改变目标位置，平滑对齐演奏提示线且保持播放状态。 */
  scroller.addEventListener('wheel', e => {
    if (Math.abs(e.deltaY) < 0.1) return;
    e.preventDefault();
    const vh = scroller.clientHeight;
    const unit = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? vh : 1;
    seekScrollPosition(manualTargetY + e.deltaY * unit * MANUAL_SCROLL_FACTOR);
  }, { passive: false });

  /* 单指拖动采用较高位移倍率，并以动画帧平滑追随手指。 */
  let touchId = null;
  let touchY = 0;
  let touchScrollTop = 0;
  let touchMoved = false;
  scroller.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    touchId = t.identifier;
    touchY = t.clientY;
    touchScrollTop = scroller.scrollTop;
    manualTargetY = scroller.scrollTop;
    touchMoved = false;
    lastTs = 0;
  }, { passive: true });
  scroller.addEventListener('touchmove', e => {
    if (touchId == null) return;
    const t = Array.from(e.touches).find(item => item.identifier === touchId);
    if (!t) return;
    const dy = t.clientY - touchY;
    if (Math.abs(dy) > 3) touchMoved = true;
    e.preventDefault();
    seekScrollPosition(touchScrollTop - dy * MANUAL_SCROLL_FACTOR);
  }, { passive: false });
  function finishTouch() { touchId = null; lastTs = 0; }
  scroller.addEventListener('touchend', finishTouch, { passive: true });
  scroller.addEventListener('touchcancel', finishTouch, { passive: true });

  /* 鼠标按住谱面拖动，行为与手指拖动一致。 */
  let pointerDrag = false;
  let pointerStartY = 0;
  let pointerScrollTop = 0;
  let pointerMoved = false;
  scroller.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    pointerDrag = true;
    pointerMoved = false;
    pointerStartY = e.clientY;
    pointerScrollTop = scroller.scrollTop;
    manualTargetY = scroller.scrollTop;
    scroller.setPointerCapture(e.pointerId);
    scroller.classList.add('drag-seeking');
  });
  scroller.addEventListener('pointermove', e => {
    if (!pointerDrag) return;
    const dy = e.clientY - pointerStartY;
    if (Math.abs(dy) > 3) pointerMoved = true;
    e.preventDefault();
    seekScrollPosition(pointerScrollTop - dy * MANUAL_SCROLL_FACTOR);
  });
  function finishPointer(e) {
    if (!pointerDrag) return;
    pointerDrag = false;
    lastTs = 0;
    scroller.classList.remove('drag-seeking');
    try { scroller.releasePointerCapture(e.pointerId); } catch (_) {}
  }
  scroller.addEventListener('pointerup', finishPointer);
  scroller.addEventListener('pointercancel', finishPointer);

  /* 点击谱面任意位置：跳转到对应进度 */
  const playerBar = $('.player-bar');
  let controlsTimer = 0;
  function showMobileControls() {
    if (!matchMedia('(max-width: 767px)').matches) return;
    playerBar.classList.add('mobile-visible');
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => playerBar.classList.remove('mobile-visible'), 4000);
  }
  scroller.addEventListener('click', e => {
    if (touchMoved || pointerMoved) { touchMoved = false; pointerMoved = false; return; }
  
    if (matchMedia('(max-width: 767px)').matches) {
      showMobileControls();
      return;
    }
    const isTouchLayout = matchMedia('(max-width: 1366px) and (pointer: coarse)').matches;
    if (isTouchLayout) showMobileControls();
    const r = sheet.getBoundingClientRect();
    if (r.height <= 0) return;
    const clickedSheetY = clamp(e.clientY - r.top, 0, contentHeight());
    seekToSheetY(clickedSheetY, true);
  });

  /* 键盘快捷键 */
  function onKey(e) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const target = clamp(progress + 5, 0, duration);
      smoothScrollTo(progressToScrollY(target), target);
    }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const target = clamp(progress - 5, 0, duration);
      smoothScrollTo(progressToScrollY(target), target);
    }
    else if (e.key === '+' || e.key === '=') bumpSpeed(0.05);
    else if (e.key === '-') bumpSpeed(-0.05);
  }
  document.addEventListener('keydown', onKey);

  let resizeRaf = 0;
  function onResize() {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(applyScroll);
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);

  /* --- 主循环：进度驱动滚动 --- */
  function loop(ts) {
    if (playing) {
      if (!lastTs) lastTs = ts;
      const dt = (ts - lastTs) / 1000;
      progress = Math.min(duration, progress + dt * speed);
      applyScroll();
      updateHud();
      if (progress >= duration) {
        playing = false;
        setPlayIcon();
        toast('演奏结束，按空格或播放键可从头再来一遍');
      }
    }
    lastTs = ts;
    rafId = requestAnimationFrame(loop);
  }

  setZoom(zoom);
  setSpeed(speed, false);
  updateHud();
  setPlayIcon();
  applyScroll();
  rafId = requestAnimationFrame(loop);

  currentDestroy = () => {
    cancelAnimationFrame(rafId);
    cancelAnimationFrame(resizeRaf);
    cancelAnimationFrame(manualRaf);
    clearTimeout(controlsTimer);
    clearTimeout(speedSaveTimer);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', onResize);
  };
}

/* ---------------- 示例曲谱生成 ---------------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* 用 Canvas 画一页仿真六线谱，便于零素材体验完整流程 */
function drawDemoPage(idx, total) {
  const W = 900, H = 1273;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');

  x.fillStyle = '#fdfcf7';
  x.fillRect(0, 0, W, H);

  x.fillStyle = '#1c2333';
  x.textAlign = 'center';
  x.font = 'bold 40px Georgia, "Microsoft YaHei", sans-serif';
  x.fillText('C 大调音阶练习', W / 2, 92);
  x.font = '15px "Microsoft YaHei", sans-serif';
  x.fillStyle = '#8a8f9c';
  x.fillText('SheetReader 示例曲谱 · 第 ' + (idx + 1) + ' / ' + total + ' 页', W / 2, 122);
  if (idx === 0) x.fillText('♩ = 90', W / 2, 152);

  const lineGap = 15;
  const staffH = lineGap * 5;
  const sysGap = 56;
  const left = 70, right = W - 70;
  const top = idx === 0 ? 205 : 160;
  const rng = mulberry32(idx * 9973 + 7);

  for (let s = 0; ; s++) {
    const y0 = top + s * (staffH + sysGap);
    if (y0 + staffH > H - 70) break;
    x.strokeStyle = '#3a4256';
    for (let l = 0; l < 6; l++) {
      x.lineWidth = 1;
      x.beginPath();
      x.moveTo(left, y0 + l * lineGap);
      x.lineTo(right, y0 + l * lineGap);
      x.stroke();
    }
    /* 小节线（首尾加粗） */
    const bars = 4;
    for (let b = 0; b <= bars; b++) {
      const bx = left + (right - left) * b / bars;
      x.lineWidth = (b === 0 || b === bars) ? 2.5 : 1;
      x.beginPath();
      x.moveTo(bx, y0);
      x.lineTo(bx, y0 + staffH);
      x.stroke();
    }
    /* 品位数字 */
    x.fillStyle = '#c0392b';
    x.font = 'bold 13px Consolas, monospace';
    x.textAlign = 'center';
    for (let b = 0; b < bars; b++) {
      for (let n = 0; n < 8; n++) {
        if (rng() < 0.28) continue;
        const px = left + (right - left) * (b + n / 8 + 0.5 / 8) / bars;
        const line = Math.floor(rng() * 6);
        x.fillText(String(Math.floor(rng() * 15)), px, y0 + line * lineGap + 5);
      }
    }
  }
  return canvasToBlob(c, 'image/png');
}

async function createDemoSong() {
  const song = await saveSong({
    id: uid(),
    name: '示例 · C 大调音阶练习',
    artist: 'SheetReader 生成',
    createdAt: Date.now(),
    durationSec: 0,
  });
  const TOTAL = 3;
  for (let i = 0; i < TOTAL; i++) {
    const blob = await drawDemoPage(i, TOTAL);
    await putPage({
      id: uid(), songId: song.id, order: i,
      name: 'demo-' + (i + 1) + '.png', type: 'image/png',
      blob, w: 900, h: 1273,
    });
  }
  return song;
}

/* ---------------- 全局外观设置 / 启动 ---------------- */
const themeToggle = $('#theme-toggle');
const effectToggle = $('#effect-toggle');

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function updateThemeButton() {
  const isLight = currentTheme() === 'light';
  themeToggle.innerHTML = icon(isLight ? 'moon' : 'sun', 19);
  themeToggle.title = isLight ? '切换到暗色主题' : '切换到亮色主题';
  themeToggle.setAttribute('aria-label', themeToggle.title);
  themeToggle.setAttribute('aria-pressed', String(isLight));
}

themeToggle.addEventListener('click', () => {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('sr-theme', next); } catch (_) {}
  updateThemeButton();
});

let effectsEnabled = true;
try { effectsEnabled = localStorage.getItem('sr-effects') !== 'off'; } catch (_) {}
effectToggle.checked = effectsEnabled;
document.documentElement.classList.toggle('effects-off', !effectsEnabled);
effectToggle.addEventListener('change', () => {
  effectsEnabled = effectToggle.checked;
  document.documentElement.classList.toggle('effects-off', !effectsEnabled);
  try { localStorage.setItem('sr-effects', effectsEnabled ? 'on' : 'off'); } catch (_) {}
});

updateThemeButton();
$('#brand').addEventListener('click', () => navigate('#/library'));
window.addEventListener('hashchange', render);
render();
