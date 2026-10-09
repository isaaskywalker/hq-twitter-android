import { FFmpeg } from './vendor/ffmpeg/index.js';
import { toBlobURL } from './vendor/util/index.js';

// 갤럭시 앱(WebView) 안에서 실행 중이면 window.HqNative 가 있다 → 갤러리 저장, 내장 ffmpeg 코어 사용
const NATIVE = (() => { try { return window.HqNative?.isNative() === true; } catch { return false; } })();
const CORE_BASE = NATIVE
  ? new URL('core', location.href).href
  : 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const resultsEl = $('results');

// ---------- 설정 (기기에만 저장) ----------
for (const id of ['autoSave', 'gifAsMp4']) {
  try {
    const v = localStorage.getItem(id);
    if (v !== null) $(id).checked = v === '1';
  } catch {}
  $(id).addEventListener('change', (e) => {
    try { localStorage.setItem(id, e.target.checked ? '1' : '0'); } catch {}
  });
}

function setStatus(msg, isErr = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('err', isErr);
}

// ---------- 트윗 ID 추출 ----------
export function parseTweetId(input) {
  if (!input) return null;
  const m = input.match(/(?:twitter|x|fxtwitter|vxtwitter|fixupx|fixvx)\.com\/(?:i\/web\/|i\/)?[^/?#\s]*\/?status(?:es)?\/(\d{5,25})/i)
    || input.match(/\/status(?:es)?\/(\d{5,25})/i)
    || input.trim().match(/^(\d{5,25})$/);
  return m ? m[1] : null;
}

// ---------- 트윗 정보 가져오기 ----------
function bestMp4(list) {
  const mp4 = (list || []).filter((v) => (v.container === 'mp4') || (v.content_type === 'video/mp4') || /\.mp4(\?|$)/.test(v.url));
  mp4.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return mp4[0]?.url;
}

function normalizeFx(media) {
  return (media || []).filter((m) => m.type !== 'photo').map((m) => {
    const url = bestMp4(m.formats || m.variants) || m.url;
    return { type: m.type === 'gif' ? 'gif' : 'video', url, ext: 'mp4', width: m.width, height: m.height, thumb: m.thumbnail_url };
  });
}

async function fetchFx(id) {
  const res = await fetch(`https://api.fxtwitter.com/status/${id}`);
  const data = await res.json().catch(() => null);
  if (!data?.tweet) throw new Error(data?.message || `fxtwitter ${res.status}`);
  const t = data.tweet;
  let media = t.media?.all;
  if (!media?.length && t.quote?.media?.all?.length) media = t.quote.media.all;
  return { user: t.author?.screen_name || 'twitter', media: normalizeFx(media) };
}

async function fetchVx(id) {
  const res = await fetch(`https://api.vxtwitter.com/i/status/${id}`);
  const data = await res.json().catch(() => null);
  if (!data || !Array.isArray(data.media_extended)) throw new Error(`vxtwitter ${res.status}`);
  const media = data.media_extended.filter((m) => m.type !== 'image').map((m) => {
    return { type: m.type === 'gif' ? 'gif' : 'video', url: m.url, ext: 'mp4',
      width: m.size?.width, height: m.size?.height, thumb: m.thumbnail_url };
  });
  return { user: data.user_screen_name || 'twitter', media };
}

// 외부 API 응답은 믿지 않는다: 트위터 미디어 서버(https)의 주소만 받고, 계정 이름은 파일명에 안전한 글자만 남긴다
function isTwimg(url, host) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === host;
  } catch { return false; }
}

function sanitize(r) {
  const user = String(r.user || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 15) || 'twitter';
  const media = r.media
    .filter((m) => isTwimg(m.url, 'video.twimg.com'))
    .map((m) => ({ ...m, thumb: isTwimg(m.thumb, 'pbs.twimg.com') ? m.thumb : null }));
  return { user, media };
}

async function fetchTweet(id) {
  const errors = [];
  for (const fn of [fetchFx, fetchVx]) {
    try {
      const r = sanitize(await fn(id));
      if (r.media.length) return r;
      errors.push('미디어 없음');
    } catch (e) { errors.push(e.message); }
  }
  throw new Error(errors.includes('미디어 없음')
    ? '이 트윗에는 영상이나 GIF가 없어요.'
    : '트윗을 불러오지 못했어요. 삭제됐거나 비공개 트윗일 수 있어요.');
}

