const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// Lucide 圖示（index.html 內的 SVG sprite）
const icon = (name, cls = '') => `<svg class="icon${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// 圖片載入完成再淡入；外部圖片（例如 TFDA 外觀圖）失敗時移除，改顯示卡片底色占位，不出現破圖
document.addEventListener('load', (event) => {
  if (event.target.tagName === 'IMG') event.target.classList.add('loaded');
}, true);
document.addEventListener('error', (event) => {
  const img = event.target;
  if (img.tagName !== 'IMG') return;
  const box = img.closest('.cover, .rec-cover, .rx-thumb, .tile-cover, figure');
  box?.classList.add('img-failed');
  img.remove();
  // 藥品卡：外觀圖載入失敗時改顯示成分首字母，不留空白
  if (box?.dataset.glyph) box.insertAdjacentHTML('beforeend', `<span class="pill-glyph" aria-hidden="true">${escapeHtml(box.dataset.glyph)}</span>`);
}, true);

const toast = $('#toast');
let toastTimer;
let aiStatus = { chat: false, vision: false, embedding: false, transcribe: false, image: false };

// action：{ label, run }，例如「復原」。有動作時停留 10 秒，滑鼠移上去或聚焦時暫停倒數，
// 也可以用 Ctrl+Z／⌘Z 執行（焦點在輸入欄位時不攔截，保留文字的復原）
const UNDO_KEY = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘Z' : 'Ctrl+Z';
let toastAction = null;
let toastDeadline = 0;
let toastRemaining = 0;

function hideToast() {
  toast.classList.remove('show');
  toastAction = null;
}

function startToastTimer(ms) {
  clearTimeout(toastTimer);
  toastRemaining = ms;
  toastDeadline = Date.now() + ms;
  toastTimer = setTimeout(hideToast, ms);
}

function runToastAction() {
  const run = toastAction?.run;
  hideToast();
  run?.();
}

function showToast(message, action = null) {
  toastAction = action;
  toast.innerHTML = `<span>${escapeHtml(message)}</span>${action
    ? `<button type="button" aria-label="${escapeHtml(action.label)}（${UNDO_KEY}）">${escapeHtml(action.label)}<kbd>${UNDO_KEY}</kbd></button>` : ''}`;
  toast.classList.toggle('has-action', Boolean(action));
  toast.querySelector('button')?.addEventListener('click', runToastAction, { once: true });
  toast.classList.add('show');
  startToastTimer(action ? 10000 : 2600);
}

['mouseenter', 'focusin'].forEach((type) => toast.addEventListener(type, () => {
  clearTimeout(toastTimer);
  toastRemaining = Math.max(toastDeadline - Date.now(), 0);
}));
['mouseleave', 'focusout'].forEach((type) => toast.addEventListener(type, () => {
  if (toast.classList.contains('show')) startToastTimer(Math.max(toastRemaining, 2000));
}));
document.addEventListener('keydown', (event) => {
  if (!toastAction || !toast.classList.contains('show')) return;
  if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.key.toLowerCase() !== 'z') return;
  if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  event.preventDefault();
  runToastAction();
});

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

function hashParams() {
  const [, query = ''] = location.hash.split('?');
  return new URLSearchParams(query);
}

function showView() {
  const name = location.hash.replace('#', '').split('?')[0] || 'library';
  const view = $(`#view-${name}`) ? name : 'library';
  $$('.view').forEach((section) => { section.hidden = section.id !== `view-${view}`; });
  $$('.nav-item').forEach((link) => link.classList.toggle('active', link.dataset.view === view));
  document.title = `${$(`#view-${view}`).dataset.title}・新手家醫看診助手`;
  if (view === 'library') syncLibraryFromHash();
  if (view === 'records' && typeof loadRecordsView === 'function') loadRecordsView();
  if (view === 'education' && typeof loadEducationView === 'function') loadEducationView();
}

// 學習庫狀態寫在網址：#library?topic=… 或 #library?q=…，可用上一頁返回
function syncLibraryFromHash() {
  const params = hashParams();
  const topic = params.get('topic') || '';
  const q = params.get('q') || '';
  if (topic === libraryState.topic && q === libraryState.q && libraryState.loaded) return;
  libraryState.topic = topic;
  libraryState.q = q;
  $('#libraryQuery').value = q;
  loadLibrary();
}

