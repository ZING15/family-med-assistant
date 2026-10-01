const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const toast = $('#toast');
let toastTimer;
let aiStatus = { chat: false, vision: false, embedding: false, image: false };

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
    const ready = Object.values(aiStatus).filter(Boolean).length;
    badge.textContent = ready ? `AI 已連線（${ready}/4）` : 'AI 示範模式';
    badge.classList.toggle('demo', !ready);
    badge.title = `對話/視覺：${aiStatus.chat ? '✓' : '—'}　語意搜尋：${aiStatus.embedding ? '✓' : '—'}　生圖：${aiStatus.image ? '✓' : '—'}`;
  } catch {
    badge.textContent = '後端未連線';
    badge.classList.add('demo');
  }
}

/* ---------- 學習庫：列表與搜尋 ---------- */

const KIND_LABEL = { figure: '期刊圖表', drug: '藥品卡', education: '衛教單', note: '筆記' };
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
      : `<span class="thumb-placeholder ${escapeHtml(item.kind)}">${item.kind === 'drug' ? '℞' : '▤'}</span>`;
    const source = item.source_title || item.source_url;
    return `
      <button type="button" class="library-card" data-id="${item.id}">
        <div class="library-thumb">${thumb}<span class="kind-badge">${KIND_LABEL[item.kind] || item.kind}</span></div>
        <div class="library-card-body">
          <b>${escapeHtml(item.title)}</b>
          ${item.ai_summary ? `<p>${escapeHtml(item.ai_summary)}</p>` : ''}
          <div class="card-tags">${item.tags.slice(0, 3).map((t) => `<span>#${escapeHtml(t)}</span>`).join('')}</div>
          <small class="card-source">${source ? `來源：${escapeHtml(source)}${item.source_year ? `（${escapeHtml(item.source_year)}）` : ''}` : '未填來源'}</small>
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
    <div class="viewer-source">
      <b>來源</b>
      <span>${escapeHtml(item.source_title || '—')}${item.source_year ? `（${escapeHtml(item.source_year)}）` : ''}</span>
      ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">開啟原始來源 ↗</a>` : ''}
    </div>
    ${item.ai_summary ? `<div class="viewer-block"><b>摘要 ${meta.mode === 'azure' ? '<span class="ai-label">AI 產生，待醫師確認</span>' : ''}</b><p>${escapeHtml(item.ai_summary)}</p></div>` : ''}
    ${item.note ? `<div class="viewer-block"><b>我的註記</b><p>${escapeHtml(item.note)}</p></div>` : ''}
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
  if (del && confirm('確定刪除這筆筆記與圖片？此動作無法復原。')) {
    await api(`/api/library/${del.dataset.delete}`, { method: 'DELETE' });
    viewer.close();
    showToast('已刪除');
    refreshLibrary();
  }
});

/* ---------- 學習庫：新增／編輯 ---------- */

const libraryDialog = $('#libraryDialog');
const form = {
  title: $('#fTitle'), topic: $('#fTopic'), tags: $('#fTags'), sourceTitle: $('#fSourceTitle'),
  sourceUrl: $('#fSourceUrl'), sourceYear: $('#fSourceYear'), summary: $('#fSummary'),
  note: $('#fNote'), extracted: $('#fExtracted'),
};
let editing = null;
let uploaded = { image_path: '', image_url: '' };
let aiMeta = {};
let titleFromFile = '';

function openLibraryForm(item = null) {
  editing = item;
  uploaded = { image_path: item?.image_path || '', image_url: item?.image_url || '' };
  aiMeta = item?.ai_meta || {};
  titleFromFile = '';
  $('#libraryDialogTitle').textContent = item ? '編輯筆記' : '新增圖表';
  form.title.value = item?.title || '';
  form.topic.value = item?.topic || '';
  form.tags.value = (item?.tags || []).join(', ');
  form.sourceTitle.value = item?.source_title || '';
  form.sourceUrl.value = item?.source_url || '';
  form.sourceYear.value = item?.source_year || '';
  form.summary.value = item?.ai_summary || '';
  form.note.value = item?.note || '';
  form.extracted.value = item?.extracted_text || '';
  $('#libraryFormError').textContent = '';
  $('#libraryImage').value = '';
  setPreview(uploaded.image_url);
  libraryDialog.showModal();
}