// ---------- 다운로드 (진행률 표시) ----------
async function download(url, onProgress) {
  // twimg는 다른 사이트의 Referer가 붙으면 403을 준다
  const res = await fetch(url, { referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`다운로드 실패 (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(Math.min(got / total, 1));
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

// ---------- ffmpeg: mp4 → 고화질 GIF ----------
let ffmpegPromise = null;
function getFFmpeg(onStatus) {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ff = new FFmpeg();
      onStatus?.('GIF 변환기 불러오는 중… (처음 한 번만 약 30MB)');
      await ff.load({
        coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      return ff;
    })().catch((e) => { ffmpegPromise = null; throw e; });
  }
  return ffmpegPromise;
}

let convertQueue = Promise.resolve();
function mp4ToGif(mp4Bytes, onStatus, onProgress) {
  // ffmpeg 인스턴스는 하나라서 순서대로 변환
  const job = convertQueue.then(async () => {
    const ff = await getFFmpeg(onStatus);
    const handler = ({ progress }) => onProgress?.(Math.max(0, Math.min(1, progress)));
    ff.on('progress', handler);
    try {
      await ff.writeFile('in.mp4', mp4Bytes);
      onStatus?.('GIF로 변환 중…');
      // 원본 해상도·프레임레이트 유지, 영상 전체에서 최적 256색 팔레트를 뽑아 적용
      const code = await ff.exec([
        '-i', 'in.mp4',
        '-filter_complex',
        '[0:v]split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a',
        '-loop', '0',
        '-y', 'out.gif',
      ]);
      if (code !== 0) throw new Error('GIF 변환에 실패했어요.');
      const data = await ff.readFile('out.gif');
      await ff.deleteFile('in.mp4').catch(() => {});
      await ff.deleteFile('out.gif').catch(() => {});
      return data;
    } finally {
      ff.off('progress', handler);
    }
  });
  convertQueue = job.catch(() => {});
  return job;
}

// ---------- 저장 / 공유 ----------
const MIME = { gif: 'image/gif', mp4: 'video/mp4' };

function saveFile(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

// ---------- 갤러리 저장 (앱 전용) ----------
const nativeJobs = new Map();
window.__native = {
  progress: (id, p) => nativeJobs.get(id)?.onProgress?.(p),
  done: (id, size) => { nativeJobs.get(id)?.resolve(size); nativeJobs.delete(id); },
  fail: (id, msg) => { nativeJobs.get(id)?.reject(new Error(msg)); nativeJobs.delete(id); },
};
const jobId = () => Math.random().toString(36).slice(2);

function check(err) {
  if (err) throw new Error(err);
}

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function saveBytesToGallery(bytes, name, mime) {
  const id = jobId();
  check(HqNative.begin(id, name, mime));
  try {
    const CHUNK = 3 * 256 * 1024; // 3의 배수여야 조각별 base64가 이어 붙는다
    for (let i = 0; i < bytes.length; i += CHUNK) check(HqNative.append(id, toBase64(bytes.subarray(i, i + CHUNK))));
  } catch (e) {
    HqNative.abort(id);
    throw e;
  }
  check(HqNative.finish(id));
}

function saveUrlToGallery(url, name, mime, onProgress) {
  return new Promise((resolve, reject) => {
    const id = jobId();
    nativeJobs.set(id, { resolve, reject, onProgress });
    HqNative.saveUrl(id, url, name, mime);
  });
}

async function shareFile(file) {
  try {
    await navigator.share({ files: [file] });
  } catch (e) {
    if (e.name !== 'AbortError') setStatus('공유를 지원하지 않아서 대신 저장할게요.'), saveFile(file);
  }
}

// ---------- UI ----------
function fmtSize(n) {
  return n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`;
}

function renderItem(m, label) {
  const el = document.createElement('div');
  el.className = 'item';
  el.innerHTML = `
    <div class="preview"></div>
    <div class="meta"><span class="badge"></span><span class="info"></span></div>
    <div class="state" style="font-size:13px;color:var(--muted)"></div>
    <progress max="1" value="0"></progress>
    <div class="row actions" style="margin-top:10px;display:none">
      <button class="save">⬇️ 저장</button>
      <button class="share secondary">공유</button>
    </div>`;
  const prev = el.querySelector('.preview');
  if (m.thumb) {
    const img = new Image();
    img.src = m.thumb;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    prev.appendChild(img);
  }
  el.querySelector('.badge').textContent = label;
  el.querySelector('.info').textContent = m.width ? `${m.width}×${m.height}` : '';
  resultsEl.appendChild(el);
  return {
    el,
    state: (t) => { el.querySelector('.state').textContent = t; },
    progress: (p) => { el.querySelector('progress').value = p; },
    done(file, previewURL) {
      el.querySelector('progress').remove();
      el.querySelector('.state').textContent = `${file.name} · ${fmtSize(file.size)}`;
      if (previewURL) {
        prev.innerHTML = '';
        const node = file.type.startsWith('video/') ? document.createElement('video') : new Image();
        node.src = previewURL;
        if (node.tagName === 'VIDEO') { node.controls = true; node.playsInline = true; node.muted = true; node.loop = true; }
        prev.appendChild(node);
      }
      const actions = el.querySelector('.actions');
      actions.style.display = '';
      actions.querySelector('.save').onclick = () => saveFile(file);
      const shareBtn = actions.querySelector('.share');
      if (navigator.canShare?.({ files: [file] })) shareBtn.onclick = () => shareFile(file);
      else shareBtn.remove();
    },
    saved(name, size, previewURL, mime) {
      el.querySelector('progress').remove();
      el.querySelector('.state').textContent = `✅ 갤러리에 저장했어요 · ${name} · ${fmtSize(Number(size))}`;
      prev.innerHTML = '';
      const node = mime.startsWith('video/') ? document.createElement('video') : new Image();
      node.src = previewURL;
      if (node.tagName === 'VIDEO') { node.controls = true; node.playsInline = true; node.muted = true; node.loop = true; }
      prev.appendChild(node);
    },
    fail(msg) {
      el.querySelector('.state').textContent = msg;
      el.querySelector('.state').style.color = 'var(--err)';
      el.querySelector('progress')?.remove();
    },
  };
}

const TYPE_LABEL = { video: '영상 (최고 화질)', gif: 'GIF' };

async function processMedia(m, idx, tweetId, user, autoSave) {
  const asMp4 = m.type === 'gif' && $('gifAsMp4').checked;
  const ui = renderItem(m, m.type === 'gif' && asMp4 ? 'GIF (mp4 원본)' : TYPE_LABEL[m.type]);
  try {
    if (NATIVE) return await processNative(m, asMp4, `${user}_${tweetId}_${idx + 1}`, ui);
    ui.state('받는 중…');
    const bytes = await download(m.url, (p) => ui.progress(m.type === 'gif' && !asMp4 ? p * 0.3 : p));
    let data = bytes, ext = m.ext;
    if (m.type === 'gif' && !asMp4) {
      data = await mp4ToGif(bytes, ui.state, (p) => ui.progress(0.3 + p * 0.7));
      ext = 'gif';
    }
    const name = `${user}_${tweetId}_${idx + 1}.${ext}`;
    const file = new File([data], name, { type: MIME[ext] || 'application/octet-stream' });
    const previewURL = URL.createObjectURL(file);
    ui.done(file, previewURL);
    if (autoSave) saveFile(file);
    return true;
  } catch (e) {
    console.error(e);
    ui.fail(e.message || '실패했어요.');
    return false;
  }
}

async function processNative(m, asMp4, base, ui) {
  if (m.type === 'video' || asMp4) {
    // 영상은 앱이 직접 받아서 저장 (긴 영상도 메모리 걱정 없음)
    ui.state('받아서 갤러리에 저장하는 중…');
    const name = `${base}.mp4`;
    const size = await saveUrlToGallery(m.url, name, 'video/mp4', ui.progress);
    ui.saved(name, size, m.url, 'video/mp4');
    return true;
  }
  ui.state('받는 중…');
  const mp4 = await download(m.url, (p) => ui.progress(p * 0.3));
  const gif = await mp4ToGif(mp4, ui.state, (p) => ui.progress(0.3 + p * 0.7));
  const name = `${base}.gif`;
  ui.state('갤러리에 저장하는 중…');
  saveBytesToGallery(gif, name, 'image/gif');
  ui.saved(name, gif.length, URL.createObjectURL(new Blob([gif], { type: 'image/gif' })), 'image/gif');
  return true;
}

let running = false;
async function run(input, fromShare = false) {
  if (running) return;
  const id = parseTweetId(input);
  if (!id) return setStatus('트윗 링크를 찾지 못했어요. x.com/…/status/… 형식의 링크를 넣어주세요.', true);
  running = true;
  resultsEl.innerHTML = '';
  setStatus('트윗 불러오는 중…');
  try {
    const { user, media } = await fetchTweet(id);
    const counts = media.reduce((o, m) => (o[m.type] = (o[m.type] || 0) + 1, o), {});
    setStatus(`@${user} · ` + Object.entries(counts).map(([t, n]) => `${TYPE_LABEL[t].split(' ')[0]} ${n}개`).join(', '));
    const autoSave = NATIVE || $('autoSave').checked;
    const results = await Promise.all(media.map((m, i) => processMedia(m, i, id, user, autoSave)));
    const ok = results.filter(Boolean).length;
    if (NATIVE && ok) HqNative.toast(`갤러리에 ${ok}개 저장했어요`);
    setStatus(`@${user} · ${ok}/${media.length}개 완료${autoSave && ok ? (NATIVE ? '. 갤러리에 저장했어요' : '. 다운로드 폴더에 저장했어요') : ''}`, ok === 0);
    // 공유로 열렸고 전부 저장됐으면 X로 돌아간다 (실패가 있으면 화면을 남겨서 이유를 보여준다)
    if (NATIVE && fromShare && ok === media.length) setTimeout(() => HqNative.returnToSource(), 600);
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    running = false;
  }
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  run($('link').value);
});

// 공유로 열렸을 때 (?text=…&url=…)
const qs = new URLSearchParams(location.search);
const shared = [qs.get('url'), qs.get('text'), qs.get('title')].filter(Boolean).join(' ');
if (shared) {
  $('link').value = shared.match(/https?:\/\/\S+/)?.[0] || shared;
  history.replaceState(null, '', location.pathname);
  run(shared, true);
}

// 설치 버튼
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $('install').style.display = 'block';
});
$('install').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $('install').style.display = 'none';
});

if (NATIVE) {
  document.documentElement.classList.add('native');
} else if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
