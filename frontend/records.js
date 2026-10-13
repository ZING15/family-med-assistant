/* ==========================================================
   病歷與開藥（F-03～F-07）
   病歷採 SOAP：S 主訴與現病史、O 身體檢查與檢驗、A 問題清單＋統整評估、P 統整治療計畫
  （依教材，問題多時逐題寫 SOAP 太繁瑣，改為列出問題後統整一份計畫）。
   流程：寫病歷或語音看診 → 自動偵測問題 → 依問題列出推薦（每個問題一排）
        → 醫師採用（寫入開藥區）／這次不用／此病灶不再推薦 → 完成病歷（同時產生英文版）
   依賴 app.js 的 $、$$、api、jsonBody、escapeHtml、showToast、hueStyle、icon
   ========================================================== */

const FREQUENCY_GROUPS = [
  ['常用', [['QD', '每日一次'], ['BID', '每日兩次'], ['TID', '每日三次'], ['QID', '每日四次'], ['HS', '睡前'], ['PRN', '需要時']]],
  ['飯前／飯後', [['QDAC', '每日一次飯前'], ['BIDAC', '每日兩次飯前'], ['TIDAC', '三餐飯前'], ['QDPC', '每日一次飯後'],
    ['BIDPC', '每日兩次飯後'], ['TIDPC', '三餐飯後'], ['TID+HS', '三餐飯後＋睡前']]],
  ['固定間隔', [['Q4H', '每 4 小時'], ['Q6H', '每 6 小時'], ['Q8H', '每 8 小時'], ['Q12H', '每 12 小時'],
    ['Q6H PRN', '需要時，間隔 6 小時'], ['Q4H PRN', '需要時，間隔 4 小時']]],
  ['其他', [['QOD', '隔日一次'], ['QW', '每週一次'], ['STAT', '立即一次'], ['ASORDER', '依醫囑']]],
];
const FREQUENCY_CODES = FREQUENCY_GROUPS.flatMap(([, items]) => items.map(([code]) => code));
const DAYS = [1, 2, 3, 4, 5, 7, 10, 14, 28, 30, 60, 90];
const CUSTOM = '__custom';
document.body.insertAdjacentHTML('beforeend', `<datalist id="freqCodes">${FREQUENCY_GROUPS.flatMap(([, items]) =>
  items.map(([code, label]) => `<option value="${code}">${label}</option>`)).join('')}</datalist>`);
const SOURCE_LABEL = { keyword: '關鍵字', semantic: '語意', ai: 'AI', manual: '手動', voice: '語音' };

// TFDA 許可證「藥品類別」：處方藥、指示藥、成藥（甲乙類成藥可自行購買）
const CATEGORY_LABEL = { rx: '處方', otc: '指示藥', general: '成藥' };

// ATC 有些名稱是全大寫（例：OTHER COLD PREPARATIONS），轉成一般大小寫
const drugLabel = (name) => (name && name === name.toUpperCase() ? name.charAt(0) + name.slice(1).toLowerCase() : name);
// 後端會把「combinations」這類名稱改成「鎮咳劑複方」；舊資料沒有 display_name 時退回英文名
const rxName = (p) => p.display_name || drugLabel(p.name_en);

// 健保支付價：顯示到小數點後兩位，去掉多餘的 0
const money = (n) => `${Number(n).toFixed(2).replace(/\.?0+$/, '')} 元`;

// 推薦卡：只標示有沒有健保給付品項，品項數與支付價在藥品卡、開藥區才顯示
function nhiTagHtml(nhi) {
  if (!nhi) return '';
  return nhi.covered_products ? '<b class="nhi-tag">健保</b>' : '<b class="nhi-tag self-pay">無健保品項</b>';
}

// 推薦卡劑型：取市售品項最多的兩種（例：錠劑／膠囊・外用），也能區分同成分的不同途徑
const formsText = (forms) => (forms || []).slice(0, 2).map((f) => f.label).join('・');

// 慢性病且病歷寫「控制中、穩定、規則服藥」時，預設收起那一排
const CONTROLLED = /控制(中|良好|穩定)|穩定|規則服藥|持續服藥/;

// 開藥區：這個品項的健保代碼與支付價
function rxNhiHtml(p) {
  if (p.nhi_code) return `<span class="rx-nhi"><b class="nhi-tag">健保</b>${escapeHtml(p.nhi_code)}・每${escapeHtml(p.nhi_unit || '單位')} ${money(p.nhi_price)}</span>`;
  if (p.nhi_code === '') return '<span class="rx-nhi self-pay">非健保給付（自費）</span>';
  return '';
}

function nhiFields(product) {
  const first = product?.nhi?.[0];
  return first ? { nhi_code: first.code, nhi_price: first.price, nhi_unit: first.unit } : { nhi_code: '', nhi_price: null, nhi_unit: '' };
}

const rx = {
  catalog: { conditions: [], allergens: [] },
  records: [],
  record: null,
  recs: { rows: [], excluded: [] },
  railActive: {},      // 每排目前可用 Tab 進入的卡片（roving tabindex）
  dialogCondition: '', // 「看全部」彈窗目前顯示的病灶
  collapsed: {},       // 每排是否收起
  riskSig: '',         // 目前病史風險（變動時才重新取推薦）
  removedCache: {},    // 本次移除的病灶，供「復原」還原原本的來源
  peek: false,         // AI 參考計畫是否已打開
  semantic: [],        // 語意相近、尚未加入的「可能問題」
  loaded: false,
};
let saveTimer;
let detectTimer;

/* ---------- 載入 ---------- */

async function loadRecordsView() {
  if (rx.loaded) return;
  rx.loaded = true;
  try {
    const [catalog, list] = await Promise.all([api('/api/catalog'), api('/api/records')]);
    rx.catalog = catalog;
    rx.records = list.records;
    $('#conditionAdd').innerHTML = '<option value="">從清單新增問題…</option>'
      + catalog.conditions.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}（${c.icd10}）</option>`).join('');
    $('#allergenOptions').innerHTML = catalog.allergens
      .map((a) => `<button type="button" class="chip-button" data-allergen="${a.id}">${escapeHtml(a.name)}</button>`).join('');
    renderRecordSelect();
    if (rx.records.length) openRecord(rx.records[0].id);
    else newRecord();
  } catch (error) {
    rx.loaded = false;
    showToast(error.message);
  }
}

function renderRecordSelect() {
  $('#recordSelect').innerHTML = rx.records.map((r) => {
    const label = [r.patient_code || '未命名', r.age && `${r.age} 歲`, r.sex, r.chief_complaint && `・${r.chief_complaint.slice(0, 24)}`].filter(Boolean).join(' ');
    return `<option value="${r.id}" ${rx.record?.id === r.id ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
}

async function openRecord(id) {
  rx.record = await api(`/api/records/${id}`);
  rx.railActive = {};
  rx.removedCache = {};
  rx.collapsed = {};
  $('#pCode').value = rx.record.patient_code;
  $('#pAge').value = rx.record.age;
  $('#pSex').value = rx.record.sex;
  rx.peek = false;
  rx.semantic = [];
  $('#pDate').value = rx.record.visit_date || '';
  $('#rChief').value = rx.record.chief_complaint;
  $('#rHistory').value = rx.record.history;
  $('#rExam').value = rx.record.exam;
  $('#rAssessment').value = rx.record.assessment;
  $('#rPlan').value = rx.record.plan;
  $('#aiOther').hidden = true;
  renderSemantic();
  updateRecordStatus();
  $('#saveState').textContent = '';
  renderRecordSelect();
  renderAllergies();
  resolveAllergyNames();
  rx.record.symptoms ||= [];
  rx.record.removed_symptoms ||= [];
  renderConditions();
  renderSymptoms();
  renderPrescriptions();
  refreshRecommendations();
  // 舊病歷還沒有症狀紀錄：開啟時補抓一次（只更新症狀，問題清單維持醫師存的樣子）
  if (!rx.record.symptoms.length && !rx.record.removed_symptoms.length && subjectiveText().trim()) {
    const opened = rx.record;
    api('/api/detect', jsonBody({ text: '', s_text: subjectiveText() }))
      .then(({ symptoms }) => { if (rx.record === opened && symptoms.length) mergeSymptoms(symptoms, 'keyword', { save: false }); })
      .catch(() => {});
  }
}

async function newRecord() {
  const record = await api('/api/records', { method: 'POST' });
  rx.records.unshift(record);
  await openRecord(record.id);
  $('#rChief').focus();
}

$('#recordSelect').addEventListener('change', (event) => openRecord(Number(event.target.value)));
// 新病歷：先選「手動輸入」或「語音看診」
const newRecordDialog = $('#newRecordDialog');
$('#newRecordButton').addEventListener('click', () => newRecordDialog.showModal());
newRecordDialog.addEventListener('click', async (event) => {
  if (event.target === newRecordDialog || event.target.closest('[data-close]')) return newRecordDialog.close();
  const mode = event.target.closest('[data-new-mode]')?.dataset.newMode;
  if (!mode) return;
  newRecordDialog.close();
  await newRecord();
  if (mode === 'voice') {
    rx.voiceDraft = rx.record.id;
    openVoiceDialog();
  }
});

/* ---------- 儲存（自動） ---------- */

function scheduleSave() {
  $('#saveState').textContent = '編輯中…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveRecord, 700);
}

async function saveRecord() {
  if (!rx.record) return;
  const r = rx.record;
  Object.assign(r, {
    patient_code: $('#pCode').value.trim(), age: $('#pAge').value.trim(), sex: $('#pSex').value,
    visit_date: $('#pDate').value, chief_complaint: $('#rChief').value, history: $('#rHistory').value,
    exam: $('#rExam').value, assessment: $('#rAssessment').value, plan: $('#rPlan').value,
  });
  try {
    const saved = await api(`/api/records/${r.id}`, jsonBody(r, 'PUT'));
    const index = rx.records.findIndex((x) => x.id === r.id);
    if (index >= 0) rx.records[index] = saved;
    r.updated_at = saved.updated_at;
    renderRecordSelect();
    updateRecordStatus();
    $('#saveState').innerHTML = `${icon('check')}已自動儲存`;
  } catch (error) {
    $('#saveState').textContent = `儲存失敗，請稍後再試（${error.message}）`;
  }
}

['#pCode', '#pAge', '#pSex', '#pDate'].forEach((sel) => $(sel).addEventListener('input', scheduleSave));
$('#rPlan').addEventListener('input', scheduleSave);
// 年齡影響「65 歲以上」的提醒
let ageTimer;
$('#pAge').addEventListener('input', () => {
  clearTimeout(ageTimer);
  ageTimer = setTimeout(refreshRecommendations, 600);
});
// S、O、A：偵測問題與病史風險都以這段文字為準
const recordText = () => [$('#rChief').value, $('#rHistory').value, $('#rExam').value, $('#rAssessment').value].join('\n');
// 症狀只從 S（主訴＋現病史）找，用來補對症用藥
const subjectiveText = () => [$('#rChief').value, $('#rHistory').value].join('\n');

function scheduleDetect() {
  clearTimeout(detectTimer);
  detectTimer = setTimeout(detectConditions, 600);
}

['#rChief', '#rHistory', '#rExam', '#rAssessment'].forEach((sel) => $(sel).addEventListener('input', () => {
  scheduleSave();
  scheduleDetect();
}));

/* ---------- 過敏 ---------- */

function allergyLabel(entry) {
  if (entry.startsWith('atc:')) return rx.allergyNames?.[entry] || entry.slice(4);
  return rx.catalog.allergens.find((a) => a.id === entry)?.name || entry;
}

// 個別藥品過敏（atc:CODE）重新開啟病歷時，補查藥名
async function resolveAllergyNames() {
  const missing = rx.record.allergies.filter((a) => a.startsWith('atc:') && !rx.allergyNames?.[a]);
  if (!missing.length) return;
  for (const entry of missing) {
    try {
      const d = await drugDetail(entry.slice(4));
      rx.allergyNames = { ...(rx.allergyNames || {}), [entry]: `${d.display_name || d.name_en}（個別藥品）` };
    } catch { /* 查不到就顯示代碼 */ }
  }
  renderAllergies();
  renderSafety();
}

function renderAllergies() {
  const list = rx.record.allergies;
  $('#allergyChips').innerHTML = list.length
    ? list.map((a) => `<span class="allergy-chip">${escapeHtml(allergyLabel(a))}<button type="button" data-remove-allergy="${escapeHtml(a)}" aria-label="移除 ${escapeHtml(allergyLabel(a))}">${icon('x')}</button></span>`).join('')
    : '<span class="muted-text">無已知過敏</span>';
  $$('#allergenOptions [data-allergen]').forEach((b) => {
    const on = list.includes(b.dataset.allergen);
    b.classList.toggle('selected', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function setAllergies(list) {
  rx.record.allergies = [...new Set(list)];
  renderAllergies();
  scheduleSave();
  refreshRecommendations();
}

$('#allergyToggle').addEventListener('click', () => {
  const pop = $('#allergyPop');
  pop.hidden = !pop.hidden;
  $('#allergyToggle').setAttribute('aria-expanded', String(!pop.hidden));
  if (!pop.hidden) $('#allergyDrugSearch').focus();
});

function closeMenus(except = null) {
  $$('.rec-menu').forEach((m) => {
    if (m === except) return;
    m.hidden = true;
    m.closest('.rec-card')?.querySelector('[data-more]')?.setAttribute('aria-expanded', 'false');
  });
}

// Esc：先關閉開著的選單並把焦點還給「⋯」，再關過敏彈出框
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const openMenu = $$('.rec-menu').find((m) => !m.hidden);
  if (openMenu) {
    closeMenus();
    openMenu.closest('.rec-card')?.querySelector('[data-more]')?.focus();
    return;
  }
  if (!$('#allergyPop').hidden) { $('#allergyPop').hidden = true; $('#allergyToggle').setAttribute('aria-expanded', 'false'); $('#allergyToggle').focus(); }
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.allergy-add')) { $('#allergyPop').hidden = true; $('#allergyToggle').setAttribute('aria-expanded', 'false'); }
  if (!event.target.closest('.rx-search')) $('#rxDrugResults').innerHTML = '';
  if (!event.target.closest('.rec-menu, .rec-more')) closeMenus();
});
$('#allergenOptions').addEventListener('click', (event) => {
  const id = event.target.closest('[data-allergen]')?.dataset.allergen;
  if (!id) return;
  const list = rx.record.allergies;
  setAllergies(list.includes(id) ? list.filter((a) => a !== id) : [...list, id]);
});
$('#allergyChips').addEventListener('click', (event) => {
  const entry = event.target.closest('[data-remove-allergy]')?.dataset.removeAllergy;
  if (entry) setAllergies(rx.record.allergies.filter((a) => a !== entry));
});

function bindDrugSearch(input, results, onPick) {
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) { results.innerHTML = ''; return; }
      const { results: items } = await api(`/api/drugs/search?q=${encodeURIComponent(q)}`);
      results.innerHTML = items.length
        ? items.map((d) => `<button type="button" data-atc="${d.atc_code}" data-name="${escapeHtml(d.name_en)}" data-display="${escapeHtml(d.display_name || '')}">
            <b>${escapeHtml(d.display_name || d.name_en)}</b><span>${escapeHtml(d.class_zh || '')}・${escapeHtml(d.sample_name || '')}${d.nhi ? `・${d.nhi.covered_products ? `健保 ${d.nhi.covered_products} 個品項` : '無健保給付'}` : ''}</span></button>`).join('')
        : '<p class="muted-text">找不到符合的藥品</p>';
    }, 250);
  });
  results.addEventListener('click', (event) => {
    const button = event.target.closest('[data-atc]');
    if (!button) return;
    onPick(button.dataset.atc, button.dataset.name, button.dataset.display);
    input.value = '';
    results.innerHTML = '';
  });
}

