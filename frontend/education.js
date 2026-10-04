/* ==========================================================
   衛教單（F-08／F-09）
   流程：從病歷或主題產生 AI 草稿 → 醫師直接點文字修改 → 產生一張衛教插圖
        → 勾選「醫師已確認」後才能下載圖片或存到學習庫
   依賴 app.js 的 $、$$、api、jsonBody、escapeHtml、showToast、hueStyle、icon
   ========================================================== */

const edu = {
  sheets: [],
  sheet: null,
  loaded: false,
};
let eduSaveTimer;

// 外觀圖一律經後端轉傳：畫面顯示與下載圖片用同一個來源，下載時才不會缺圖
const proxied = (url) => (url ? `/api/image-proxy?url=${encodeURIComponent(url)}` : '');
// 衛教單內的圖示直接內嵌 SVG（引用 sprite 的 <use> 在轉成圖片時會變空白）
function inlineIcon(name) {
  const symbol = document.getElementById(`i-${name}`);
  return symbol ? `<svg class="icon" viewBox="${symbol.getAttribute('viewBox')}" aria-hidden="true">${symbol.innerHTML}</svg>` : '';
}
const sheetDate = (iso) => (iso ? iso.slice(0, 10).replaceAll('-', '/') : '');

/* ---------- 載入 ---------- */

async function loadEducationView() {
  if (!edu.loaded) {
    edu.loaded = true;
    try {
      const catalog = await api('/api/catalog');
      $('#eduTopic').innerHTML = '<option value="">選擇主題…</option>'
        + catalog.conditions.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
    } catch (error) {
      edu.loaded = false;
      showToast(error.message);
    }
  }
  await refreshSheetList();
  const id = Number(hashParams().get('id'));
  if (id) openSheet(id);
  else if (!edu.sheet) renderEmpty();
}

async function refreshSheetList() {
  const { sheets } = await api('/api/education');
  edu.sheets = sheets;
  renderSheetList();
}

function renderSheetList() {
  $('#eduList').innerHTML = edu.sheets.length
    ? edu.sheets.map((s) => `
      <a class="edu-list-item ${edu.sheet?.id === s.id ? 'active' : ''}" href="#education?id=${s.id}" style="${hueStyle(s.topic.split('、')[0])}">
        <b>${escapeHtml(s.title || '未命名衛教單')}</b>
        <span>${escapeHtml(s.topic)}</span>
        <small>${s.confirmed ? `${icon('check')}已確認` : '草稿'}・${sheetDate(s.updated_at)}</small>
      </a>`).join('')
    : '<p class="muted-text edu-list-empty">還沒有衛教單。從「病歷與開藥」按「產生衛教單」，或在上方選主題。</p>';
}

function renderEmpty() {
  edu.sheet = null;
  $('#eduMain').innerHTML = `
    <div class="edu-empty">
      <div class="empty-mark">${icon('file-heart')}</div>
      <h2>給長輩看的衛教單</h2>
      <p>在「病歷與開藥」寫好病灶、採用藥品後按「產生衛教單」，會帶入病灶與本次處方；也可以在上方直接選主題，做不含用藥的一般衛教。</p>
    </div>`;
}

async function openSheet(id) {
  try {
    edu.sheet = await api(`/api/education/${id}`);
    renderSheet();
    renderSheetList();
  } catch (error) {
    showToast(error.message);
    renderEmpty();
  }
}

/* ---------- 產生 ---------- */

function renderGenerating(label) {
  $('#eduMain').innerHTML = `
    <div class="edu-generating" role="status">
      <div class="spinner"></div>
      <b>${escapeHtml(label)}</b>
      <span>AI 正在用白話寫說明、用藥提醒與回診時機，約需 5–15 秒</span>
    </div>`;
}

// 由病歷頁呼叫：先存好病歷，再以病灶與本次處方產生
async function createSheetFromRecord(recordId) {
  location.hash = '#education';
  renderGenerating('正在依病歷產生衛教單…');
  try {
    const sheet = await api('/api/education', jsonBody({ record_id: recordId }));
    location.hash = `#education?id=${sheet.id}`;
  } catch (error) {
    showToast(error.message);
    renderEmpty();
  }
}

$('#eduNewForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const topic = $('#eduTopic').value;
  if (!topic) return showToast('請先選擇衛教主題');
  renderGenerating(`正在產生「${topic}」的衛教單…`);
  try {
    const sheet = await api('/api/education', jsonBody({ topics: [topic] }));
    $('#eduTopic').value = '';
    location.hash = `#education?id=${sheet.id}`;
  } catch (error) {
    showToast(error.message);
    if (edu.sheet) renderSheet(); else renderEmpty();
  }
});