function setLibraryHash({ topic = '', q = '' } = {}) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  else if (topic) params.set('topic', topic);
  const hash = `#library${params.toString() ? `?${params}` : ''}`;
  if (location.hash !== hash) location.hash = hash;
  else syncLibraryFromHash();
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

/* ---------- 學習庫：主題與列表 ---------- */
// 依主題組織：全部 = 每個主題一個書架；選定主題 = 該主題全部筆記；搜尋 = 依相關度排列

const KIND_LABEL = { figure: '圖片', note: '文字', voice: '語音', drug: '藥品卡', education: '衛教單' };
const KIND_ICON = { figure: 'image', note: 'type', voice: 'mic', drug: 'pill', education: 'file-heart' };
const SHELF_LIMIT = 4;
const libraryState = { q: '', mode: 'auto', topic: '', items: [], topics: [], searchMode: 'none' };

// 主題名稱 → 固定色相，讓同一主題在各處顏色一致
function topicHue(topic) {
  let hash = 0;
  for (const char of topic || '未分類') hash = (hash * 31 + char.codePointAt(0)) % 360;
  return (hash * 7) % 360;
}
const hueStyle = (topic) => `--hue:${topicHue(topic)}`;

function formatDate(iso) {
  const date = new Date(iso);
  const days = Math.floor((Date.now() - date) / 86400000);
  if (days < 1) return '今天';
  if (days < 2) return '昨天';
  if (days < 7) return `${days} 天前`;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

async function loadLibrary() {
  const params = new URLSearchParams();
  if (libraryState.q) { params.set('q', libraryState.q); params.set('mode', libraryState.mode); }
  try {
    const [list, topics] = await Promise.all([api(`/api/library?${params}`), api('/api/library/topics')]);
    libraryState.items = list.items;
    libraryState.searchMode = list.search_mode;
    libraryState.topics = topics.topics;
    libraryState.loaded = true;
    if (libraryState.topic && !topics.topics.some((t) => t.topic === libraryState.topic)) libraryState.topic = '';
    renderTopicIndex();
    renderLibrary();
  } catch (error) {
    showToast(error.message);
  }
}

function renderTopicIndex() {
  const total = libraryState.topics.reduce((sum, t) => sum + t.count, 0);
  $('#libraryStats').innerHTML = total
    ? `<b>${total}</b> 則筆記，整理在 <b>${libraryState.topics.length}</b> 個主題`
    : '用圖片、文字或語音收藏學到的東西，AI 會幫你歸到對的主題';
  $('#topicOptions').innerHTML = libraryState.topics
    .filter((t) => t.topic !== '未分類')
    .map((t) => `<option value="${escapeHtml(t.topic)}"></option>`).join('');
  $('#reorganizeButton').hidden = total < 2;
  const link = (topic, label, count, extra = '') => `
    <button type="button" class="topic-link ${extra} ${libraryState.topic === topic && !libraryState.q ? 'active' : ''}" data-topic="${escapeHtml(topic)}" style="${hueStyle(topic)}">
      <span class="dot" aria-hidden="true"></span><span>${escapeHtml(label)}</span><small>${count}</small>
    </button>`;
  $('#topicList').innerHTML = link('', '全部', total, 'all')
    + libraryState.topics.map((t) => link(t.topic, t.topic, t.count)).join('');
}

function cardHtml(item, index, showTopic) {
  const topic = item.topic || '未分類';
  let cover;
  if (item.image_url) {
    cover = `<img src="${escapeHtml(item.image_url)}" alt="" loading="lazy" />`;
  } else if (item.kind === 'voice') {
    // 依 id 產生固定的波形，純裝飾
    const bars = Array.from({ length: 36 }, (_, i) => 18 + Math.abs(Math.sin((item.id + 1) * (i + 3) * 0.7)) * 82);
    cover = `<div class="cover-text"><div class="wave" aria-hidden="true">${bars.map((h) => `<i style="height:${h.toFixed(0)}%"></i>`).join('')}</div></div>`;
  } else {
    const text = item.note || item.ai_summary || item.extracted_text || item.title;
    cover = `<div class="cover-text"><blockquote>${escapeHtml(text.slice(0, 160))}</blockquote></div>`;
  }
  const source = item.source_title || (item.source_url ? new URL(safeUrl(item.source_url) || 'https://x').hostname : '');
  return `
    <button type="button" class="note-card" data-id="${item.id}" style="${hueStyle(topic)};--i:${index}">
      <div class="cover">${cover}<span class="cover-kind">${icon(KIND_ICON[item.kind] || 'type')}${KIND_LABEL[item.kind] || ''}</span></div>
      <div class="card-body">
        ${showTopic ? `<span class="card-topic">${escapeHtml(topic)}</span>` : ''}
        <b>${escapeHtml(item.title)}</b>
        ${item.ai_summary ? `<p>${escapeHtml(item.ai_summary)}</p>` : ''}
        <div class="card-meta"><span>${source ? escapeHtml(source) : '&nbsp;'}</span><span>${formatDate(item.updated_at)}</span></div>
      </div>
    </button>`;
}

function emptyHtml(title, text, withButton = true) {
  return `<div class="empty-state"><div class="empty-mark">${icon('book-open')}</div><h3>${title}</h3><p>${text}</p>
    ${withButton ? `<button class="primary-button" type="button" data-action="add">${icon('plus')}新增第一則筆記</button>` : ''}</div>`;
}

function renderLibrary() {
  const main = $('#libraryMain');
  const { items, q, topic } = libraryState;

  if (q) {
    const modeText = { hybrid: '智慧搜尋（語意＋關鍵字）', keyword: '關鍵字比對' }[libraryState.searchMode] || '';
    main.innerHTML = `
      <div class="results-head"><h2>「${escapeHtml(q)}」</h2><span>${items.length} 則相關筆記・${modeText}</span>
        <button class="link-button" type="button" data-action="clear-search" style="margin-left:auto">清除搜尋</button></div>
      ${items.length ? `<div class="card-grid">${items.map((item, i) => cardHtml(item, i, true)).join('')}</div>`
        : emptyHtml('找不到相關筆記', '換個說法試試，或用英文醫學名詞搜尋。', false)}`;
    return;
  }

  if (!items.length) {
    main.innerHTML = emptyHtml('學習庫還是空的', '上傳一張圖表截圖、寫下一段重點，或錄一段語音，AI 會幫你整理並歸到主題。');
    return;
  }

  if (topic) {
    const group = items.filter((item) => (item.topic || '未分類') === topic);
    const info = libraryState.topics.find((t) => t.topic === topic);
    main.innerHTML = `
      <header class="topic-hero" style="${hueStyle(topic)}">
        <h2 class="topic-title">${escapeHtml(topic)}</h2>
        <form class="topic-rename" hidden>
          <label class="sr-only" for="topicRenameInput">新的主題名稱</label>
          <input id="topicRenameInput" value="${escapeHtml(topic)}" maxlength="40" list="topicOptions" autocomplete="off" />
          <button class="primary-button" type="submit">儲存</button>
          <button class="secondary-button" type="button" data-action="cancel-rename">取消</button>
          <p>輸入既有主題的名稱，就會把兩個主題合併。</p>
        </form>
        <div class="topic-hero-meta"><span>${group.length} 則筆記</span><span>最後更新 ${info ? formatDate(info.updated_at) : ''}</span>
          ${topic !== '未分類' ? `<button class="link-button" type="button" data-action="rename-topic">${icon('pencil')}重新命名</button>` : ''}</div>
      </header>
      <div class="card-grid">${group.map((item, i) => cardHtml(item, i, false)).join('')}</div>`;
    return;
  }

  // 全部：最近新增 + 主題卡（每個主題像一本相簿）
  const recent = [...items].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, SHELF_LIMIT);
  main.innerHTML = `
    <section class="shelf">
      <div class="shelf-head plain"><h2>最近新增</h2></div>
      <div class="card-grid row-4">${recent.map((item, i) => cardHtml(item, i, true)).join('')}</div>
    </section>
    <section class="shelf" style="animation-delay:80ms">
      <div class="shelf-head plain"><h2>所有主題</h2><span class="shelf-count">${libraryState.topics.length} 個</span></div>
      <div class="topic-grid">${libraryState.topics.map((t, i) => topicTileHtml(t, items, i)).join('')}</div>
    </section>`;
}