bindDrugSearch($('#allergyDrugSearch'), $('#allergyDrugResults'), (atc, name, display) => {
  rx.allergyNames = { ...(rx.allergyNames || {}), [`atc:${atc}`]: `${display || name}（個別藥品）` };
  setAllergies([...rx.record.allergies, `atc:${atc}`]);
});

/* ---------- 問題清單（POMR）：偵測、A／P、AI 參考計畫 ---------- */

let semanticTimer;
let semanticSeq = 0;

async function detectConditions() {
  const text = recordText();
  const { conditions, symptoms, risks } = await api('/api/detect', jsonBody({ text, s_text: subjectiveText() }));
  const changed = mergeConditions(conditions, 'keyword') | mergeSymptoms(symptoms, 'keyword');
  // 病灶沒變但病史風險變了（例如補上「曾胃出血」），也要重新標示卡片提醒
  if (!changed && (risks || []).join() !== rx.riskSig) refreshRecommendations();
  clearTimeout(semanticTimer);
  semanticTimer = setTimeout(detectSemantic, 900);
}

// 語意偵測：關鍵字沒對到、但意思相近的句子，列為「可能的問題」讓醫師決定
async function detectSemantic() {
  const r = rx.record;
  const text = recordText();
  if (!r || !text.trim()) { rx.semantic = []; return renderSemantic(); }
  const seq = ++semanticSeq;
  const skip = [...r.conditions.map((c) => c.name), ...r.removed_conditions];
  try {
    const { conditions } = await api('/api/detect/semantic', jsonBody({ text, skip }));
    if (seq !== semanticSeq || rx.record !== r) return;
    rx.semantic = conditions;
    renderSemantic();
  } catch { /* 語意偵測失敗不影響其他功能 */ }
}

function renderSemantic() {
  const box = $('#semanticSuggest');
  const list = (rx.semantic || []).filter((c) => !rx.record?.conditions.some((x) => x.name === c.name));
  box.hidden = !list.length;
  box.innerHTML = list.length ? `<span>${icon('sparkles')}可能的問題</span>${list.map((c) => `
    <button type="button" class="suggest-chip" data-add-semantic="${escapeHtml(c.name)}" title="語意相近：「${escapeHtml(c.matched)}」">
      ${escapeHtml(c.name)}<small>「${escapeHtml(c.matched.slice(0, 14))}」</small>${icon('plus')}<span class="sr-only">加入</span>
    </button>`).join('')}` : '';
}

$('#semanticSuggest').addEventListener('click', (event) => {
  const name = event.target.closest('[data-add-semantic]')?.dataset.addSemantic;
  const found = rx.semantic.find((c) => c.name === name);
  if (!found) return;
  rx.record.removed_conditions = rx.record.removed_conditions.filter((n) => n !== name);
  rx.record.conditions.push({ name, source: 'semantic', matched: found.matched, icd10: found.icd10 });
  rx.semantic = rx.semantic.filter((c) => c.name !== name);
  renderConditions();
  renderSemantic();
  scheduleSave();
  refreshRecommendations();
});

// 關鍵字結果會整批更新；AI、語意、語音與手動加入的保留；醫師移除過的不再自動加回
function mergeConditions(found, source) {
  const r = rx.record;
  const kept = r.conditions.filter((c) => (source === 'keyword' ? c.source !== 'keyword' || found.some((f) => f.name === c.name) : true));
  const names = new Set(kept.map((c) => c.name));
  const added = found.filter((c) => !names.has(c.name) && !r.removed_conditions.includes(c.name));
  const next = [...kept, ...added];
  const changed = JSON.stringify(next.map((c) => c.name)) !== JSON.stringify(r.conditions.map((c) => c.name));
  r.conditions = next;
  if (changed) {
    renderConditions();
    renderSemantic();
    scheduleSave();
    refreshRecommendations();
  }
  return changed;
}

/* ---------- 現病史症狀：補對症用藥，不列入問題清單 ---------- */

// 關鍵字結果整批更新；AI 找到的在原文還在時保留；醫師移除過的不再自動加回
// save=false：開啟舊病歷時補抓的症狀只用來顯示與推薦，不存檔（不改動修改時間，已完成的病歷不會變成「完成後有修改」）
function mergeSymptoms(found, source, { save = true } = {}) {
  const r = rx.record;
  const sText = subjectiveText().toLowerCase().replace(/\s+/g, '');
  const kept = (r.symptoms || []).filter((x) => (source === 'keyword'
    ? (x.source === 'keyword' ? found.some((f) => f.name === x.name) : sText.includes((x.matched || '').toLowerCase().replace(/\s+/g, '')))
    : true));
  const names = new Set(kept.map((x) => x.name));
  const added = found.filter((x) => !names.has(x.name) && !(r.removed_symptoms || []).includes(x.name));
  const next = [...kept, ...added];
  const changed = JSON.stringify(next.map((x) => x.name)) !== JSON.stringify((r.symptoms || []).map((x) => x.name));
  r.symptoms = next;
  if (changed) {
    renderSymptoms();
    if (save) scheduleSave();
    refreshRecommendations();
  }
  return changed;
}

function renderSymptoms() {
  const r = rx.record;
  const list = r.symptoms || [];
  const removed = r.removed_symptoms || [];
  const box = $('#symptomStrip');
  box.hidden = !list.length && !removed.length;
  box.innerHTML = `
    <p class="symptom-label">${icon('pill')}現病史的症狀<small>用來補充對症用藥，不列入問題清單</small></p>
    <div class="symptom-chips">
      ${list.map((x) => `<span class="symptom-chip" title="依據：${escapeHtml(x.matched || '')}">${escapeHtml(x.name)}${x.matched && x.matched !== x.name ? `<small>${escapeHtml(x.matched.slice(0, 16))}</small>` : ''}
        <button type="button" data-remove-symptom="${escapeHtml(x.name)}" aria-label="移除症狀 ${escapeHtml(x.name)}">${icon('x')}</button></span>`).join('')}
      ${removed.map((n) => `<button type="button" class="restore-chip" data-restore-symptom="${escapeHtml(n)}" aria-label="復原症狀 ${escapeHtml(n)}">${escapeHtml(n)}<span aria-hidden="true">復原</span></button>`).join('')}
    </div>`;
}

$('#symptomStrip').addEventListener('click', (event) => {
  const r = rx.record;
  const remove = event.target.closest('[data-remove-symptom]')?.dataset.removeSymptom;
  const restore = event.target.closest('[data-restore-symptom]')?.dataset.restoreSymptom;
  if (remove) {
    r.symptoms = r.symptoms.filter((x) => x.name !== remove);
    r.removed_symptoms = [...new Set([...(r.removed_symptoms || []), remove])];
  } else if (restore) {
    r.removed_symptoms = r.removed_symptoms.filter((n) => n !== restore);
  } else return;
  renderSymptoms();
  scheduleSave();
  if (restore) detectConditions(); else refreshRecommendations();
});

const PLAN_LABELS = [['diagnostic', '診斷'], ['therapeutic', '治療'], ['educational', '衛教'], ['follow_up', '追蹤'], ['consult', '會診']];

// AI 參考計畫：一份統整計畫，預設模糊遮住，醫師寫完自己的 P 再偷看
function renderAiPlan() {
  const plan = rx.record.ai_plan || {};
  const box = $('#aiPlan');
  const has = PLAN_LABELS.some(([k]) => plan[k]);
  if (!has) {
    box.className = 'ai-plan empty';
    box.innerHTML = `<div class="ai-plan-head"><span>${icon('sparkles')}AI 參考計畫</span>
      <button type="button" class="link-button" data-ai-plan>產生</button></div>
      <p class="ai-plan-hint">先寫你自己的計畫，再產生 AI 的版本對照（會先遮住）</p>`;
    return;
  }
  const stale = JSON.stringify(plan.basis || []) !== JSON.stringify(rx.record.conditions.map((c) => c.name));
  const rows = PLAN_LABELS.filter(([k]) => plan[k]).map(([k, label]) => `<div><dt>${label}</dt><dd>${escapeHtml(plan[k])}</dd></div>`).join('');
  box.className = `ai-plan ${rx.peek ? 'shown' : ''}`;
  box.innerHTML = `
    <div class="ai-plan-head">
      <span>${icon('sparkles')}AI 參考計畫${stale ? '<em>問題清單已變更</em>' : ''}</span>
      <span class="ai-plan-actions">
        <button type="button" class="link-button" data-ai-plan>重新產生</button>
        <button type="button" class="link-button" data-peek aria-expanded="${rx.peek}">${rx.peek ? '遮住' : '偷看'}</button>
      </span>
    </div>
    <dl class="ai-plan-body" ${rx.peek ? '' : 'aria-hidden="true" inert'}>${rows}</dl>`;
}