/* ---------- 衛教單內容 ---------- */

// 可直接點選修改的文字；data-path 對應 content 內的欄位（例：care.0、medicines.1.tip）
const editable = (path, text, tag = 'span', placeholder = '點這裡輸入') =>
  `<${tag} class="edu-edit" contenteditable="plaintext-only" spellcheck="false" data-path="${path}" data-placeholder="${placeholder}">${escapeHtml(text || '')}</${tag}>`;

function listHtml(key, items, placeholder) {
  return `
    <ul class="edu-points">
      ${items.map((text, i) => `<li>${editable(`${key}.${i}`, text, 'span', placeholder)}<button type="button" class="edu-ui edu-remove" data-remove="${key}.${i}" aria-label="刪除這一點">${icon('x')}</button></li>`).join('')}
    </ul>
    <button type="button" class="edu-ui link-button edu-add" data-add="${key}">${icon('plus')}新增一點</button>`;
}

function medicineHtml(m, i) {
  return `
    <li class="edu-med ${m.image_url ? '' : 'no-photo'}">
      ${m.image_url ? `<div class="edu-med-photo"><img src="${proxied(m.image_url)}" alt="${escapeHtml(m.product_name || m.name_zh || m.name)}" /></div>` : ''}
      <div class="edu-med-body">
        <p class="edu-med-name">${editable(`medicines.${i}.name_zh`, m.name_zh, 'b', '中文藥名')}<small>${escapeHtml(m.name)}</small></p>
        <p class="edu-med-purpose">${editable(`medicines.${i}.purpose`, m.purpose, 'span', '這個藥是做什麼的')}</p>
        <p class="edu-med-schedule">${inlineIcon('check')}${editable(`medicines.${i}.schedule`, m.schedule, 'span', '一天幾次、吃幾天')}</p>
        <p class="edu-med-tip">${editable(`medicines.${i}.tip`, m.tip, 'span', '服用提醒（飯前或飯後、注意事項）')}</p>
      </div>
    </li>`;
}

const footStatus = () => (edu.sheet.confirmed ? `AI 產生，經醫師確認・${sheetDate(edu.sheet.confirmed_at)}` : '草稿・尚未經醫師確認');

function toolbarHtml() {
  const s = edu.sheet;
  const meta = s.ai_meta?.mode === 'azure' ? `草稿由 ${escapeHtml(s.ai_meta.model)} 產生` : '空白範本（AI 未設定）';
  return `
    <div class="edu-status ${s.confirmed ? 'ok' : ''}">
      ${s.confirmed ? `${icon('check')}醫師已確認・${sheetDate(s.confirmed_at)}` : `${icon('pencil')}草稿：點文字即可修改`}
      <span>${meta}</span>
    </div>
    <div class="edu-actions">
      <button type="button" class="secondary-button" id="eduImageButton">${icon('sparkles')}${s.image_path ? '重新產生衛教圖' : '產生衛教圖'}</button>
      <label class="edu-confirm"><input type="checkbox" id="eduConfirm" ${s.confirmed ? 'checked' : ''} />醫師已確認內容</label>
      <button type="button" class="primary-button" id="eduDownload" ${s.confirmed ? '' : 'disabled'}>${icon('upload')}下載圖片</button>
      <button type="button" class="secondary-button" id="eduSaveLibrary" ${s.confirmed ? '' : 'disabled'}>${icon('book-open')}存到學習庫</button>
      <button type="button" class="edu-delete" id="eduDelete" aria-label="刪除這份衛教單">${icon('trash-2')}</button>
    </div>
    ${s.confirmed ? '' : '<p class="edu-hint">勾選「醫師已確認內容」之後才能下載或存到學習庫；修改內容會取消確認。</p>'}`;
}