function setPreview(url) {
  $('#libraryPreview').hidden = !url;
  $('#dropzoneHint').hidden = Boolean(url);
  if (url) $('#libraryPreview').src = url;
  $('#analyzeButton').disabled = !uploaded.image_path;
  $('#analyzeNote').textContent = aiStatus.vision
    ? 'AI 只整理圖中文字與標籤，不做判讀。'
    : '示範模式：設定 Azure OpenAI 後才會辨識圖片。';
}

async function uploadFile(file) {
  if (!file) return;
  const data = new FormData();
  data.append('file', file);
  $('#dropzoneHint').innerHTML = '上傳中…';
  try {
    uploaded = await api('/api/library/uploads', { method: 'POST', body: data });
    setPreview(uploaded.image_url);
    if (!form.title.value) form.title.value = titleFromFile = file.name.replace(/\.[^.]+$/, '');
    if (aiStatus.vision) analyzeImage();
  } catch (error) {
    $('#dropzoneHint').innerHTML = '點擊或拖曳圖片到這裡<br /><small>JPG／PNG／WebP，10MB 以內</small>';
    showToast(error.message);
  }
}

async function analyzeImage() {
  const button = $('#analyzeButton');
  button.disabled = true;
  button.textContent = '✦ AI 辨識中…';
  try {
    const { suggestion, ai_meta: meta } = await api('/api/library/analyze', jsonBody({
      image_path: uploaded.image_path,
      hint: form.note.value,
    }));
    aiMeta = meta;
    if (meta.mode === 'demo') {
      showToast('示範模式：尚未設定 Azure OpenAI');
      return;
    }
    // 只填入空白欄位，避免覆蓋醫師已輸入的內容
    const fill = (input, value) => { if (value && !input.value.trim()) input.value = value; };
    if (titleFromFile && form.title.value === titleFromFile) form.title.value = '';
    fill(form.title, suggestion.title);
    fill(form.topic, suggestion.topic);
    fill(form.tags, (suggestion.tags || []).join(', '));
    fill(form.summary, suggestion.summary);
    fill(form.extracted, suggestion.extracted_text);
    fill(form.sourceTitle, suggestion.source_guess);
    showToast('AI 建議已填入，請確認後儲存');
  } catch (error) {
    showToast(`AI 辨識失敗：${error.message}`);
  } finally {
    button.disabled = !uploaded.image_path;
    button.textContent = '✦ AI 辨識並建議';
  }
}

$('#addLibraryButton').addEventListener('click', () => openLibraryForm());
$('#libraryImage').addEventListener('change', (event) => uploadFile(event.target.files[0]));
$('#analyzeButton').addEventListener('click', analyzeImage);

const dropzone = $('#dropzone');
dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('dragging'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragging');
  uploadFile(event.dataTransfer.files[0]);
});

libraryDialog.addEventListener('click', (event) => {
  if (event.target === libraryDialog || event.target.closest('[data-close]')) libraryDialog.close();
});

$('#libraryForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#libraryFormError');
  const payload = {
    kind: editing?.kind || 'figure',
    title: form.title.value.trim(),
    topic: form.topic.value.trim(),
    tags: form.tags.value.split(/[,，、]/).map((t) => t.trim()).filter(Boolean),
    note: form.note.value,
    source_title: form.sourceTitle.value.trim(),
    source_url: form.sourceUrl.value.trim(),
    source_year: form.sourceYear.value.trim(),
    image_path: uploaded.image_path,
    extracted_text: form.extracted.value,
    ai_summary: form.summary.value.trim(),
    ai_meta: aiMeta,
    ref_type: editing?.ref_type || '',
    ref_id: editing?.ref_id || '',
  };
  if (!payload.title) return (error.textContent = '請填寫標題');
  if (payload.kind === 'figure' && !payload.image_path) return (error.textContent = '請先上傳圖片');
  if (payload.kind === 'figure' && !payload.source_title && !payload.source_url) return (error.textContent = '請填寫來源（期刊名稱或連結至少一項）');

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