const rxLine = (p) => [rxName(p), p.dose, p.frequency, p.days && `${p.days} 天`].filter(Boolean).join(' ');

function renderPlanRx() {
  const list = rx.record.prescriptions;
  $('#planRx').innerHTML = list.length
    ? list.map((p) => `<b>${escapeHtml(rxName(p))}</b>${escapeHtml(rxLine(p).slice(rxName(p).length))}`).join('；')
    : '<span class="muted-text">尚未開藥，從推薦藥品「採用」後會出現在開藥區</span>';
}

function renderConditions() {
  const list = rx.record.conditions;
  const catalogNames = new Set(rx.catalog.conditions.map((c) => c.name));
  $('#problemList').innerHTML = list.length
    ? list.map((c, i) => `
      <li class="problem" data-index="${i}" style="${hueStyle(c.name)}">
        <span class="problem-no">#${i + 1}</span>
        <b>${escapeHtml(c.name)}</b>
        ${c.icd10 ? `<small>${escapeHtml(c.icd10)}</small>` : ''}
        <em ${c.matched ? `title="依據：${escapeHtml(c.matched)}"` : ''}>${SOURCE_LABEL[c.source] || ''}</em>
        ${catalogNames.has(c.name) ? '' : '<em class="no-recs">無推薦清單</em>'}
        <span class="problem-move">
          <button type="button" data-move="-1" aria-label="#${i + 1} ${escapeHtml(c.name)} 上移" ${i === 0 ? 'disabled' : ''}>${icon('arrow-left')}</button>
          <button type="button" data-move="1" aria-label="#${i + 1} ${escapeHtml(c.name)} 下移" ${i === list.length - 1 ? 'disabled' : ''}>${icon('arrow-right')}</button>
          <button type="button" class="problem-remove" data-remove-condition="${escapeHtml(c.name)}" aria-label="移除問題 ${escapeHtml(c.name)}">${icon('x')}</button>
        </span>
      </li>`).join('')
    : '<li class="problem-empty">尚未偵測到問題。寫下主訴與病史、使用語音看診，或從下方新增</li>';

  // 移除過的問題不會再被關鍵字加回，要讓醫師看得到、也能復原
  const removed = rx.record.removed_conditions;
  const box = $('#removedConditions');
  box.hidden = !removed.length;
  box.innerHTML = removed.length
    ? `<span>已移除，不再自動偵測：</span>${removed.map((n) => `<button type="button" class="restore-chip" data-restore-condition="${escapeHtml(n)}" aria-label="復原問題 ${escapeHtml(n)}">${escapeHtml(n)}<span aria-hidden="true">復原</span></button>`).join('')}`
    : '';
  renderAiPlan();
}

function removeCondition(name) {
  const r = rx.record;
  rx.removedCache[name] = r.conditions.find((c) => c.name === name);
  r.conditions = r.conditions.filter((c) => c.name !== name);
  r.removed_conditions = [...new Set([...r.removed_conditions, name])];
  renderConditions();
  scheduleSave();
  refreshRecommendations();
  showToast(`已移除「${name}」，之後不會再自動偵測`, { label: '復原', run: () => restoreCondition(name) });
}

function restoreCondition(name) {
  const r = rx.record;
  r.removed_conditions = r.removed_conditions.filter((n) => n !== name);
  if (!r.conditions.some((c) => c.name === name)) {
    const info = rx.catalog.conditions.find((c) => c.name === name);
    r.conditions.push(rx.removedCache[name] || { name, source: 'manual', icd10: info?.icd10 || '' });
  }
  renderConditions();
  scheduleSave();
  refreshRecommendations();
}

$('#problemList').addEventListener('click', (event) => {
  const remove = event.target.closest('[data-remove-condition]');
  if (remove) return removeCondition(remove.dataset.removeCondition);
  const move = event.target.closest('[data-move]');
  if (move) {
    const list = rx.record.conditions;
    const from = Number(move.closest('.problem').dataset.index);
    const to = from + Number(move.dataset.move);
    if (to < 0 || to >= list.length) return;
    [list[from], list[to]] = [list[to], list[from]];
    renderConditions();
    scheduleSave();
    refreshRecommendations();
    $(`#problemList .problem[data-index="${to}"] [data-move="${move.dataset.move}"]`)?.focus();
  }
});

$('#removedConditions').addEventListener('click', (event) => {
  const name = event.target.closest('[data-restore-condition]')?.dataset.restoreCondition;
  if (name) restoreCondition(name);
});

function addProblem(name, extra = {}) {
  if (!name || rx.record.conditions.some((c) => c.name === name)) return false;
  const info = rx.catalog.conditions.find((c) => c.name === name);
  rx.record.removed_conditions = rx.record.removed_conditions.filter((n) => n !== name);
  rx.record.conditions.push({ name, source: 'manual', icd10: info?.icd10 || '', custom: !info, ...extra });
  return true;
}

$('#conditionAdd').addEventListener('change', (event) => {
  const name = event.target.value;
  event.target.value = '';
  if (!addProblem(name)) return;
  renderConditions();
  renderSemantic();
  scheduleSave();
  refreshRecommendations();
});

$('#customProblemForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('#customProblem').value.trim();
  if (!name) return;
  if (!addProblem(name)) return showToast(`「${name}」已在問題清單`);
  $('#customProblem').value = '';
  renderConditions();
  scheduleSave();
  refreshRecommendations();
});

$('#aiDetectButton').addEventListener('click', async () => {
  const button = $('#aiDetectButton');
  const text = recordText();
  if (!text.trim()) return showToast('請先輸入主訴或病史');
  button.disabled = true;
  button.innerHTML = `${icon('sparkles')}<span>AI 偵測中…</span>`;
  try {
    const result = await api('/api/detect/ai', jsonBody({ text, s_text: subjectiveText() }));
    const before = rx.record.conditions.length;
    // AI 明確找到的病灶，即使先前被移除也重新加入
    rx.record.removed_conditions = rx.record.removed_conditions.filter((n) => !result.conditions.some((c) => c.name === n));
    mergeConditions(result.conditions, 'ai');
    rx.record.removed_symptoms = (rx.record.removed_symptoms || []).filter((n) => !result.symptoms.some((x) => x.name === n));
    const symptomsBefore = (rx.record.symptoms || []).length;
    mergeSymptoms(result.symptoms || [], 'ai');
    const newSymptoms = rx.record.symptoms.length - symptomsBefore;
    renderConditions();
    const added = rx.record.conditions.length - before;
    const other = $('#aiOther');
    other.hidden = !result.other.length;
    other.innerHTML = result.other.length
      ? `AI 另外看到：${result.other.map((o) => `<button type="button" class="restore-chip" data-add-other="${escapeHtml(o)}">${escapeHtml(o)}<span aria-hidden="true">加入</span></button>`).join('')}（不在清單，沒有用藥推薦）`
      : '';
    showToast([added ? `AI 新增 ${added} 個問題` : 'AI 沒有找到其他清單中的問題', newSymptoms ? `${newSymptoms} 個症狀` : ''].filter(Boolean).join('、'));
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = `${icon('sparkles')}<span>AI 偵測</span>`;
  }
});

$('#aiOther').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-add-other]');
  if (!chip || !addProblem(chip.dataset.addOther, { source: 'ai' })) return;
  chip.remove();
  renderConditions();
  scheduleSave();
});

async function generateAiPlan(button) {
  if (!rx.record?.conditions.length) return showToast('請先建立至少一個問題');
  button.disabled = true;
  button.textContent = '產生中…';
  try {
    await flushSave();
    rx.record.ai_plan = await api(`/api/records/${rx.record.id}/ai-plan`, { method: 'POST' });
    rx.peek = false;
    renderAiPlan();
    showToast('AI 參考計畫已產生（先遮住）。寫完你的計畫後按「偷看」對照');
  } catch (error) {
    showToast(error.message);
    renderAiPlan();
  }
}

$('#aiPlan').addEventListener('click', (event) => {
  const generate = event.target.closest('[data-ai-plan]');
  if (generate) return generateAiPlan(generate);
  if (event.target.closest('[data-peek]')) {
    rx.peek = !rx.peek;
    renderAiPlan();
    $('#aiPlan [data-peek]').focus();
  }
});

/* ---------- 推薦 ---------- */

async function refreshRecommendations() {
  const r = rx.record;
  if (!r) return;
  const box = $('#recRows');
  if (!r.conditions.length && !(r.symptoms || []).length) {
    rx.recs = { rows: [], excluded: [], risks: [] };
    box.innerHTML = `<div class="recs-empty"><div class="empty-mark">${icon('pill')}</div>
      <p>寫下主訴與病史後，這裡會依每個病灶列出推薦藥品。</p></div>`;
    $('#excludedBox').hidden = true;
    renderSafety();
    return;
  }
  try {
    rx.recs = await api('/api/recommendations', jsonBody({
      conditions: r.conditions.map((c) => c.name), symptoms: r.symptoms || [], allergies: r.allergies, dismissed: r.dismissed,
      text: recordText(), age: $('#pAge').value.trim(),
    }));
    rx.riskSig = (rx.recs.risks || []).map((x) => x.id).join();
    renderRecommendations();
    const total = rx.recs.rows.reduce((n, row) => n + row.items.length, 0);
    $('#recsStatus').textContent = `推薦已更新：${rx.recs.rows.length} 個病灶，共 ${total} 個藥品`;
  } catch (error) {
    showToast(error.message);
  }
}

function inPrescription(atc) {
  return rx.record.prescriptions.some((p) => p.atc_code === atc);
}