function topicTileHtml(info, items, index) {
  const group = items.filter((item) => (item.topic || '未分類') === info.topic);
  const images = group.filter((item) => item.image_url).slice(0, 3);
  const glyph = [...info.topic][0];
  const kinds = Object.entries(info.kinds).map(([kind, n]) => `<span title="${KIND_LABEL[kind] || ''}">${icon(KIND_ICON[kind] || 'type')}${n}</span>`).join('');
  return `
    <button type="button" class="topic-tile" data-topic-open="${escapeHtml(info.topic)}" style="${hueStyle(info.topic)};--i:${index}">
      <div class="tile-cover ${images.length ? `stack-${images.length}` : 'empty'}">
        ${images.length
          ? images.map((item) => `<img src="${escapeHtml(item.image_url)}" alt="" loading="lazy" />`).join('')
          : `<span class="tile-glyph" aria-hidden="true">${escapeHtml(glyph)}</span>`}
      </div>
      <div class="tile-body">
        <b>${escapeHtml(info.topic)}</b>
        <ul>${group.slice(0, 3).map((item) => `<li>${escapeHtml(item.title)}</li>`).join('')}</ul>
        <div class="tile-meta"><span class="tile-kinds">${kinds}</span><span>${info.count} 則・${formatDate(info.updated_at)}</span></div>
      </div>
    </button>`;
}

