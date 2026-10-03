const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const toast = $('#toast');
let toastTimer;
let aiStatus = { chat: false, vision: false, embedding: false, transcribe: false, image: false };

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(body.detail) ? body.detail.map((d) => d.msg).join('；') : body.detail;
    throw new Error(detail || `請求失敗（${response.status}）`);
  }
  return body;
}

const jsonBody = (data, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});

/* ---------- 導覽 ---------- */

function showView() {
  const name = location.hash.replace('#', '') || 'library';
  const view = $(`#view-${name}`) ? name : 'library';
  $$('.view').forEach((section) => { section.hidden = section.id !== `view-${view}`; });
  $$('.nav-item').forEach((link) => link.classList.toggle('active', link.dataset.view === view));
  $('#crumbTitle').textContent = $(`#view-${view}`).dataset.title;
}

async function loadHealth() {
  const badge = $('#aiStatus');
  try {
    const health = await api('/api/health');
    aiStatus = health.ai;
    const features = { chat: '對話／圖片辨識', embedding: '語意搜尋', transcribe: '語音轉文字', image: '生圖' };
    const ready = Object.keys(features).filter((key) => aiStatus[key]).length;
    const total = Object.keys(features).length;
    badge.textContent = ready ? `AI 已連線（${ready}/${total}）` : 'AI 示範模式';
    badge.classList.toggle('demo', !ready);
    badge.title = Object.entries(features).map(([key, label]) => `${label}：${aiStatus[key] ? '✓' : '未設定'}`).join('\n');
  } catch {
    badge.textContent = '後端未連線';
    badge.classList.add('demo');
  }
}

/* ---------- 學習庫：列表與搜尋 ---------- */

const KIND_LABEL = { figure: '圖片', note: '文字', voice: '語音', drug: '藥品卡', education: '衛教單' };
const KIND_ICON = { figure: '▧', note: '✎', voice: '◉', drug: '℞', education: '▤' };
const libraryState = { q: '', mode: 'auto', kind: '', tag: '', items: [] };

async function loadLibrary() {
  const params = new URLSearchParams();
  for (const key of ['q', 'mode', 'kind', 'tag']) if (libraryState[key]) params.set(key, libraryState[key]);
  try {
    const data = await api(`/api/library?${params}`);
    libraryState.items = data.items;
    renderLibrary(data);
  } catch (error) {
    showToast(error.message);
  }
}

async function loadTags() {
  const { tags } = await api('/api/library/tags');
  $('#tagCloud').innerHTML = tags.slice(0, 14).map(([tag, count]) =>
    `<button type="button" class="chip tag-chip ${libraryState.tag === tag ? 'active' : ''}" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)} <small>${count}</small></button>`
  ).join('');
}