function recCardHtml(item, condition, active) {
  const name = item.display_name || drugLabel(item.name_en);
  const glyph = name.slice(0, 1).toUpperCase();
  const cover = item.image_url
    ? `<img src="${escapeHtml(item.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : `<span class="pill-glyph" aria-hidden="true">${escapeHtml(glyph)}</span>`;
  const adopted = inPrescription(item.atc_code);
  const tab = active ? '0' : '-1';
  const reasons = item.reasons.slice(0, 1)
    .map((text) => `<span class="rec-reason mine">${escapeHtml(text)}</span>`).join('');
  // 過敏同類警示與病史風險都只提醒、不排除
  const warnings = [item.warning, ...(item.risks || [])].filter(Boolean);
  const components = item.is_combination && item.components?.length
    ? `<span class="rec-components">成分：${item.components.slice(0, 3).map(escapeHtml).join('、')}${item.components.length > 3 ? ' 等' : ''}</span>` : '';
  return `
    <article class="rec-card ${adopted ? 'adopted' : ''}" style="${hueStyle(item.class_zh || item.atc_code.slice(0, 4))}" data-atc="${item.atc_code}" data-condition="${escapeHtml(condition)}">
      <button type="button" class="rec-open" data-open-drug="${item.atc_code}" tabindex="${tab}">
        <span class="rec-cover" data-glyph="${escapeHtml(glyph)}">${cover}</span>
        <span class="rec-body">
          <b>${escapeHtml(name)}</b>
          <span class="rec-class">${escapeHtml(item.class_zh || '未分類')}</span>
          ${components}
          ${reasons ? `<span class="rec-reasons">${reasons}</span>` : ''}
          ${warnings.length ? `<span class="rec-warning">${icon('triangle-alert')}<span>${escapeHtml(warnings[0])}</span></span>` : ''}
          <span class="rec-meta">${nhiTagHtml(item.nhi)}${escapeHtml(formsText(item.forms))}</span>
          <span class="sr-only">，查看詳細資料</span>
        </span>
      </button>
      <div class="rec-actions">
        <button type="button" class="adopt-button" data-adopt="${item.atc_code}" tabindex="${tab}" ${adopted ? 'disabled' : ''} aria-label="${adopted ? `${escapeHtml(name)} 已採用` : `採用 ${escapeHtml(name)}`}">${adopted ? `${icon('check')}已採用` : '採用'}</button>
        <button type="button" class="rec-more" data-more tabindex="${tab}" aria-label="${escapeHtml(name)} 的更多動作" aria-haspopup="menu" aria-expanded="false">${icon('ellipsis')}</button>
      </div>
      <div class="rec-menu" role="menu" aria-label="${escapeHtml(name)}" hidden>
        <button type="button" role="menuitem" data-dismiss>這次不用</button>
        <button type="button" role="menuitem" data-never>此病灶不再推薦</button>
        <button type="button" role="menuitem" data-save-drug>存到學習庫</button>
      </div>
    </article>`;
}

// 症狀列：標出從現病史哪一句抓到；上方病灶已推薦過的藥只列名稱
function symptomRowHtml(row, rowIndex, railId, collapsed, activeAtc) {
  const cond = row.condition;
  const { items } = row;
  const covered = row.covered?.length ? `<p class="symptom-covered">上方已推薦：${row.covered.map(escapeHtml).join('、')}</p>` : '';
  return `
    <section class="rec-row symptom-row ${collapsed ? 'collapsed' : ''}" style="animation-delay:${rowIndex * 60}ms">
      <div class="rec-row-head" style="${hueStyle(cond)}">
        <h3><button type="button" class="rec-row-toggle" data-toggle-row="${escapeHtml(cond)}" aria-expanded="${!collapsed}" aria-controls="${railId}">
          ${icon('chevron-down')}<span class="because">症狀</span>${escapeHtml(cond)}</button></h3>
        <div class="rec-row-side"><span title="現病史原文">來自：${escapeHtml(row.matched || '')}</span></div>
      </div>
      <div id="${railId}" ${collapsed ? 'hidden' : ''}>
        ${items.length ? `<div class="rail-wrap at-start">
            <button type="button" class="rail-nav prev" data-rail-nav="-1" tabindex="-1" aria-hidden="true">${icon('arrow-left')}</button>
            <div class="rec-rail" role="group" aria-label="症狀${escapeHtml(cond)}的對症用藥，用左右方向鍵切換藥品">
              ${items.map((item) => recCardHtml(item, cond, item.atc_code === activeAtc)).join('')}
            </div>
            <button type="button" class="rail-nav next" data-rail-nav="1" tabindex="-1" aria-hidden="true">${icon('arrow-right')}</button>
          </div>` : ''}
        ${covered}
      </div>
    </section>`;
}

function renderRecommendations() {
  const text = recordText();
  const rows = rx.recs.rows.map((row, rowIndex) => {
    const cond = row.condition;
    if (rx.collapsed[cond] === undefined) {
      rx.collapsed[cond] = Boolean(rx.catalog.conditions.find((c) => c.name === cond)?.chronic && CONTROLLED.test(text));
    }
    const collapsed = rx.collapsed[cond];
    const { items } = row;
    const activeAtc = items.some((i) => i.atc_code === rx.railActive[cond]) ? rx.railActive[cond] : items[0]?.atc_code;
    const railId = `rail-${rowIndex}`;
    if (row.kind === 'symptom') return symptomRowHtml(row, rowIndex, railId, collapsed, activeAtc);
    return `
      <section class="rec-row ${collapsed ? 'collapsed' : ''}" style="animation-delay:${rowIndex * 60}ms">
        <div class="rec-row-head" style="${hueStyle(cond)}">
          <h3><button type="button" class="rec-row-toggle" data-toggle-row="${escapeHtml(cond)}" aria-expanded="${!collapsed}" aria-controls="${railId}">
            ${icon('chevron-down')}<span class="because">因為</span>${escapeHtml(cond)}</button></h3>
          <div class="rec-row-side">
            <span>${collapsed ? `已收起・${items.length} 個` : `前 ${items.length} 名・共 ${row.total} 個候選`}</span>
            ${items.length ? `<button type="button" class="link-button" data-view-all="${escapeHtml(cond)}" aria-haspopup="dialog">看全部 ${items.length} 個</button>` : ''}
          </div>
        </div>
        <div id="${railId}" ${collapsed ? 'hidden' : ''}>
        ${items.length
          ? `<div class="rail-wrap at-start">
              <button type="button" class="rail-nav prev" data-rail-nav="-1" tabindex="-1" aria-hidden="true">${icon('arrow-left')}</button>
              <div class="rec-rail" role="group" aria-label="因為${escapeHtml(cond)}的推薦，用左右方向鍵切換藥品">
                ${items.map((item) => recCardHtml(item, cond, item.atc_code === activeAtc)).join('')}
              </div>
              <button type="button" class="rail-nav next" data-rail-nav="1" tabindex="-1" aria-hidden="true">${icon('arrow-right')}</button>
            </div>`
          : '<p class="muted-text rec-none">這個病灶目前沒有可推薦的藥品（可能都已被過敏或你的回饋排除）</p>'}
        </div>
      </section>`;
  }).join('');
  $('#recRows').innerHTML = rows;
  if (rowDialog.open) renderRowDialog();
  requestAnimationFrame(() => $$('#recRows .rec-rail').forEach(updateRailNav));

  const excluded = rx.recs.excluded;
  const box = $('#excludedBox');
  box.hidden = !excluded.length;
  const counts = excluded.reduce((acc, e) => ({ ...acc, [e.reason]: (acc[e.reason] || 0) + 1 }), {});
  const parts = [counts.allergy && `過敏 ${counts.allergy}`, counts.never && `不再推薦 ${counts.never}`, counts.dismissed && `這次不用 ${counts.dismissed}`].filter(Boolean);
  $('#excludedSummary').textContent = `已排除 ${excluded.length} 個${parts.length ? `（${parts.join('、')}）` : ''}`;
  $('#excludedList').innerHTML = excluded.map((e) => `
    <li><span class="excluded-name">${escapeHtml(e.name_en)}</span>${e.class_zh ? `<span class="excluded-class">${escapeHtml(e.class_zh)}</span>` : ''}<span class="excluded-why ${e.reason}">${escapeHtml(e.label)}・${escapeHtml(e.condition)}</span>
      ${e.reason === 'never' ? `<button type="button" class="link-button" data-restore-never="${e.atc_code}" data-condition="${escapeHtml(e.condition)}">復原</button>` : ''}
      ${e.reason === 'dismissed' ? `<button type="button" class="link-button" data-restore-dismiss="${e.atc_code}" data-condition="${escapeHtml(e.condition)}">復原</button>` : ''}
    </li>`).join('');
  renderSafety();
}

// 採用／移除只更新卡片狀態，不重繪整排（避免外觀圖重新淡入、焦點跑掉）
function syncAdoptState() {
  $$('.rec-card').forEach((card) => {
    const on = inPrescription(card.dataset.atc);
    card.classList.toggle('adopted', on);
    const button = card.querySelector('.adopt-button');
    if (button.disabled === on) return;
    const name = card.querySelector('.rec-body b').textContent;
    const hadFocus = document.activeElement === button;
    button.disabled = on;
    button.innerHTML = on ? `${icon('check')}已採用` : '採用';
    button.setAttribute('aria-label', on ? `${name} 已採用` : `採用 ${name}`);
    if (hadFocus) card.querySelector('.rec-open').focus();
  });
}

// 橫向列表左右箭頭：到頭或到尾時隱藏對應方向
function updateRailNav(rail) {
  const wrap = rail.closest('.rail-wrap');
  if (!wrap) return;
  wrap.classList.toggle('at-start', rail.scrollLeft <= 4);
  wrap.classList.toggle('at-end', rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 4);
}
// 滑鼠拖曳捲動橫向列表（觸控本來就能滑；拖曳後放開不觸發卡片點擊）
let railDrag = null;
$('#recRows').addEventListener('pointerdown', (event) => {
  const rail = event.target.closest('.rec-rail');
  if (!rail || event.pointerType !== 'mouse' || event.button !== 0 || event.target.closest('.rec-menu')) return;
  railDrag = { rail, x: event.clientX, left: rail.scrollLeft, moved: false, id: event.pointerId };
});
document.addEventListener('pointermove', (event) => {
  if (!railDrag || event.pointerId !== railDrag.id) return;
  const dx = event.clientX - railDrag.x;
  if (!railDrag.moved && Math.abs(dx) < 6) return;
  if (!railDrag.moved) {
    railDrag.moved = true;
    railDrag.rail.classList.add('dragging');
    railDrag.rail.setPointerCapture(event.pointerId);
  }
  railDrag.rail.scrollLeft = railDrag.left - dx;
});
document.addEventListener('pointerup', () => {
  if (!railDrag) return;
  const { rail, moved } = railDrag;
  railDrag = null;
  if (!moved) return;
  rail.classList.remove('dragging');
  // 拖曳結束的那次 click 不算點擊；若瀏覽器沒有送出 click，下一輪就移除，避免吃掉之後真正的點擊
  const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
  rail.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => rail.removeEventListener('click', swallow, { capture: true }), 0);
});
// 避免拖到外觀圖時觸發瀏覽器原生的圖片拖放
$('#recRows').addEventListener('dragstart', (event) => {
  if (event.target.closest('.rec-rail')) event.preventDefault();
});

$('#recRows').addEventListener('scroll', (event) => {
  if (event.target.classList?.contains('rec-rail')) updateRailNav(event.target);
}, true);

// 選單：焦點離開（例如按 Tab）就關閉
function closeMenuOnFocusLeave(event) {
  const menu = event.target.closest('.rec-menu');
  if (!menu || menu.hidden) return;
  const next = event.relatedTarget;
  if (next && (menu.contains(next) || next === menu.closest('.rec-card').querySelector('[data-more]'))) return;
  closeMenus();
}
$('#recRows').addEventListener('focusout', closeMenuOnFocusLeave);
$('#rowDialog').addEventListener('focusout', closeMenuOnFocusLeave);
// 彈窗裡的選單也能用上下鍵移動
$('#rowDialog').addEventListener('keydown', (event) => {
  const menu = event.target.closest('.rec-menu');
  if (!menu || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  const items = $$('button', menu);
  items[(items.indexOf(event.target) + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
});

// 鍵盤：每排只佔一個 Tab 停駐點，左右方向鍵切換卡片；選單內上下鍵移動
const CARD_CONTROLS = ['.rec-open', '.adopt-button', '.rec-more'];
$('#recRows').addEventListener('keydown', (event) => {
  const menu = event.target.closest('.rec-menu');
  if (menu && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault();
    const items = $$('button', menu);
    const next = (items.indexOf(event.target) + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
    return;
  }
  if (menu || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
  const card = event.target.closest('.rec-card');
  if (!card) return;
  const cards = $$('.rec-card', card.parentElement);
  const index = cards.indexOf(card);
  const target = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: cards.length - 1 }[event.key];
  const nextCard = cards[Math.max(0, Math.min(cards.length - 1, target))];
  if (!nextCard || nextCard === card) return;
  event.preventDefault();
  const role = CARD_CONTROLS.find((sel) => event.target.matches(sel)) || '.rec-open';
  cards.forEach((c) => CARD_CONTROLS.forEach((sel) => c.querySelector(sel)?.setAttribute('tabindex', c === nextCard ? '0' : '-1')));
  rx.railActive[nextCard.dataset.condition] = nextCard.dataset.atc;
  const control = nextCard.querySelector(role);
  (control && !control.disabled ? control : nextCard.querySelector('.rec-open')).focus();
  nextCard.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
});

$('#recRows').addEventListener('click', async (event) => {
  const toggle = event.target.closest('[data-toggle-row]');
  if (toggle) {
    const cond = toggle.dataset.toggleRow;
    rx.collapsed[cond] = !rx.collapsed[cond];
    renderRecommendations();
    $(`#recRows [data-toggle-row="${CSS.escape(cond)}"]`)?.focus();
    return;
  }
  const viewAll = event.target.closest('[data-view-all]');
  if (viewAll) return openRowDialog(viewAll.dataset.viewAll);
  const nav = event.target.closest('[data-rail-nav]');
  if (nav) {
    const rail = nav.parentElement.querySelector('.rec-rail');
    rail.scrollBy({ left: Number(nav.dataset.railNav) * rail.clientWidth * 0.85, behavior: 'smooth' });
    return;
  }
  handleCardClick(event);
});