function selectTopic(topic) {
  setLibraryHash({ topic });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('#topicList').addEventListener('click', (event) => {
  const link = event.target.closest('[data-topic]');
  if (link) selectTopic(link.dataset.topic);
});

$('#libraryMain').addEventListener('click', async (event) => {
  const card = event.target.closest('.note-card');
  if (card) {
    const item = libraryState.items.find((i) => i.id === Number(card.dataset.id));
    if (item) openViewer(item);
    return;
  }
  const open = event.target.closest('[data-topic-open]');
  if (open) return selectTopic(open.dataset.topicOpen);
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'add') openLibraryForm();
  if (action === 'clear-search') setLibraryHash({ topic: libraryState.topic });
  if (action === 'rename-topic' || action === 'cancel-rename') toggleRename(action === 'rename-topic');
});

// 主題頁就地改名（取代瀏覽器原生 prompt）
function toggleRename(open) {
  const hero = $('.topic-hero');
  if (!hero) return;
  hero.querySelector('.topic-title').hidden = open;
  hero.querySelector('.topic-hero-meta').hidden = open;
  hero.querySelector('.topic-rename').hidden = !open;
  if (open) hero.querySelector('input').select();
}

$('#libraryMain').addEventListener('submit', async (event) => {
  if (!event.target.matches('.topic-rename')) return;
  event.preventDefault();
  const name = event.target.querySelector('input').value.trim();
  if (!name || name === libraryState.topic) return toggleRename(false);
  try {
    await api('/api/library/topics', jsonBody({ old: libraryState.topic, new: name }, 'PUT'));
    showToast(libraryState.topics.some((t) => t.topic === name) ? `已合併到「${name}」` : '主題已更新');
    libraryState.loaded = false;
    setLibraryHash({ topic: name });
  } catch (error) {
    showToast(error.message);
  }
});

$('#librarySearchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  setLibraryHash({ q: $('#libraryQuery').value.trim(), topic: libraryState.topic });
});

$('#libraryQuery').addEventListener('search', () => {
  if (!$('#libraryQuery').value) setLibraryHash({ topic: libraryState.topic });
});

/* ---------- 學習庫：AI 整理主題 ---------- */

const reorganizeDialog = $('#reorganizeDialog');
let proposal = [];

$('#reorganizeButton').addEventListener('click', async () => {
  const body = $('#reorganizeBody');
  $('#applyTopicsButton').disabled = true;
  body.innerHTML = '<div class="reorganize-loading"><div class="spinner"></div>AI 正在閱讀你的筆記並歸類…</div>';
  reorganizeDialog.showModal();
  try {
    const result = await api('/api/library/topics/reorganize', { method: 'POST' });
    proposal = result.assignments;
    renderProposal();
  } catch (error) {
    body.innerHTML = `<p class="ai-result warn">${escapeHtml(error.message)}</p>`;
  }
});