function renderSheet() {
  const s = edu.sheet;
  const c = s.content;
  const topics = s.topic.split('、').filter(Boolean);
  $('#eduMain').innerHTML = `
    <div class="edu-toolbar" id="eduToolbar">${toolbarHtml()}</div>

    <article class="edu-sheet" id="eduSheet" style="${hueStyle(topics[0] || '')}">
      <header class="edu-sheet-head">
        <p class="edu-sheet-topics">${topics.map(escapeHtml).join('・')}</p>
        ${editable('title', s.title, 'h2', '衛教單標題')}
      </header>

      <figure class="edu-figure ${s.image_path ? '' : 'empty'}" id="eduFigure">
        ${s.image_path
          ? `<img src="${s.image_url}" alt="衛教插圖：${escapeHtml(c.image_scene || '')}" />`
          : `<div class="edu-figure-empty edu-ui">${icon('image')}<span>還沒有衛教圖。按上方「產生衛教圖」，AI 會畫一張不含文字的插圖（約 10–30 秒）。</span></div>`}
      </figure>

      <section class="edu-block">
        <h3>這是什麼問題</h3>
        ${editable('about', c.about, 'p', '用 2–3 句白話說明')}
      </section>

      ${c.medicines?.length ? `
      <section class="edu-block">
        <h3>怎麼吃藥</h3>
        <ul class="edu-meds">${c.medicines.map(medicineHtml).join('')}</ul>
        <p class="edu-note">藥丸照片為 TFDA 公開的外觀圖，實際拿到的藥若不同，請詢問藥師。</p>
      </section>` : ''}

      <section class="edu-block">
        <h3>在家怎麼照顧</h3>
        ${listHtml('care', c.care || [], '一個照顧的做法')}
      </section>

      <section class="edu-block edu-warn">
        <h3>出現這些情況，請馬上回診</h3>
        ${listHtml('warnings', c.warnings || [], '需要回診的情況')}
      </section>

      <footer class="edu-sheet-foot">
        <span id="eduFootStatus">${footStatus()}</span>
        <span>新手家醫看診助手・練習資料，非臨床建議</span>
      </footer>
    </article>`;
}

/* ---------- 編輯與儲存 ---------- */

function setByPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}

function scheduleSheetSave() {
  clearTimeout(eduSaveTimer);
  eduSaveTimer = setTimeout(saveSheet, 600);
}

async function saveSheet() {
  const s = edu.sheet;
  if (!s) return;
  try {
    edu.sheet = await api(`/api/education/${s.id}`, jsonBody({ title: s.title, content: s.content, confirmed: s.confirmed }, 'PUT'));
    const listed = edu.sheets.find((x) => x.id === s.id);
    if (listed) Object.assign(listed, { title: edu.sheet.title, confirmed: edu.sheet.confirmed, updated_at: edu.sheet.updated_at });
    renderSheetList();
  } catch (error) {
    showToast(`儲存失敗，請稍後再試（${error.message}）`);
  }
}

// 修改內容就取消確認，避免交出未看過的版本
function unconfirm() {
  if (!edu.sheet.confirmed) return;
  edu.sheet.confirmed = false;
  edu.sheet.confirmed_at = '';
  updateConfirmUi();
  showToast('內容已修改，請重新確認後再交給病人');
}

// 只重繪工具列與頁尾，不動正在編輯的內容（避免游標跳掉）
function updateConfirmUi() {
  const hadFocus = document.activeElement?.id === 'eduConfirm';
  $('#eduToolbar').innerHTML = toolbarHtml();
  $('#eduFootStatus').textContent = footStatus();
  if (hadFocus) $('#eduConfirm').focus();
}

$('#eduMain').addEventListener('input', (event) => {
  const field = event.target.closest('.edu-edit');
  if (!field || !edu.sheet) return;
  const value = field.textContent.trim();
  if (field.dataset.path === 'title') edu.sheet.title = value;
  else setByPath(edu.sheet.content, field.dataset.path, value);
  unconfirm();
  scheduleSheetSave();
});

// 按 Enter 不換行（每個欄位都是一句或一點）
$('#eduMain').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.closest('.edu-edit') && event.target.tagName !== 'P') {
    event.preventDefault();
    event.target.blur();
  }
});

$('#eduMain').addEventListener('change', (event) => {
  if (event.target.id !== 'eduConfirm') return;
  edu.sheet.confirmed = event.target.checked;
  edu.sheet.confirmed_at = event.target.checked ? new Date().toISOString().slice(0, 19) : '';
  updateConfirmUi();
  clearTimeout(eduSaveTimer);
  saveSheet();
});

$('#eduMain').addEventListener('click', async (event) => {
  const s = edu.sheet;
  if (!s) return;

  const add = event.target.closest('[data-add]');
  if (add) {
    s.content[add.dataset.add] = [...(s.content[add.dataset.add] || []), ''];
    unconfirm();
    renderSheet();
    $$(`#eduSheet [data-path^="${add.dataset.add}."]`).pop()?.focus();
    return scheduleSheetSave();
  }
  const remove = event.target.closest('[data-remove]');
  if (remove) {
    const [key, index] = remove.dataset.remove.split('.');
    s.content[key].splice(Number(index), 1);
    unconfirm();
    renderSheet();
    return scheduleSheetSave();
  }

  if (event.target.closest('#eduImageButton')) return generateImage(Boolean(s.image_path));
  if (event.target.closest('#eduDownload')) return downloadSheet();
  if (event.target.closest('#eduSaveLibrary')) return saveSheetToLibrary();
  if (event.target.closest('#eduDelete')) return deleteSheet(event.target.closest('#eduDelete'));
});