function renderLibrary({ items, search_mode: mode }) {
  const grid = $('#libraryGrid');
  $('#libraryEmpty').hidden = items.length > 0 || Boolean(libraryState.q || libraryState.tag || libraryState.kind);
  const modeText = { hybrid: '智慧搜尋（語意＋關鍵字）', keyword: '關鍵字搜尋' }[mode];
  $('#searchMeta').textContent = libraryState.q
    ? `「${libraryState.q}」找到 ${items.length} 筆・${modeText}${mode === 'keyword' && libraryState.mode === 'auto' ? '（語意搜尋需設定 AI）' : ''}`
    : '';

  grid.innerHTML = items.map((item) => {
    const thumb = item.image_url
      ? `<img src="${escapeHtml(item.image_url)}" alt="" loading="lazy" />`
      : `<span class="thumb-placeholder ${escapeHtml(item.kind)}">${KIND_ICON[item.kind] || '▤'}</span>`;
    const source = item.source_title || item.source_url;
    const excerpt = item.ai_summary || item.note || item.extracted_text;
    return `
      <button type="button" class="library-card" data-id="${item.id}">
        <div class="library-thumb">${thumb}<span class="kind-badge">${KIND_LABEL[item.kind] || item.kind}</span></div>
        <div class="library-card-body">
          <b>${escapeHtml(item.title)}</b>
          ${excerpt ? `<p>${escapeHtml(excerpt)}</p>` : ''}
          <div class="card-tags">${item.tags.slice(0, 3).map((t) => `<span>#${escapeHtml(t)}</span>`).join('')}</div>
          ${source ? `<small class="card-source">來源：${escapeHtml(source)}${item.source_year ? `（${escapeHtml(item.source_year)}）` : ''}</small>` : ''}
        </div>
      </button>`;
  }).join('');
}

$('#librarySearchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  libraryState.q = $('#libraryQuery').value.trim();
  libraryState.mode = $('#librarySearchMode').value;
  loadLibrary();
});

$('#libraryQuery').addEventListener('search', () => {
  if (!$('#libraryQuery').value) { libraryState.q = ''; loadLibrary(); }
});

$('.kind-tabs').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-kind]');
  if (!chip) return;
  libraryState.kind = chip.dataset.kind;
  $$('.kind-tabs .chip').forEach((c) => c.classList.toggle('active', c === chip));
  loadLibrary();
});

$('#tagCloud').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-tag]');
  if (!chip) return;
  libraryState.tag = libraryState.tag === chip.dataset.tag ? '' : chip.dataset.tag;
  loadTags();
  loadLibrary();
});

/* ---------- 學習庫：檢視 ---------- */

const viewer = $('#libraryViewer');

$('#libraryGrid').addEventListener('click', (event) => {
  const card = event.target.closest('.library-card');
  if (!card) return;
  const item = libraryState.items.find((i) => i.id === Number(card.dataset.id));
  if (item) openViewer(item);
});

function openViewer(item) {
  const url = safeUrl(item.source_url);
  const meta = item.ai_meta || {};
  $('#viewerBody').innerHTML = `
    <div class="dialog-head">
      <div><p class="eyebrow">${KIND_LABEL[item.kind] || ''}${item.topic ? `・${escapeHtml(item.topic)}` : ''}</p><h2>${escapeHtml(item.title)}</h2></div>
      <button class="close-button" type="button" data-close aria-label="關閉">×</button>
    </div>
    ${item.image_url ? `<a class="viewer-image" href="${escapeHtml(item.image_url)}" target="_blank" rel="noopener"><img src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.title)}" /></a>` : ''}
    ${item.audio_url ? `<audio class="viewer-audio" controls src="${escapeHtml(item.audio_url)}"></audio>` : ''}
    ${item.source_title || url ? `<div class="viewer-source">
      <b>來源</b>
      <span>${escapeHtml(item.source_title || '—')}${item.source_year ? `（${escapeHtml(item.source_year)}）` : ''}</span>
      ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">開啟原始來源 ↗</a>` : ''}
    </div>` : ''}
    ${item.ai_summary ? `<div class="viewer-block"><b>摘要 ${meta.mode === 'azure' ? '<span class="ai-label">AI 產生，待醫師確認</span>' : ''}</b><p>${escapeHtml(item.ai_summary)}</p></div>` : ''}
    ${item.kind === 'note' && item.note ? `<div class="viewer-block"><b>筆記內容</b><p>${escapeHtml(item.note)}</p></div>` : ''}
    ${item.kind === 'voice' && item.extracted_text ? `<details class="viewer-block" open><summary><b>逐字稿</b></summary><p>${escapeHtml(item.extracted_text)}</p></details>` : ''}
    ${item.kind === 'figure' && item.extracted_text ? `<details class="viewer-block"><summary><b>圖中文字</b></summary><p>${escapeHtml(item.extracted_text)}</p></details>` : ''}
    ${item.kind !== 'note' && item.note ? `<div class="viewer-block"><b>我的註記</b><p>${escapeHtml(item.note)}</p></div>` : ''}
    <div class="card-tags">${item.tags.map((t) => `<span>#${escapeHtml(t)}</span>`).join('')}</div>
    <div class="dialog-actions">
      <button class="danger-button" type="button" data-delete="${item.id}">刪除</button>
      <button class="secondary-button" type="button" data-edit="${item.id}">編輯</button>
    </div>`;
  viewer.showModal();
}

viewer.addEventListener('click', async (event) => {
  if (event.target === viewer || event.target.closest('[data-close]')) return viewer.close();
  const edit = event.target.closest('[data-edit]');
  if (edit) {
    viewer.close();
    openLibraryForm(libraryState.items.find((i) => i.id === Number(edit.dataset.edit)));
  }
  const del = event.target.closest('[data-delete]');
  if (del && confirm('確定刪除這筆筆記（含圖片或錄音）？此動作無法復原。')) {
    await api(`/api/library/${del.dataset.delete}`, { method: 'DELETE' });
    viewer.close();
    showToast('已刪除');
    refreshLibrary();
  }
});

/* ---------- 學習庫：新增／編輯 ---------- */
// 流程：步驟 1 選擇方式並提供內容 → 步驟 2 AI 處理 → 步驟 3 醫師確認與編輯後儲存

const libraryDialog = $('#libraryDialog');
const form = {
  title: $('#fTitle'), topic: $('#fTopic'), tags: $('#fTags'), summary: $('#fSummary'),
  content: $('#fContent'), sourceTitle: $('#fSourceTitle'), sourceUrl: $('#fSourceUrl'),
  sourceYear: $('#fSourceYear'), note: $('#fNote'),
};
const MODE_KIND = { image: 'figure', text: 'note', voice: 'voice' };
const KIND_MODE = { figure: 'image', note: 'text', voice: 'voice' };
const CONTENT_LABEL = {
  figure: '圖中文字（供搜尋用）',
  note: '筆記內容',
  voice: '逐字稿',
};

let inputMode = 'image';
let editing = null;
let uploaded = {};
let aiMeta = {};

function showStep(step) {
  $('#stepInput').hidden = step !== 'input';
  $('#stepLoading').hidden = step !== 'loading';
  $('#stepReview').hidden = step !== 'review';
  $('#librarySaveButton').hidden = step !== 'review';
  $('#backButton').hidden = step !== 'review' || Boolean(editing);
  $('#libraryFormError').textContent = '';
}

function setInputMode(mode) {
  inputMode = mode;
  $$('.mode-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === mode));
  $$('.mode-panel').forEach((panel) => { panel.hidden = panel.dataset.panel !== mode; });
}

function openLibraryForm(item = null) {
  editing = item;
  uploaded = {};
  aiMeta = {};
  stopRecording(true);
  $('#textInput').value = '';
  $('#libraryImage').value = '';
  $('#audioFile').value = '';
  if (item) {
    $('#libraryDialogTitle').textContent = '編輯筆記';
    uploaded = { image_path: item.image_path, image_url: item.image_url, audio_path: item.audio_path, audio_url: item.audio_url };
    aiMeta = item.ai_meta || {};
    fillReview(item.kind, {
      title: item.title, topic: item.topic, tags: item.tags, summary: item.ai_summary,
      content: item.kind === 'note' ? item.note : item.extracted_text,
      source_title: item.source_title, source_url: item.source_url, source_year: item.source_year,
      note: item.kind === 'note' ? '' : item.note,
    });
    $('#aiResult').hidden = true;
    showStep('review');
  } else {
    $('#libraryDialogTitle').textContent = '新增筆記';
    setInputMode('image');
    showStep('input');
  }
  libraryDialog.showModal();
}

function fillReview(kind, data) {
  form.title.value = data.title || '';
  form.topic.value = data.topic || '';
  form.tags.value = (data.tags || []).join(', ');
  form.summary.value = data.summary || '';
  form.content.value = data.content || '';
  form.sourceTitle.value = data.source_title || '';
  form.sourceUrl.value = data.source_url || '';
  form.sourceYear.value = data.source_year || '';
  form.note.value = data.note || '';
  $('#contentLabel').textContent = CONTENT_LABEL[kind] || '內容';
  $('#noteField').hidden = kind === 'note';
  form.content.rows = kind === 'figure' ? 4 : 7;

  const preview = $('#reviewPreview');
  if (uploaded.image_url) {
    preview.innerHTML = `<a href="${escapeHtml(uploaded.image_url)}" target="_blank" rel="noopener"><img src="${escapeHtml(uploaded.image_url)}" alt="上傳的圖片" /></a>`;
  } else if (uploaded.audio_url) {
    preview.innerHTML = `<div class="audio-preview"><span>◉</span><b>錄音</b><audio controls src="${escapeHtml(uploaded.audio_url)}"></audio></div>`;
  } else {
    preview.innerHTML = '';
  }
  preview.hidden = !preview.innerHTML;
  $('#reviewGrid').classList.toggle('single', preview.hidden);
  libraryDialog.dataset.kind = kind;
}

async function runAnalysis(payload, loadingText) {
  $('#loadingText').textContent = loadingText;
  showStep('loading');
  const kind = MODE_KIND[payload.mode];
  try {
    const result = await api('/api/library/analyze', jsonBody(payload));
    aiMeta = result.ai_meta;
    const s = result.suggestion || {};
    fillReview(kind, {
      ...s,
      content: payload.mode === 'text' ? payload.text : payload.mode === 'voice' ? result.transcript : s.extracted_text,
    });
    const ai = $('#aiResult');
    ai.hidden = false;
    ai.classList.toggle('warn', Boolean(result.message));
    ai.textContent = result.message
      || `✦ AI 已整理完成（${aiMeta.model}）${s.source_title ? '，並帶入辨識到的來源' : ''}。請確認內容後儲存。`;
  } catch (error) {
    // AI 失敗時仍讓醫師手動完成
    fillReview(kind, { content: payload.text || '' });
    const ai = $('#aiResult');
    ai.hidden = false;
    ai.classList.add('warn');
    ai.textContent = `AI 處理失敗：${error.message}。你可以手動輸入內容後儲存。`;
  }
  showStep('review');
  form.title.focus();
}

async function uploadFile(endpoint, file, fieldName = 'file') {
  const data = new FormData();
  data.append(fieldName, file, file.name || 'recording');
  return api(endpoint, { method: 'POST', body: data });
}

/* 圖片 */
async function handleImage(file) {
  if (!file) return;
  $('#loadingText').textContent = '上傳圖片中…';
  showStep('loading');
  try {
    uploaded = await uploadFile('/api/library/uploads', file);
    await runAnalysis({ mode: 'image', image_path: uploaded.image_path }, 'AI 辨識圖片中…');
  } catch (error) {
    showStep('input');
    showToast(error.message);
  }
}

/* 文字 */
$('#textSubmit').addEventListener('click', () => {
  const text = $('#textInput').value.trim();
  if (!text) return showToast('請先輸入筆記內容');
  uploaded = {};
  runAnalysis({ mode: 'text', text }, 'AI 整理文字中…');
});

/* 語音：上傳音檔 */
async function handleAudio(file) {
  if (!file) return;
  $('#loadingText').textContent = '上傳音檔中…';
  showStep('loading');
  try {
    uploaded = await uploadFile('/api/library/audio', file);
    await runAnalysis({ mode: 'voice', audio_path: uploaded.audio_path }, 'AI 轉逐字稿並整理中…');
  } catch (error) {
    showStep('input');
    showToast(error.message);
  }
}

/* 語音：即時錄音 */
const MAX_RECORD_SECONDS = 600;
let recorder = null;
let recordChunks = [];
let recordStart = 0;
let recordTimer = null;

function pickAudioType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    return showToast('這個瀏覽器不支援錄音，請改用上傳錄音檔');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return showToast('無法使用麥克風，請在瀏覽器允許麥克風權限');
  }
  const mimeType = pickAudioType();
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  recorder = rec;
  recordChunks = [];
  rec.ondataavailable = (event) => { if (event.data.size) recordChunks.push(event.data); };
  rec.onstop = () => {
    stream.getTracks().forEach((track) => track.stop());
    if (rec.discard) return;
    const type = rec.mimeType || 'audio/webm';
    const ext = type.includes('mp4') ? 'm4a' : 'webm';
    handleAudio(new File(recordChunks, `recording.${ext}`, { type: type.split(';')[0] }));
  };
  rec.start();
  recordStart = Date.now();
  $('#recordButton').classList.add('recording');
  $('#recordButton').setAttribute('aria-label', '停止錄音');
  $('#recordStatus').textContent = '錄音中…再按一次結束並送出';
  recordTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - recordStart) / 1000);
    $('#recordTimer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    if (seconds >= MAX_RECORD_SECONDS) stopRecording();
  }, 250);
}

function stopRecording(discard = false) {
  clearInterval(recordTimer);
  $('#recordButton').classList.remove('recording');
  $('#recordButton').setAttribute('aria-label', '開始錄音');
  $('#recordStatus').textContent = '按下開始錄音';
  $('#recordTimer').textContent = '00:00';
  if (recorder && recorder.state !== 'inactive') {
    recorder.discard = discard;
    recorder.stop();
  }
  if (discard) recorder = null;
}

$('#recordButton').addEventListener('click', () => {
  if (recorder && recorder.state === 'recording') stopRecording();
  else startRecording();
});

/* 事件 */
$('#addLibraryButton').addEventListener('click', () => openLibraryForm());
$('.mode-tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('[data-mode]');
  if (tab && !(recorder && recorder.state === 'recording')) setInputMode(tab.dataset.mode);
});
$('#libraryImage').addEventListener('change', (event) => handleImage(event.target.files[0]));
$('#audioFile').addEventListener('change', (event) => handleAudio(event.target.files[0]));
$('#backButton').addEventListener('click', () => {
  uploaded = {};
  $('#libraryImage').value = '';
  $('#audioFile').value = '';
  showStep('input');
});

const dropzone = $('#dropzone');
dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('dragging'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragging');
  handleImage(event.dataTransfer.files[0]);
});

libraryDialog.addEventListener('click', (event) => {
  if (event.target === libraryDialog || event.target.closest('[data-close]')) libraryDialog.close();
});
libraryDialog.addEventListener('close', () => stopRecording(true));

$('#libraryForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#libraryFormError');
  const kind = editing?.kind || libraryDialog.dataset.kind || MODE_KIND[inputMode];
  const content = form.content.value;
  const payload = {
    kind,
    title: form.title.value.trim(),
    topic: form.topic.value.trim(),
    tags: form.tags.value.split(/[,，、]/).map((t) => t.trim()).filter(Boolean),
    note: kind === 'note' ? content : form.note.value,
    extracted_text: kind === 'note' ? '' : content,
    source_title: form.sourceTitle.value.trim(),
    source_url: form.sourceUrl.value.trim(),
    source_year: form.sourceYear.value.trim(),
    image_path: uploaded.image_path || '',
    audio_path: uploaded.audio_path || '',
    ai_summary: form.summary.value.trim(),
    ai_meta: aiMeta,
    ref_type: editing?.ref_type || '',
    ref_id: editing?.ref_id || '',
  };
  if (!payload.title) return (error.textContent = '請填寫標題');
  if (kind === 'note' && !content.trim()) return (error.textContent = '請輸入筆記內容');

  const save = $('#librarySaveButton');
  save.disabled = true;
  try {
    await api(editing ? `/api/library/${editing.id}` : '/api/library', jsonBody(payload, editing ? 'PUT' : 'POST'));
    libraryDialog.close();
    showToast(editing ? '已更新' : '已加入學習庫');
    refreshLibrary();
  } catch (err) {
    error.textContent = err.message;
  } finally {
    save.disabled = false;
  }
});

function refreshLibrary() {
  loadTags();
  loadLibrary();
}

/* ---------- 啟動 ---------- */

window.addEventListener('hashchange', showView);
showView();
loadHealth();
refreshLibrary();