// 推薦卡上的動作（列表與「看全部」彈窗共用）
async function handleCardClick(event) {
  const card = event.target.closest('.rec-card');
  if (!card) return;
  const atc = card.dataset.atc;
  const condition = card.dataset.condition;
  const item = rx.recs.rows.find((r) => r.condition === condition)?.items.find((i) => i.atc_code === atc);
  const name = item.display_name || drugLabel(item.name_en);
  rx.railActive[condition] = atc;

  if (event.target.closest('[data-open-drug]')) return openDrug(atc, condition);
  if (event.target.closest('[data-adopt]')) return adoptDrug(item, condition);
  if (event.target.closest('[data-more]')) {
    const menu = card.querySelector('.rec-menu');
    closeMenus(menu);
    menu.hidden = !menu.hidden;
    card.querySelector('[data-more]').setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) menu.querySelector('button').focus();
    return;
  }
  if (event.target.closest('[data-dismiss]')) {
    const entry = { condition, atc };
    rx.record.dismissed.push(entry);
    scheduleSave();
    showToast(`${name}：這次不用（不影響之後的推薦）`, { label: '復原', run: () => restoreDismiss(condition, atc) });
    return refreshRecommendations();
  }
  const never = event.target.closest('[data-never]');
  if (never) {
    // 會永久影響之後的推薦，需要再按一次確認
    if (!never.classList.contains('confirming')) {
      never.classList.add('confirming');
      never.textContent = '再按一次確認：之後不再推薦';
      $('#recsStatus').textContent = `再按一次確認：之後「${condition}」不再推薦 ${name}`;
      setTimeout(() => {
        if (!never.isConnected) return;
        never.classList.remove('confirming');
        never.textContent = '此病灶不再推薦';
      }, 3000);
      return;
    }
    await api('/api/feedback', jsonBody({ condition, atc_code: atc, action: 'never' }));
    showToast(`之後「${condition}」不再推薦 ${name}`, { label: '復原', run: () => restoreNever(condition, atc) });
    return refreshRecommendations();
  }
  if (event.target.closest('[data-save-drug]')) {
    closeMenus();
    return saveDrugToLibrary(atc, condition);
  }
}

/* ---------- 看全部：一次查看與操作同一病灶的所有推薦 ---------- */

const rowDialog = $('#rowDialog');

function openRowDialog(condition) {
  rx.dialogCondition = condition;
  renderRowDialog();
  rowDialog.showModal();
  $('#rowDialogTitle').focus();
}

function renderRowDialog() {
  const row = rx.recs.rows.find((r) => r.condition === rx.dialogCondition);
  if (!row) { rowDialog.close(); return; }
  $('#rowDialogTitle').innerHTML = `<span class="because">因為</span>${escapeHtml(row.condition)}`;
  $('#rowDialogMeta').textContent = `前 ${row.items.length} 名・共 ${row.total} 個候選；依病灶對照表、你的採用紀錄與市售品項數排序`;
  $('#rowDialogGrid').style.cssText = hueStyle(row.condition);
  $('#rowDialogGrid').innerHTML = row.items.length
    ? row.items.map((item) => recCardHtml(item, row.condition, true)).join('')
    : '<p class="muted-text">這個病灶目前沒有可推薦的藥品（可能都已被過敏或你的回饋排除）</p>';
}

rowDialog.addEventListener('click', (event) => {
  if (event.target === rowDialog || event.target.closest('[data-close]')) return rowDialog.close();
  handleCardClick(event);
});
// 選單開著時按 Esc 只關選單，不關彈窗
rowDialog.addEventListener('cancel', (event) => {
  if ($$('.rec-menu', rowDialog).some((m) => !m.hidden)) event.preventDefault();
});

async function restoreNever(condition, atc) {
  await api(`/api/feedback?condition=${encodeURIComponent(condition)}&atc_code=${atc}`, { method: 'DELETE' });
  showToast('已復原推薦');
  refreshRecommendations();
}

function restoreDismiss(condition, atc) {
  rx.record.dismissed = rx.record.dismissed.filter((d) => !(d.condition === condition && d.atc === atc));
  scheduleSave();
  refreshRecommendations();
}

$('#excludedList').addEventListener('click', (event) => {
  const never = event.target.closest('[data-restore-never]');
  if (never) restoreNever(never.dataset.condition, never.dataset.restoreNever);
  const dismiss = event.target.closest('[data-restore-dismiss]');
  if (dismiss) restoreDismiss(dismiss.dataset.condition, dismiss.dataset.restoreDismiss);
});

/* ---------- 推薦欄頂部：過敏與病史風險 ---------- */

function renderSafety() {
  if (!rx.record) return;
  // 安全資訊只寫系統真的做了什麼：過敏會排除；病史風險只在卡片提醒；其他禁忌由醫師確認
  const allergies = rx.record.allergies.map(allergyLabel);
  const blocked = new Set(rx.recs.excluded.filter((e) => e.reason === 'allergy').map((e) => e.atc_code)).size;
  const risks = rx.recs.risks || [];
  const box = $('#recsSafety');
  box.classList.toggle('has-allergy', allergies.length > 0);
  box.innerHTML = `${icon('shield-alert')}<div>
    <p>${allergies.length
      ? `過敏：<b>${allergies.map(escapeHtml).join('、')}</b>。${blocked
        ? `已從推薦排除 ${blocked} 個藥品 <button type="button" class="link-button" data-show-excluded>查看</button>`
        : '目前的推薦中沒有相關藥品。'}`
      : '無已知過敏。若病人有過敏，請在上方「新增過敏」加入，推薦會自動排除。'}</p>
    ${risks.length ? `<p class="safety-risk">病史風險：<b>${risks.map((r) => escapeHtml(r.label)).join('、')}</b>。相關藥品卡片已加上提醒，未排除。</p>` : ''}
    <p class="safety-scope">系統只依過敏排除藥品；病史中的其他禁忌請自行確認。</p>
  </div>`;
}

// 單欄版面（窄螢幕）時，開藥區不在畫面上就顯示浮動按鈕，點一下回到開藥區
let rxVisible = true;
function updateTrayFab() {
  const count = rx.record?.prescriptions.length || 0;
  const fab = $('#trayFab');
  fab.hidden = !count || rxVisible || !matchMedia('(max-width: 860px)').matches;
  fab.querySelector('span').textContent = `開藥區 ${count} 項`;
}
new IntersectionObserver(([entry]) => {
  rxVisible = entry.isIntersecting;
  updateTrayFab();
}).observe($('#rxSection'));
matchMedia('(max-width: 860px)').addEventListener('change', updateTrayFab);
$('#trayFab').addEventListener('click', () => {
  $('#rxSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#rxTitle').focus({ preventScroll: true });
});

// 頻率、天數：常用選項用下拉選單，選「自訂…」改成輸入框（例：Q6H PRN、TID×3天後改BID、45 天）
function doseHtml(p, index) {
  const name = escapeHtml(rxName(p));
  const editing = rx.customDose === `${index}:frequency`;
  const editingDays = rx.customDose === `${index}:days`;
  const customFreq = p.frequency && !FREQUENCY_CODES.includes(p.frequency);
  const customDays = p.days && !DAYS.includes(Number(p.days));
  const frequency = editing || customFreq
    ? `<input type="text" data-field="frequency" class="rx-custom" value="${escapeHtml(p.frequency || '')}"
         maxlength="30" placeholder="例：Q6H PRN" aria-label="${name} 自訂頻率" list="freqCodes">`
    : `<select data-field="frequency" aria-label="${name} 頻率">
      <option value="">頻率</option>
      ${FREQUENCY_GROUPS.map(([group, items]) => `<optgroup label="${group}">${items.map(([code, label]) =>
        `<option value="${code}" ${p.frequency === code ? 'selected' : ''}>${code}・${label}</option>`).join('')}</optgroup>`).join('')}
      <option value="${CUSTOM}">自訂…</option>
    </select>`;
  const days = editingDays || customDays
    ? `<label class="rx-custom-days"><input type="number" data-field="days" class="rx-custom" value="${escapeHtml(String(p.days || ''))}"
         min="1" max="365" step="1" inputmode="numeric" aria-label="${name} 自訂天數"> 天</label>`
    : `<select data-field="days" aria-label="${name} 天數">
      ${DAYS.map((d) => `<option value="${d}" ${Number(p.days) === d ? 'selected' : ''}>${d} 天</option>`).join('')}
      <option value="${CUSTOM}">自訂…</option>
    </select>`;
  return `
    <input type="text" data-field="dose" class="rx-dose-amount" value="${escapeHtml(p.dose || '')}" maxlength="20"
      placeholder="每次量" aria-label="${name} 每次劑量" title="每次劑量，例：1 粒、5 mL、1 包">
    ${frequency}${days}`;
}

function duplicateOf(index) {
  const list = rx.record.prescriptions;
  const p = list[index];
  if (!p?.class_zh) return '';
  const other = list.find((q, j) => j !== index && q.class_zh === p.class_zh);
  return other ? rxName(other) : '';
}

function rxHints(p, index) {
  const hints = [];
  if (!p.frequency) hints.push('<span class="rx-hint warn">請選擇頻率</span>');
  else if (p.frequency_from_ai) hints.push('<span class="rx-hint">頻率為 AI 常見用法，請確認</span>');
  if (p.days_default) hints.push(`<span class="rx-hint">${p.days} 天為預設值，請確認</span>`);
  const dup = duplicateOf(index);
  if (dup) hints.push(`<span class="rx-hint warn">${icon('triangle-alert')}與 ${escapeHtml(dup)} 同屬「${escapeHtml(p.class_zh)}」</span>`);
  return hints.join('');
}

function onDoseChange(event) {
  const field = event.target.closest('[data-field]');
  if (!field) return;
  const index = Number(field.closest('[data-index]').dataset.index);
  const key = field.dataset.field;
  const item = rx.record.prescriptions[index];
  const value = field.value.trim();
  if (value === CUSTOM) {
    rx.customDose = `${index}:${key}`;
    renderPrescriptions();
    $(`#rxList [data-index="${index}"] [data-field="${key}"]`)?.focus();
    return;
  }
  if (key === 'dose') { item.dose = value; scheduleSave(); return; }
  rx.customDose = '';
  if (key === 'days') {
    const days = Math.round(Number(value));
    if (days >= 1 && days <= 365) { item.days = days; item.days_default = false; }
  } else {
    item.frequency = value;
    item.frequency_from_ai = false;
  }
  renderPrescriptions();
  scheduleSave();
  $(`#rxList [data-index="${index}"] [data-field="${key}"]`)?.focus();
}
$('#rxList').addEventListener('change', onDoseChange);
$('#rxList').addEventListener('keydown', (event) => {
  const input = event.target.closest('input.rx-custom');
  if (!input) return;
  if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
  if (event.key === 'Escape' && rx.customDose) { rx.customDose = ''; renderPrescriptions(); }
});

function removeRx(index) {
  const [removed] = rx.record.prescriptions.splice(index, 1);
  renderPrescriptions();
  syncAdoptState();
  scheduleSave();
  showToast(`已從處方移除 ${rxName(removed)}`, {
    label: '復原',
    run: () => {
      rx.record.prescriptions.splice(index, 0, removed);
      renderPrescriptions();
      syncAdoptState();
      scheduleSave();
    },
  });
}

$('#recsSafety').addEventListener('click', (event) => {
  if (!event.target.closest('[data-show-excluded]')) return;
  const box = $('#excludedBox');
  box.open = true;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('#excludedSummary').focus({ preventScroll: true });
});
// 產生衛教單：先把尚未儲存的修改存好，再帶著問題清單與開藥區的處方到衛教單頁
async function makeEducation() {
  if (!rx.record?.conditions.length) return showToast('請先寫主訴或新增問題，再產生衛教單');
  clearTimeout(saveTimer);
  await saveRecord();
  createSheetFromRecord(rx.record.id);
}
$('#makeEducation').addEventListener('click', makeEducation);

/* ---------- 開藥區 ---------- */

const drugCache = {};
async function drugDetail(atc) {
  if (!drugCache[atc]) drugCache[atc] = await api(`/api/drugs/${atc}`);
  return drugCache[atc];
}