function renderProposal() {
  const groups = [...new Set(proposal.map((a) => a.topic))];
  $('#reorganizeBody').innerHTML = `
    <div class="reorganize-groups">${groups.map((g) => `<span style="${hueStyle(g)}">${escapeHtml(g)}・${proposal.filter((a) => a.topic === g).length}</span>`).join('')}</div>
    <table class="reorganize-table">
      <thead><tr><th>筆記</th><th>原主題</th><th>新主題</th></tr></thead>
      <tbody>${proposal.map((a, i) => `
        <tr><td>${escapeHtml(a.title)}</td><td class="old">${escapeHtml(a.old || '—')}</td>
        <td><input data-index="${i}" value="${escapeHtml(a.topic)}" list="topicOptions" aria-label="${escapeHtml(a.title)} 的新主題" /></td></tr>`).join('')}
      </tbody>
    </table>`;
  $('#applyTopicsButton').disabled = !proposal.length;
}

$('#reorganizeBody').addEventListener('change', (event) => {
  const input = event.target.closest('input[data-index]');
  if (!input) return;
  proposal[Number(input.dataset.index)].topic = input.value.trim() || proposal[Number(input.dataset.index)].topic;
  renderProposal();
});

$('#applyTopicsButton').addEventListener('click', async () => {
  try {
    await api('/api/library/topics/apply', jsonBody({ assignments: proposal.map(({ id, topic }) => ({ id, topic })) }));
    reorganizeDialog.close();
    showToast('主題已重新整理');
    libraryState.loaded = false;
    setLibraryHash();
  } catch (error) {
    showToast(error.message);
  }
});

reorganizeDialog.addEventListener('click', (event) => {
  if (event.target === reorganizeDialog || event.target.closest('[data-close]')) reorganizeDialog.close();
});

/* ---------- 學習庫：檢視 ---------- */

const viewer = $('#libraryViewer');