/* ---------- 衛教圖 ---------- */

async function generateImage(regenerate) {
  const button = $('#eduImageButton');
  button.disabled = true;
  button.innerHTML = `${icon('sparkles')}產生中…`;
  $('#eduFigure').classList.add('loading');
  $('#eduFigure').innerHTML = '<div class="edu-figure-empty"><div class="spinner"></div><span>AI 正在畫衛教圖，約 10–30 秒</span></div>';
  try {
    edu.sheet = await api(`/api/education/${edu.sheet.id}/image${regenerate ? '?regenerate=true' : ''}`, { method: 'POST' });
    renderSheet();
    renderSheetList();
    showToast('衛教圖已產生，請確認內容後勾選「醫師已確認」');
  } catch (error) {
    showToast(error.message);
    renderSheet();
  }
}

/* ---------- 交付：下載圖片、存到學習庫 ---------- */

let htmlToImageReady;
function loadHtmlToImage() {
  htmlToImageReady ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js';
    script.onload = () => resolve(window.htmlToImage);
    script.onerror = () => { htmlToImageReady = null; reject(new Error('無法載入圖片轉換工具，請檢查網路')); };
    document.head.appendChild(script);
  });
  return htmlToImageReady;
}

async function downloadSheet() {
  if (!edu.sheet.confirmed) return showToast('請先勾選「醫師已確認內容」');
  const button = $('#eduDownload');
  button.disabled = true;
  button.innerHTML = `${icon('upload')}轉換中…`;
  try {
    const lib = await loadHtmlToImage();
    const node = $('#eduSheet');
    node.classList.add('exporting');
    const options = { pixelRatio: 2, backgroundColor: '#ffffff', filter: (n) => !n.classList?.contains('edu-ui') };
    let dataUrl;
    try {
      dataUrl = await lib.toPng(node, options);
    } catch {
      // 網路字型無法嵌入時，改用系統字型輸出
      dataUrl = await lib.toPng(node, { ...options, skipFonts: true });
    }
    node.classList.remove('exporting');
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `衛教單-${edu.sheet.title || edu.sheet.topic}.png`;
    link.click();
    showToast('已下載衛教單圖片，可用 LINE 傳給病人或家屬');
  } catch (error) {
    $('#eduSheet')?.classList.remove('exporting');
    showToast(error.message || '下載失敗，請稍後再試');
  } finally {
    button.disabled = !edu.sheet.confirmed;
    button.innerHTML = `${icon('upload')}下載圖片`;
  }
}

async function saveSheetToLibrary() {
  const s = edu.sheet;
  if (!s.confirmed) return showToast('請先勾選「醫師已確認內容」');
  const c = s.content;
  const topic = `${s.topic.split('、')[0]}的衛教`;
  const note = [
    c.about,
    c.medicines?.length ? `用藥：${c.medicines.map((m) => `${m.name_zh || m.name}（${m.schedule}）${m.purpose ? `—${m.purpose}` : ''}`).join('；')}` : '',
    c.care?.length ? `在家照顧：${c.care.filter(Boolean).join('；')}` : '',
    c.warnings?.length ? `回診時機：${c.warnings.filter(Boolean).join('；')}` : '',
  ].filter(Boolean).join('\n');
  try {
    await api('/api/library', jsonBody({
      kind: 'education',
      title: s.title,
      topic,
      tags: [...s.topic.split('、'), '衛教'],
      note,
      ai_summary: c.about,
      source_title: '衛教單（醫師確認）',
      image_path: s.image_path,
      ai_meta: s.ai_meta || {},
      ref_type: 'education',
      ref_id: String(s.id),
    }));
    if (typeof libraryState !== 'undefined') libraryState.loaded = false;
    showToast(`已存到學習庫「${topic}」`);
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteSheet(button) {
  // 兩段式刪除：第一次按變成確認狀態
  if (!button.classList.contains('confirming')) {
    button.classList.add('confirming');
    button.setAttribute('aria-label', '再按一次刪除這份衛教單');
    showToast('再按一次刪除這份衛教單');
    setTimeout(() => { button.classList.remove('confirming'); button.setAttribute('aria-label', '刪除這份衛教單'); }, 3000);
    return;
  }
  try {
    await api(`/api/education/${edu.sheet.id}`, { method: 'DELETE' });
    edu.sheets = edu.sheets.filter((x) => x.id !== edu.sheet.id);
    edu.sheet = null;
    location.hash = '#education';
    renderSheetList();
    renderEmpty();
    showToast('已刪除衛教單');
  } catch (error) {
    showToast(error.message);
  }
}

if (location.hash.startsWith('#education')) loadEducationView();