async function adoptDrug(item, condition) {
  if (inPrescription(item.atc_code)) return;
  const detail = await drugDetail(item.atc_code);
  // 預設品項：健保給付且有外觀圖 → 健保給付 → 有外觀圖；醫師可在開藥區改選
  const product = detail.products.find((p) => p.nhi?.length && p.image_url) || detail.products.find((p) => p.nhi?.length)
    || detail.products.find((p) => p.image_url) || detail.products[0] || {};
  const summary = detail.summary;
  const chronic = rx.catalog.conditions.find((c) => c.name === condition)?.chronic;
  const entry = {
    atc_code: item.atc_code,
    name_en: item.name_en,
    display_name: item.display_name || detail.display_name || '',
    name_zh: summary?.name_zh || '',
    class_zh: item.class_zh || detail.class_zh || detail.ahfs_main_name_zh || '',
    condition,
    license_no: product.license_no || '',
    product_name: product.name_zh || '',
    image_url: product.image_url || '',
    form: product.dosage_form || '',
    ...nhiFields(product),
    frequency: summary?.frequency || '',
    days: chronic ? 28 : 3,
    days_default: true,
    frequency_from_ai: Boolean(summary?.frequency),
  };
  rx.record.prescriptions.push(entry);
  if (condition) api('/api/feedback', jsonBody({ condition, atc_code: item.atc_code, action: 'adopt' })).catch(() => {});
  renderPrescriptions();
  scheduleSave();
  syncAdoptState();
  const dup = duplicateOf(rx.record.prescriptions.length - 1);
  showToast(dup ? `已採用 ${rxName(entry)}，注意與 ${dup} 同類` : `已採用 ${rxName(entry)}，請確認頻率與天數`, {
    label: '復原', run: () => undoAdopt(entry),
  });
}

function undoAdopt(entry) {
  rx.record.prescriptions = rx.record.prescriptions.filter((p) => p !== entry);
  if (entry.condition) {
    api(`/api/feedback?condition=${encodeURIComponent(entry.condition)}&atc_code=${entry.atc_code}&action=adopt`, { method: 'DELETE' }).catch(() => {});
  }
  renderPrescriptions();
  syncAdoptState();
  scheduleSave();
}

function renderPrescriptions() {
  const list = rx.record.prescriptions;
  $('#rxCount').textContent = list.length ? `${list.length} 項` : '';
  $('#rxList').innerHTML = list.length ? list.map((p, i) => `
    <div class="rx-item" data-index="${i}">
      <div class="rx-thumb" data-glyph="${escapeHtml(rxName(p).slice(0, 1).toUpperCase())}">${p.image_url ? `<img src="${escapeHtml(p.image_url)}" alt="" referrerpolicy="no-referrer" />` : icon('pill')}</div>
      <div class="rx-main">
        <b>${escapeHtml(rxName(p))}${p.name_zh ? `<small>${escapeHtml(p.name_zh)}</small>` : ''}</b>
        <button type="button" class="rx-product" data-pick-product="${i}"><span>${escapeHtml(p.product_name || '選擇品項')}</span>${icon('chevron-down')}</button>
        ${rxNhiHtml(p)}
        <div class="rx-dose">${doseHtml(p, i)}${rxHints(p, i)}</div>
        ${p.condition ? `<span class="rx-for" style="${hueStyle(p.condition)}">${escapeHtml(p.condition)}</span>` : ''}
      </div>
      <button type="button" class="rx-remove" data-remove-rx="${i}" aria-label="移除 ${escapeHtml(rxName(p))}">${icon('x')}</button>
      <div class="product-picker" hidden></div>
    </div>`).join('')
    : '<p class="rx-empty">從推薦藥品按「採用」，或用下方搜尋加入藥品。劑量與頻率由醫師決定。</p>';
  renderPlanRx();
  updateTrayFab();
}

$('#rxList').addEventListener('click', async (event) => {
  const remove = event.target.closest('[data-remove-rx]');
  if (remove) return removeRx(Number(remove.dataset.removeRx));
  const pick = event.target.closest('[data-pick-product]');
  if (pick) {
    const row = pick.closest('.rx-item');
    const picker = row.querySelector('.product-picker');
    if (!picker.hidden) { picker.hidden = true; return; }
    const item = rx.record.prescriptions[Number(pick.dataset.pickProduct)];
    const detail = await drugDetail(item.atc_code);
    picker.innerHTML = detail.products.slice(0, 40).map((p) => `
      <button type="button" data-license="${escapeHtml(p.license_no)}" class="${p.license_no === item.license_no ? 'selected' : ''}">
        ${p.image_url ? `<img src="${escapeHtml(p.image_url)}" alt="" referrerpolicy="no-referrer" />` : '<span class="no-img">無圖</span>'}
        <span><b>${escapeHtml(p.name_zh)}</b><small>${escapeHtml(p.dosage_form)}・${CATEGORY_LABEL[p.category] || ''}・${escapeHtml(p.applicant)}</small>
          <small class="${p.nhi.length ? 'picker-nhi' : 'picker-nhi self-pay'}">${p.nhi.length ? `健保 ${escapeHtml(p.nhi[0].code)}・每${escapeHtml(p.nhi[0].unit)} ${money(p.nhi[0].price)}${p.nhi.length > 1 ? `（另有 ${p.nhi.length - 1} 種規格）` : ''}` : '非健保給付（自費）'}</small></span>
      </button>`).join('');
    picker.hidden = false;
    return;
  }
  const license = event.target.closest('[data-license]');
  if (license) {
    const index = Number(license.closest('.rx-item').dataset.index);
    const item = rx.record.prescriptions[index];
    const p = (await drugDetail(item.atc_code)).products.find((x) => x.license_no === license.dataset.license);
    Object.assign(item, { license_no: p.license_no, product_name: p.name_zh, image_url: p.image_url, form: p.dosage_form, ...nhiFields(p) });
    renderPrescriptions();
    scheduleSave();
  }
});

bindDrugSearch($('#rxDrugSearch'), $('#rxDrugResults'), async (atc, name, display) => {
  const detail = await drugDetail(atc);
  await adoptDrug({ atc_code: atc, name_en: name, display_name: display, class_zh: detail.class_zh || '' }, '');
});

/* ---------- 藥品資訊卡 ---------- */

const drugDialog = $('#drugDialog');

async function openDrug(atc, condition = '') {
  const body = $('#drugBody');
  body.innerHTML = '<h2 class="sr-only" id="drugTitle">藥品資訊</h2><div class="reorganize-loading"><div class="spinner"></div>載入藥品資料…</div>';
  drugDialog.showModal();
  const d = await drugDetail(atc);
  const pictured = d.products.filter((p) => p.image_url).slice(0, 6);
  const q = encodeURIComponent(d.name_en.split(',')[0]);
  const adopted = inPrescription(atc);
  // TFDA 仿單以許可證查詢：已開立的用醫師選的品項，否則用預設品項（健保給付且有外觀圖優先）
  const tfdaLicense = rx.record?.prescriptions.find((p) => p.atc_code === atc)?.license_no
    || (d.products.find((p) => p.nhi?.length && p.image_url) || d.products.find((p) => p.nhi?.length) || d.products[0])?.license_no || '';
  body.innerHTML = `
    <div class="dialog-head">
      <div><h2 id="drugTitle" tabindex="-1">${escapeHtml(d.display_name || drugLabel(d.name_en))} <span class="drug-zh" id="drugZh">${escapeHtml(d.summary?.name_zh || '')}</span></h2>
        <p class="dialog-meta"><span>${icon('pill')}${escapeHtml(d.class_zh || d.ahfs_main_name_zh || '藥品資訊')}</span><span>ATC ${escapeHtml(atc)}</span></p>
        ${d.components?.length ? `<p class="drug-components">常見成分（各品項配方不同）：${d.components.map(escapeHtml).join('、')}</p>` : ''}</div>
      <button class="close-button" type="button" data-close aria-label="關閉">${icon('x')}</button>
    </div>
    ${pictured.length ? `<div class="drug-gallery">${pictured.map((p) => `<figure><img src="${escapeHtml(p.image_url)}" alt="" referrerpolicy="no-referrer" /><figcaption>${escapeHtml(p.name_zh)}</figcaption></figure>`).join('')}</div>` : ''}
    <section class="drug-summary" id="drugSummary">${summaryHtml(d.summary, d.summary_meta)}</section>
    <section class="drug-facts">
      <div><span>藥理分類</span><b>${escapeHtml(d.class_zh || d.ahfs_main_name_zh || '—')}</b></div>
      <div><span>ATC 階層</span><b>${d.class_path.filter(Boolean).map(escapeHtml).join(' › ')}</b></div>
      <div><span>TFDA 有效品項</span><b>${d.products.length} 個</b></div>
      ${d.nhi ? `<div><span>健保給付</span><b>${d.nhi.covered_products} 個品項</b>${d.nhi.covered_products
        ? `<p>支付價 ${d.nhi.price_min === d.nhi.price_max ? money(d.nhi.price_min) : `${money(d.nhi.price_min)}～${money(d.nhi.price_max)}`}${d.nhi.unit ? `／${escapeHtml(d.nhi.unit)}` : '（依劑型與規格）'}</p>` : ''}</div>` : ''}
      <div><span>常見劑型</span><b>${escapeHtml(d.common_dosage_forms || '—')}</b></div>
      <div class="wide"><span>許可證適應症（範例）</span><p>${escapeHtml(d.sample_indication || '—')}</p></div>
    </section>
    <details class="drug-products">
      <summary>市售品項與藥廠（${d.products.length}）</summary>
      <table><thead><tr><th>品名</th><th>劑型</th><th>類別</th><th>健保代碼與支付價</th><th>許可證</th><th>申請商</th></tr></thead>
      <tbody>${d.products.map((p) => `<tr><td>${escapeHtml(p.name_zh)}</td><td>${escapeHtml(p.dosage_form)}</td><td>${CATEGORY_LABEL[p.category] || ''}</td>
        <td>${p.nhi.length ? p.nhi.map((c) => `<span class="nhi-cell">${escapeHtml(c.code)}・${money(c.price)}／${escapeHtml(c.unit)}${c.next_price != null ? `<small>${escapeHtml(c.next_price_start)} 起 ${money(c.next_price)}</small>` : ''}</span>`).join('') : '<span class="self-pay">非健保給付</span>'}</td>
        <td>${escapeHtml(p.license_no)}</td><td>${escapeHtml(p.applicant)}</td></tr>`).join('')}</tbody></table>
    </details>
    <div class="drug-links">
      <span>延伸閱讀</span>
      ${tfdaLicense ? `<a href="https://mcp.fda.gov.tw/im_detail_1/${encodeURIComponent(tfdaLicense)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(tfdaLicense)}">TFDA 仿單${icon('external-link')}</a>` : ''}
      <a href="https://dailymed.nlm.nih.gov/dailymed/search.cfm?labeltype=all&query=${q}" target="_blank" rel="noopener noreferrer">DailyMed 仿單（美國）${icon('external-link')}</a>
      <a href="https://pubmed.ncbi.nlm.nih.gov/?term=${q}" target="_blank" rel="noopener noreferrer">PubMed 文獻${icon('external-link')}</a>
      <a href="https://www.openevidence.com/?q=${q}" target="_blank" rel="noopener noreferrer">OpenEvidence${icon('external-link')}</a>
    </div>
    <p class="drug-source">藥品資料：TFDA 開放資料（許可證、ATC、AHFS/DI、藥品外觀）${d.nhi_as_of ? `；健保給付與支付價：健保署健保用藥品項（基準日 ${escapeHtml(d.nhi_as_of)}）` : ''}。練習用途，非臨床建議。</p>
    <div class="dialog-actions sticky-actions">
      <button class="secondary-button" type="button" data-save-drug="${atc}" data-condition="${escapeHtml(condition)}">存到學習庫</button>
      ${rx.record ? `<button class="primary-button" type="button" data-adopt-drug="${atc}" data-condition="${escapeHtml(condition)}" ${adopted ? 'disabled' : ''}>${adopted ? `${icon('check')}已採用` : '採用'}</button>` : ''}
    </div>`;
  $('#drugTitle').focus();
}

function summaryHtml(summary, meta) {
  if (!summary) {
    return `<div class="summary-empty"><p>還沒有白話簡介。AI 會整理用途、機轉、常見用法與注意事項，每個成分只產生一次。</p>
      <button class="secondary-button" type="button" data-generate-summary>${icon('sparkles')}產生 AI 簡介</button></div>`;
  }
  const list = (items) => (items || []).map((t) => `<li>${escapeHtml(t)}</li>`).join('');
  return `
    <p class="summary-purpose">${escapeHtml(summary.purpose || '')}</p>
    <div class="summary-grid">
      <div><span>作用機轉</span><p>${escapeHtml(summary.mechanism || '')}</p></div>
      <div><span>常見用法</span><p>${escapeHtml(summary.common_usage || '')}${summary.frequency ? `（${escapeHtml(summary.frequency)}）` : ''}</p></div>
      <div><span>開立前留意</span><ul>${list(summary.cautions)}</ul></div>
      <div><span>給病人的提醒</span><ul>${list(summary.patient_tips)}</ul></div>
    </div>
    <p class="ai-label-line"><span class="ai-label">AI 產生，待醫師確認</span>${meta ? `${escapeHtml(meta.model)}・依一般藥品知識整理，非仿單` : ''}</p>`;
}