function openViewer(item) {
  const url = safeUrl(item.source_url);
  const meta = item.ai_meta || {};
  const topic = item.topic || '未分類';
  $('#viewerBody').innerHTML = `
    <div class="dialog-head">
      <div><h2>${escapeHtml(item.title)}</h2>
        <p class="dialog-meta"><span class="topic-dot" style="${hueStyle(topic)}">${escapeHtml(topic)}</span><span>${icon(KIND_ICON[item.kind] || 'type')}${KIND_LABEL[item.kind] || ''}</span></p></div>
      <button class="close-button" type="button" data-close aria-label="關閉">${icon('x')}</button>
    </div>
    ${item.image_url ? `<a class="viewer-image" href="${escapeHtml(item.image_url)}" target="_blank" rel="noopener"><img src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.title)}" /></a>` : ''}
    ${item.audio_url ? `<audio class="viewer-audio" controls src="${escapeHtml(item.audio_url)}"></audio>` : ''}
    ${item.source_title || url ? `<div class="viewer-source">
      <b>來源</b>
      <span>${escapeHtml(item.source_title || '—')}${item.source_year ? `（${escapeHtml(item.source_year)}）` : ''}</span>
      ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">開啟原始來源${icon('external-link')}</a>` : ''}
    </div>` : ''}
    ${item.ai_summary ? `<div class="viewer-block"><b>摘要 ${meta.mode === 'azure' ? '<span class="ai-label">AI 產生，待醫師確認</span>' : ''}</b><p>${escapeHtml(item.ai_summary)}</p></div>` : ''}
    ${item.kind === 'note' && item.note ? `<div class="viewer-block"><b>筆記內容</b><p>${escapeHtml(item.note)}</p></div>` : ''}
    ${item.kind === 'voice' && item.extracted_text ? `<details class="viewer-block" open><summary><b>逐字稿</b></summary><p>${escapeHtml(item.extracted_text)}</p></details>` : ''}
    ${item.kind === 'figure' && item.extracted_text ? `<details class="viewer-block"><summary><b>圖中文字</b></summary><p>${escapeHtml(item.extracted_text)}</p></details>` : ''}
    ${item.kind !== 'note' && item.note ? `<div class="viewer-block"><b>我的註記</b><p>${escapeHtml(item.note)}</p></div>` : ''}
    ${item.tags.length ? `<div class="card-tags">${item.tags.map((t) => `<span>#${escapeHtml(t)}</span>`).join('')}</div>` : ''}
    <div class="dialog-actions">
      <button class="danger-button" type="button" data-delete="${item.id}">${icon('trash-2')}刪除</button>
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
  // 兩段式刪除：第一次按下要求確認，3 秒內再按一次才刪除（取代瀏覽器原生 confirm）
  const del = event.target.closest('[data-delete]');
  if (del && !del.classList.contains('confirming')) {
    del.classList.add('confirming');
    del.innerHTML = `${icon('trash-2')}再按一次確定刪除`;
    clearTimeout(del._reset);
    del._reset = setTimeout(() => { del.classList.remove('confirming'); del.innerHTML = `${icon('trash-2')}刪除`; }, 3000);
  } else if (del) {
    clearTimeout(del._reset);
    del.disabled = true;
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
  renderRelatedTopics(data.related_topics || []);
  updateTopicBadge();
  $('#contentLabel').textContent = CONTENT_LABEL[kind] || '內容';
  $('#noteField').hidden = kind === 'note';
  form.content.rows = kind === 'figure' ? 4 : 7;

  const preview = $('#reviewPreview');
  if (uploaded.image_url) {
    preview.innerHTML = `<a href="${escapeHtml(uploaded.image_url)}" target="_blank" rel="noopener"><img src="${escapeHtml(uploaded.image_url)}" alt="上傳的圖片" /></a>`;
  } else if (uploaded.audio_url) {
    preview.innerHTML = `<div class="audio-preview">${icon('audio-lines')}<b>錄音</b><audio controls src="${escapeHtml(uploaded.audio_url)}"></audio></div>`;
  } else {
    preview.innerHTML = '';
  }
  preview.hidden = !preview.innerHTML;
  $('#reviewGrid').classList.toggle('single', preview.hidden);
  libraryDialog.dataset.kind = kind;
}

const existingTopics = () => libraryState.topics.map((t) => t.topic).filter((t) => t !== '未分類');

// 主題欄位旁的標示：沿用現有主題或建立新主題
function updateTopicBadge() {
  const value = form.topic.value.trim();
  const badge = $('#topicBadge');
  badge.hidden = !value;
  const exists = existingTopics().includes(value);
  badge.className = `topic-badge ${exists ? 'existing' : 'new'}`;
  badge.textContent = exists ? '沿用現有主題' : '新主題';
}

function renderRelatedTopics(related) {
  const box = $('#relatedTopics');
  const current = form.topic.value.trim();
  const options = related.filter((t) => t.topic !== current);
  box.hidden = !options.length;
  box.innerHTML = options.length
    ? `<span>相關的現有主題：</span>${options.map((t) => `<button type="button" data-topic-pick="${escapeHtml(t.topic)}" style="${hueStyle(t.topic)}">${escapeHtml(t.topic)}</button>`).join('')}`
    : '';
}

form.topic.addEventListener('input', updateTopicBadge);
$('#relatedTopics').addEventListener('click', (event) => {
  const pick = event.target.closest('[data-topic-pick]');
  if (!pick) return;
  const previous = form.topic.value.trim();
  form.topic.value = pick.dataset.topicPick;
  pick.remove();
  if (previous && !existingTopics().includes(previous)) {
    // 把被取代的新主題保留成可切回的選項
    const back = document.createElement('button');
    back.type = 'button';
    back.dataset.topicPick = previous;
    back.style.cssText = hueStyle(previous);
    back.textContent = `${previous}（AI 建議的新主題）`;
    $('#relatedTopics').append(back);
  }
  updateTopicBadge();
});

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
      related_topics: result.related_topics,
      content: payload.mode === 'text' ? payload.text : payload.mode === 'voice' ? result.transcript : s.extracted_text,
    });
    const ai = $('#aiResult');
    ai.hidden = false;
    ai.classList.toggle('warn', Boolean(result.message));
    ai.innerHTML = result.message ? escapeHtml(result.message) : icon('sparkles') + escapeHtml([
      `AI 已整理完成（${aiMeta.model}）`,
      s.topic ? (result.topic_exists ? `歸入現有主題「${s.topic}」` : `建立新主題「${s.topic}」`) : '',
      s.source_title ? '並帶入辨識到的來源' : '',
    ].filter(Boolean).join('，') + '。請確認內容後儲存。');
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
  loadLibrary();
}

/* ---------- 啟動 ---------- */

window.addEventListener('hashchange', showView);
showView();
loadHealth();