drugDialog.addEventListener('click', async (event) => {
  if (event.target === drugDialog || event.target.closest('[data-close]')) return drugDialog.close();
  const generate = event.target.closest('[data-generate-summary]');
  if (generate) {
    const atc = $('#drugBody [data-save-drug]').dataset.saveDrug;
    generate.disabled = true;
    generate.innerHTML = `${icon('sparkles')}AI 整理中…`;
    try {
      const result = await api(`/api/drugs/${atc}/summary`, { method: 'POST' });
      drugCache[atc] = { ...drugCache[atc], summary: result.summary, summary_meta: result.summary_meta };
      $('#drugSummary').innerHTML = summaryHtml(result.summary, result.summary_meta);
      $('#drugZh').textContent = result.summary.name_zh || '';
      // 已在開藥區的同成分，補上中文名與常見頻率
      rx.record?.prescriptions.filter((p) => p.atc_code === atc).forEach((p) => {
        p.name_zh = p.name_zh || result.summary.name_zh || '';
        if (!p.frequency && result.summary.frequency) { p.frequency = result.summary.frequency; p.frequency_from_ai = true; }
      });
      if (rx.record) renderPrescriptions();
    } catch (error) {
      generate.disabled = false;
      generate.innerHTML = `${icon('sparkles')}產生 AI 簡介`;
      showToast(error.message);
    }
    return;
  }
  const adopt = event.target.closest('[data-adopt-drug]');
  if (adopt) {
    const atc = adopt.dataset.adoptDrug;
    const d = await drugDetail(atc);
    await adoptDrug({ atc_code: atc, name_en: d.name_en, display_name: d.display_name, class_zh: d.class_zh || '' }, adopt.dataset.condition);
    adopt.disabled = true;
    adopt.innerHTML = `${icon('check')}已採用`;
  }
  const save = event.target.closest('[data-save-drug]');
  if (save) saveDrugToLibrary(save.dataset.saveDrug, save.dataset.condition);
});

async function saveDrugToLibrary(atc, condition) {
  try {
    const d = await drugDetail(atc);
    const s = d.summary;
    const name = d.display_name || d.name_en;
    const image = d.products.find((p) => p.image_url)?.image_url || '';
    await api('/api/library', jsonBody({
      kind: 'drug',
      title: s?.name_zh ? `${name}（${s.name_zh}）` : name,
      topic: condition ? `${condition}的用藥` : (d.class_zh || d.ahfs_main_name_zh || '藥品'),
      tags: [d.name_en, d.class_zh || d.ahfs_main_name_zh, condition, atc].filter(Boolean),
      note: s ? [s.purpose, `機轉：${s.mechanism}`, `常見用法：${s.common_usage}`, `留意：${(s.cautions || []).join('；')}`].join('\n') : (d.sample_indication || ''),
      ai_summary: s?.purpose || '',
      source_title: 'TFDA 開放資料',
      source_url: `https://dailymed.nlm.nih.gov/dailymed/search.cfm?labeltype=all&query=${encodeURIComponent(d.name_en.split(',')[0])}`,
      image_path: image,
      ai_meta: d.summary_meta ? { mode: 'azure', ...d.summary_meta } : {},
      ref_type: 'atc', ref_id: atc,
    }));
    if (typeof libraryState !== 'undefined') libraryState.loaded = false;
    showToast(`已存到學習庫「${condition ? `${condition}的用藥` : '藥品'}」`);
  } catch (error) {
    showToast(error.message);
  }
}

if (location.hash.startsWith('#records')) loadRecordsView();

/* ---------- 病歷管理：篩選、開啟、刪除 ---------- */

const recordsDialog = $('#recordsDialog');
const ageInRange = (age, range) => {
  if (!range) return true;
  const [min, max] = range.split('-').map(Number);
  const n = parseInt(age, 10);
  return Number.isFinite(n) && n >= min && n <= max;
};
const isCompleted = (r) => Boolean(r.completed_at);

function openRecordsDialog() {
  const names = new Set(rx.catalog.conditions.map((c) => c.name));
  rx.records.forEach((r) => r.conditions.forEach((c) => names.add(c.name)));
  const current = $('#fProblem').value;
  $('#fProblem').innerHTML = '<option value="">全部</option>' + [...names].map((n) => `<option ${n === current ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('');
  renderRecordsTable();
  recordsDialog.showModal();
  $('#fText').focus();
}

function filteredRecords() {
  const text = $('#fText').value.trim().toLowerCase();
  const age = $('#fAge').value;
  const sex = $('#fSex').value;
  const problem = $('#fProblem').value;
  const status = $('#fStatus').value;
  return rx.records.filter((r) => {
    const haystack = [r.patient_code, r.chief_complaint, r.history, r.exam, r.assessment, r.plan,
      ...r.conditions.map((c) => c.name)].join(' ').toLowerCase();
    return (!text || haystack.includes(text)) && ageInRange(r.age, age) && (!sex || r.sex === sex)
      && (!problem || r.conditions.some((c) => c.name === problem))
      && (!status || (status === 'done') === isCompleted(r));
  });
}

function renderRecordsTable() {
  const list = filteredRecords();
  $('#recordsCount').textContent = `共 ${rx.records.length} 份，符合 ${list.length} 份`;
  $('#recordsTbody').innerHTML = list.length ? list.map((r) => `
    <tr class="${rx.record?.id === r.id ? 'current' : ''}">
      <td class="nowrap">${escapeHtml(r.visit_date || r.created_at.slice(0, 10))}</td>
      <td class="nowrap"><b>${escapeHtml(r.patient_code || '未命名')}</b></td>
      <td class="nowrap">${escapeHtml([r.age && `${r.age} 歲`, r.sex].filter(Boolean).join('・') || '—')}</td>
      <td>${escapeHtml(r.chief_complaint || '—')}</td>
      <td>${r.conditions.length ? `<span class="mini-problems">${r.conditions.map((c, i) => `<b>#${i + 1} ${escapeHtml(c.name)}</b>`).join('')}</span>` : '<span class="muted-text">—</span>'}
        ${r.assessment ? `<small class="mini-assessment">${escapeHtml(r.assessment.replace(/\n/g, '　').slice(0, 60))}${r.assessment.length > 60 ? '…' : ''}</small>` : ''}</td>
      <td class="nowrap">${isCompleted(r) ? `<span class="status-done">${icon('check')}已完成</span>` : '<span class="status-draft">未完成</span>'}</td>
      <td class="nowrap row-actions">
        <button type="button" class="secondary-button compact-button" data-open-record="${r.id}">開啟</button>
        <button type="button" class="icon-button danger-icon" data-delete-record="${r.id}" aria-label="刪除 ${escapeHtml(r.patient_code || '這份病歷')}">${icon('trash-2')}</button>
      </td>
    </tr>`).join('')
    : '<tr><td colspan="7" class="records-empty">沒有符合條件的病歷</td></tr>';
}

['#fText', '#fAge', '#fSex', '#fProblem', '#fStatus'].forEach((sel) => $(sel).addEventListener('input', renderRecordsTable));
$('#fReset').addEventListener('click', () => {
  ['#fText', '#fAge', '#fSex', '#fProblem', '#fStatus'].forEach((sel) => { $(sel).value = ''; });
  renderRecordsTable();
  $('#fText').focus();
});
$('#manageRecordsButton').addEventListener('click', openRecordsDialog);

recordsDialog.addEventListener('click', async (event) => {
  if (event.target === recordsDialog || event.target.closest('[data-close]')) return recordsDialog.close();
  const open = event.target.closest('[data-open-record]');
  if (open) {
    recordsDialog.close();
    await flushSave();
    return openRecord(Number(open.dataset.openRecord));
  }
  const del = event.target.closest('[data-delete-record]');
  if (del) deleteRecord(Number(del.dataset.deleteRecord), del);
});

async function flushSave() {
  if (!rx.record) return;
  clearTimeout(saveTimer);
  if ($('#saveState').textContent === '編輯中…') await saveRecord();
}

// 刪除需要按兩次；刪除後 10 秒內可以從提示「復原」（以同樣內容重新建立）
async function deleteRecord(id, button) {
  if (!button.classList.contains('confirming')) {
    const label = button.querySelector('span');
    const original = label?.textContent;
    button.classList.add('confirming');
    button.setAttribute('aria-label', '再按一次確認刪除');
    button.title = '再按一次確認刪除';
    if (label) label.textContent = '再按一次確認';
    setTimeout(() => {
      button.classList.remove('confirming');
      button.removeAttribute('title');
      button.removeAttribute('aria-label');
      if (label) label.textContent = original;
    }, 3000);
    return;
  }
  const data = rx.records.find((r) => r.id === id) || (rx.record?.id === id ? rx.record : null);
  if (rx.record?.id === id) clearTimeout(saveTimer);
  try {
    await api(`/api/records/${id}`, { method: 'DELETE' });
  } catch (error) {
    return showToast(error.message);
  }
  rx.records = rx.records.filter((r) => r.id !== id);
  if (recordsDialog.open) renderRecordsTable();
  if (rx.record?.id === id) {
    rx.record = null;
    if (rx.records.length) await openRecord(rx.records[0].id);
    else await newRecord();
  } else {
    renderRecordSelect();
  }
  showToast(`已刪除 ${data?.patient_code || '病歷'}`, data ? { label: '復原', run: () => restoreRecord(data) } : null);
}

async function restoreRecord(data) {
  const created = await api('/api/records', { method: 'POST' });
  const saved = await api(`/api/records/${created.id}`, jsonBody({ ...data, id: created.id }, 'PUT'));
  rx.records.unshift(saved);
  await openRecord(saved.id);
  if (recordsDialog.open) renderRecordsTable();
  showToast(`已復原 ${saved.patient_code}（AI 參考計畫與英文版需重新產生）`);
}

$('#deleteRecordButton').addEventListener('click', (event) => {
  if (rx.record) deleteRecord(rx.record.id, event.currentTarget);
});

/* ---------- 完成病歷：中文 SOAP 與英文版 ---------- */

const noteDialog = $('#noteDialog');
let noteLang = 'en';

// 下方動作列：未完成時「刪除／完成病歷」；完成後換成「產生衛教單／產生英文版」
function updateRecordStatus() {
  const r = rx.record;
  const box = $('#recordState');
  const done = Boolean(r?.completed_at);
  const changed = done && r.updated_at > r.completed_at;
  $('#completeButton').hidden = done;
  $('#makeEducation').hidden = !done;
  $('#englishButton').hidden = !done;
  $('#recordBar').classList.toggle('done', done);
  const english = $('#englishButton span');
  if (!$('#englishButton').disabled) {
    english.textContent = !r?.english_note ? '產生英文版' : changed ? '更新英文版' : '檢視英文版';
  }
  if (!done) {
    box.className = 'record-status';
    box.textContent = '';
    return;
  }
  box.className = `record-status ${changed ? 'changed' : 'done'}`;
  box.innerHTML = changed ? '完成後有修改' : `${icon('check')}已完成`;
}

const indent = (text) => text.split('\n').map((l) => `   ${l}`);

// 中文 SOAP：S、O 各一段；A 先列問題清單再寫評估；P 計畫與處方
function chineseNote(r) {
  const allergies = r.allergies.length ? r.allergies.map(allergyLabel).join('、') : '無已知過敏';
  const lines = [
    `就診日期：${r.visit_date || '—'}　${r.patient_code}　${[r.age && `${r.age} 歲`, r.sex].filter(Boolean).join(' ')}　過敏：${allergies}`,
    '',
    `S：${r.chief_complaint || '—'}`,
  ];
  if (r.history) lines.push(...indent(r.history));
  lines.push('', `O：${r.exam ? '' : '—'}`);
  if (r.exam) lines.push(...indent(r.exam));
  lines.push('', 'A：');
  r.conditions.forEach((c, i) => lines.push(`   #${i + 1} ${c.name}${c.icd10 ? `（${c.icd10}）` : ''}`));
  if (r.assessment) lines.push(...indent(r.assessment));
  lines.push('', 'P：');
  if (r.plan) lines.push(...indent(r.plan));
  if (r.prescriptions.length) lines.push(`   處方：${r.prescriptions.map(rxLine).join('；')}`);
  return lines.join('\n');
}

function renderNote() {
  const r = rx.record;
  $('#notePanel').textContent = noteLang === 'en' ? (r.english_note || '（尚未產生英文版）') : chineseNote(r);
  $$('.note-tabs [role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.lang === noteLang)));
  const changed = r.updated_at > r.completed_at;
  $('#noteMeta').textContent = r.completed_at
    ? `完成於 ${r.completed_at.replace('T', ' ').slice(0, 16)}${changed ? '・之後有修改，英文版可能不是最新' : ''}`
    : '';
}

async function completeRecord() {
  const r = rx.record;
  if (!r) return;
  const button = $('#completeButton');
  button.disabled = true;
  try {
    await flushSave();
    const saved = await api(`/api/records/${r.id}/complete`, { method: 'POST' });
    Object.assign(r, { completed_at: saved.completed_at, updated_at: saved.updated_at });
    const index = rx.records.findIndex((x) => x.id === r.id);
    if (index >= 0) rx.records[index] = { ...rx.records[index], ...saved };
    showToast('病歷已完成，可以產生衛教單或英文版');
    updateRecordStatus();
    $('#makeEducation').focus();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

// 英文版：沒有或已過期就請 AI 產生，否則直接打開
async function englishVersion() {
  const r = rx.record;
  if (!r) return;
  if (r.english_note && r.updated_at <= r.completed_at) {
    noteLang = 'en';
    renderNote();
    return noteDialog.showModal();
  }
  const button = $('#englishButton');
  button.disabled = true;
  $('#englishButton span').textContent = '產生英文版中…';
  try {
    await generateEnglish();
    noteDialog.showModal();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    updateRecordStatus();
  }
}

async function generateEnglish() {
  const r = rx.record;
  await flushSave();
  const saved = await api(`/api/records/${r.id}/english`, { method: 'POST' });
  Object.assign(r, { english_note: saved.english_note, completed_at: saved.completed_at, updated_at: saved.updated_at });
  const index = rx.records.findIndex((x) => x.id === r.id);
  if (index >= 0) rx.records[index] = { ...rx.records[index], ...saved };
  noteLang = 'en';
  renderNote();
}

$('#englishButton').addEventListener('click', englishVersion);
$('#completeButton').addEventListener('click', completeRecord);
noteDialog.addEventListener('click', async (event) => {
  if (event.target === noteDialog || event.target.closest('[data-close]')) return noteDialog.close();
  const tab = event.target.closest('[data-lang]');
  if (tab) { noteLang = tab.dataset.lang; renderNote(); }
});
$('.note-tabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  noteLang = noteLang === 'en' ? 'zh' : 'en';
  renderNote();
  $(`.note-tabs [data-lang="${noteLang}"]`).focus();
});
$('#noteCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#notePanel').textContent);
    showToast(noteLang === 'en' ? '已複製英文版' : '已複製中文版');
  } catch {
    showToast('無法複製，請手動選取文字');
  }
});
$('#noteRegenerate').addEventListener('click', async () => {
  const button = $('#noteRegenerate');
  button.disabled = true;
  try {
    await generateEnglish();
    updateRecordStatus();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

/* ---------- 語音看診：整段錄音 → 逐字稿 → AI 分段到 SOAP ---------- */

const voiceDialog = $('#voiceDialog');
const voice = { recorder: null, stream: null, chunks: [], timer: null, started: 0, result: null };

function voiceIdleHtml() {
  return `
    <div class="voice-stage">
      <button type="button" class="voice-record" id="voiceStart">${icon('mic')}<span>開始錄音</span></button>
      <p>看診時按下錄音，結束後按停止。AI 會把對話整理到 S、O 與各問題的 A／P。</p>
      <label class="link-button voice-upload">${icon('upload')}或上傳錄音檔<input type="file" id="voiceFile" accept="audio/*,.m4a,.mp3,.wav,.webm,.mp4" hidden /></label>
      <p class="voice-privacy">${icon('shield-alert')}錄音只用來轉成文字，處理完立即刪除。錄下真實病人前請先取得同意；試用期間建議用模擬情境。</p>
    </div>`;
}

function openVoiceDialog() {
  if (!rx.record) return;
  voice.result = null;
  $('#voiceBody').innerHTML = voiceIdleHtml();
  voiceDialog.showModal();
}

async function startVoice() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return showToast('這個瀏覽器不支援錄音，請改用上傳錄音檔');
  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return showToast('沒有麥克風權限，請在瀏覽器允許後再試');
  }
  const mimeType = pickAudioType();
  voice.recorder = new MediaRecorder(voice.stream, mimeType ? { mimeType } : undefined);
  voice.chunks = [];
  voice.recorder.ondataavailable = (e) => { if (e.data.size) voice.chunks.push(e.data); };
  voice.recorder.onstop = () => {
    stopVoiceStream();
    const type = voice.recorder.mimeType || 'audio/webm';
    if (voice.cancelled) return;
    const ext = type.includes('mp4') ? 'm4a' : 'webm';
    sendVoice(new File([new Blob(voice.chunks, { type })], `visit.${ext}`, { type }));
  };
  voice.cancelled = false;
  voice.recorder.start();
  voice.started = Date.now();
  $('#voiceBody').innerHTML = `
    <div class="voice-stage recording">
      <button type="button" class="voice-record stop" id="voiceStop">${icon('x')}<span>停止並整理</span></button>
      <p class="voice-timer" id="voiceTimer" role="timer">00:00</p>
      <p>錄音中…看診結束後按停止。最長約 20 分鐘。</p>
    </div>`;
  $('#voiceStop').focus();
  voice.timer = setInterval(() => {
    const sec = Math.floor((Date.now() - voice.started) / 1000);
    $('#voiceTimer').textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    if (sec >= 20 * 60) voice.recorder.stop();
  }, 500);
}

function stopVoiceStream() {
  clearInterval(voice.timer);
  voice.stream?.getTracks().forEach((t) => t.stop());
  voice.stream = null;
}

async function sendVoice(file) {
  $('#voiceBody').innerHTML = `<div class="voice-stage"><div class="spinner"></div><p id="voiceProgress">轉成文字中…</p><p class="muted-text">接著由 AI 分到 SOAP；5 分鐘的錄音約 30–40 秒</p></div>`;
  const form = new FormData();
  form.append('file', file);
  setTimeout(() => { const el = $('#voiceProgress'); if (el) el.textContent = 'AI 整理成 SOAP 中…'; }, 4000);
  try {
    voice.result = await api('/api/records/voice', { method: 'POST', body: form });
    renderVoicePreview();
  } catch (error) {
    $('#voiceBody').innerHTML = voiceIdleHtml();
    showToast(error.message);
  }
}

// 預覽：每一段都可以勾選要不要填入；欄位已有內容時接在後面，不覆蓋
function renderVoicePreview() {
  const { soap, transcript } = voice.result;
  const r = rx.record;
  const section = (key, label, value, existing) => value ? `
    <label class="voice-item">
      <input type="checkbox" data-voice="${key}" checked />
      <span><b>${label}</b>${existing ? '<em>接在原有內容後</em>' : ''}<span>${escapeHtml(value)}</span></span>
    </label>` : '';
  const problems = soap.problems.map((pr, i) => `#${i + 1} ${pr.name}${pr.custom ? '（不在清單）' : ''}${r.conditions.some((c) => c.name === pr.name) ? '（已在清單）' : ''}`).join('\n');
  const items = [
    section('chief', 'S 主訴', soap.chief_complaint, r.chief_complaint.trim()),
    section('history', 'S 現病史', soap.history, r.history.trim()),
    section('exam', 'O 身體檢查／檢驗', soap.exam, r.exam.trim()),
    section('problems', 'A 問題清單', problems, false),
    section('assessment', 'A 評估', soap.assessment, r.assessment.trim()),
    section('plan', 'P 計畫', soap.plan, r.plan.trim()),
  ].filter(Boolean);
  $('#voiceBody').innerHTML = `
    <div class="voice-preview">
      ${items.length ? items.join('') : '<p class="muted-text">逐字稿中沒有可以整理的內容。</p>'}
      <details class="voice-transcript"><summary>看逐字稿</summary><p>${escapeHtml(transcript)}</p></details>
      <p class="voice-note">AI 只整理錄音中說到的內容，請確認後再填入；處方請從推薦藥品採用。</p>
      <div class="dialog-actions">
        <button type="button" class="secondary-button" id="voiceRetry">${icon('mic')}重新錄音</button>
        <button type="button" class="primary-button" id="voiceApply" ${items.length ? '' : 'disabled'}>${icon('check')}填入勾選的內容</button>
      </div>
    </div>`;
  $('#voiceApply')?.focus();
}

const appendText = (current, add) => (current.trim() ? `${current.trimEnd()}\n${add}` : add);

async function applyVoice() {
  const { soap } = voice.result;
  rx.voiceDraft = null;
  const r = rx.record;
  const on = (key) => $(`[data-voice="${key}"]`)?.checked;
  const fill = (sel, value, key) => { if (on(key)) $(sel).value = appendText($(sel).value, value); };
  fill('#rChief', soap.chief_complaint, 'chief');
  fill('#rHistory', soap.history, 'history');
  fill('#rExam', soap.exam, 'exam');
  fill('#rAssessment', soap.assessment, 'assessment');
  fill('#rPlan', soap.plan, 'plan');
  voiceDialog.close();
  if (on('problems')) {
    soap.problems.forEach((pr) => addProblem(pr.name, { source: 'voice', icd10: pr.icd10, custom: pr.custom }));
    // 問題清單以語音整理的為準：關鍵字另外抓到的（例如「咳嗽」已含在上呼吸道感染）放到「已移除」，需要時可一鍵復原
    try {
      const keep = new Set(r.conditions.map((c) => c.name));
      const { conditions } = await api('/api/detect', jsonBody({ text: recordText() }));
      const skip = conditions.map((c) => c.name).filter((n) => !keep.has(n));
      r.removed_conditions = [...new Set([...r.removed_conditions, ...skip])];
    } catch { /* 偵測失敗就照一般流程 */ }
  }
  renderConditions();
  scheduleSave();
  await detectConditions();
  refreshRecommendations();
  showToast('已填入語音整理的內容，請檢查後修改');
  $('#soapSTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

voiceDialog.addEventListener('click', (event) => {
  if (event.target === voiceDialog || event.target.closest('[data-close]')) return voiceDialog.close();
  if (event.target.closest('#voiceStart')) return startVoice();
  if (event.target.closest('#voiceStop')) return voice.recorder?.stop();
  if (event.target.closest('#voiceRetry')) { $('#voiceBody').innerHTML = voiceIdleHtml(); return; }
  if (event.target.closest('#voiceApply')) applyVoice();
});
voiceDialog.addEventListener('change', (event) => {
  if (event.target.id === 'voiceFile' && event.target.files[0]) sendVoice(event.target.files[0]);
});
// 關閉視窗時停止錄音、不送出
voiceDialog.addEventListener('close', () => {
  if (voice.recorder?.state === 'recording') {
    voice.cancelled = true;
    voice.recorder.stop();
  }
  stopVoiceStream();
  // 從「新病歷 → 語音看診」進來卻沒有填入：刪掉那份空白病歷，不留下空的練習病歷
  const draft = rx.voiceDraft;
  rx.voiceDraft = null;
  const r = rx.record;
  const blank = r && r.id === draft && ![r.chief_complaint, r.history, r.exam, r.assessment, r.plan, $('#rChief').value, $('#rHistory').value].some((v) => v?.trim());
  if (blank) {
    clearTimeout(saveTimer);
    api(`/api/records/${draft}`, { method: 'DELETE' }).then(async () => {
      rx.records = rx.records.filter((x) => x.id !== draft);
      if (rx.records.length) await openRecord(rx.records[0].id); else renderRecordSelect();
    }).catch(() => {});
  }
});
