/* ==========================================================
   病歷與開藥（F-03～F-07）
   流程：寫病歷 → 自動偵測病灶 → 依病灶列出推薦（每個病灶一排）
        → 醫師採用（寫入開藥區）／這次不用／此病灶不再推薦
   依賴 app.js 的 $、$$、api、jsonBody、escapeHtml、showToast、hueStyle、icon
   ========================================================== */

const FREQUENCIES = [
  ['QD', '每日一次'], ['BID', '每日兩次'], ['TID', '每日三次'], ['QID', '每日四次'],
  ['HS', '睡前'], ['PRN', '需要時'],
];
const DAYS = [1, 3, 5, 7, 14, 28];
const SOURCE_LABEL = { keyword: '關鍵字', ai: 'AI', manual: '手動' };
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
    $('#conditionAdd').innerHTML = '<option value="">手動新增病灶…</option>'
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
  $('#rChief').value = rx.record.chief_complaint;
  $('#rHistory').value = rx.record.history;
  $('#rAssessment').value = rx.record.assessment;
  $('#aiOther').hidden = true;
  $('#saveState').textContent = '';
  renderRecordSelect();
  renderAllergies();
  resolveAllergyNames();
  renderConditions();
  renderPrescriptions();
  refreshRecommendations();
}

async function newRecord() {
  const record = await api('/api/records', { method: 'POST' });
  rx.records.unshift(record);
  await openRecord(record.id);
  $('#rChief').focus();
}

$('#recordSelect').addEventListener('change', (event) => openRecord(Number(event.target.value)));
$('#newRecordButton').addEventListener('click', newRecord);

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
    chief_complaint: $('#rChief').value, history: $('#rHistory').value, assessment: $('#rAssessment').value,
  });
  try {
    const saved = await api(`/api/records/${r.id}`, jsonBody(r, 'PUT'));
    const index = rx.records.findIndex((x) => x.id === r.id);
    if (index >= 0) rx.records[index] = saved;
    renderRecordSelect();
    $('#saveState').innerHTML = `${icon('check')}已自動儲存`;
  } catch (error) {
    $('#saveState').textContent = `儲存失敗，請稍後再試（${error.message}）`;
  }
}

['#pCode', '#pAge', '#pSex'].forEach((sel) => $(sel).addEventListener('input', scheduleSave));
// 年齡影響「65 歲以上」的提醒
let ageTimer;
$('#pAge').addEventListener('input', () => {
  clearTimeout(ageTimer);
  ageTimer = setTimeout(refreshRecommendations, 600);
});
['#rChief', '#rHistory', '#rAssessment'].forEach((sel) => $(sel).addEventListener('input', () => {
  scheduleSave();
  clearTimeout(detectTimer);
  detectTimer = setTimeout(detectConditions, 600);
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
  renderTray();
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

/* ---------- 病灶 ---------- */

async function detectConditions() {
  const text = [$('#rChief').value, $('#rHistory').value, $('#rAssessment').value].join('\n');
  const { conditions, risks } = await api('/api/detect', jsonBody({ text }));
  const changed = mergeConditions(conditions, 'keyword');
  // 病灶沒變但病史風險變了（例如補上「曾胃出血」），也要重新標示卡片提醒
  if (!changed && (risks || []).join() !== rx.riskSig) refreshRecommendations();
}

// 關鍵字結果會整批更新；AI 與手動加入的保留；醫師移除過的不再自動加回
function mergeConditions(found, source) {
  const r = rx.record;
  const kept = r.conditions.filter((c) => source === 'keyword' ? c.source !== 'keyword' : true);
  const names = new Set(kept.map((c) => c.name));
  const added = found.filter((c) => !names.has(c.name) && !r.removed_conditions.includes(c.name));
  const next = [...kept, ...added];
  const changed = JSON.stringify(next.map((c) => c.name)) !== JSON.stringify(r.conditions.map((c) => c.name));
  r.conditions = next;
  if (changed) {
    renderConditions();
    scheduleSave();
    refreshRecommendations();
  }
  return changed;
}

function renderConditions() {
  const list = rx.record.conditions;
  $('#conditionChips').innerHTML = list.length
    ? list.map((c) => `
      <span class="condition-chip" style="${hueStyle(c.name)}" ${c.matched ? `title="依據：${escapeHtml(c.matched)}"` : ''}>
        <b>${escapeHtml(c.name)}</b><small>${escapeHtml(c.icd10 || '')}</small><em>${SOURCE_LABEL[c.source] || ''}</em>
        ${c.matched ? `<span class="sr-only">，依據「${escapeHtml(c.matched)}」</span>` : ''}
        <button type="button" data-remove-condition="${escapeHtml(c.name)}" aria-label="移除 ${escapeHtml(c.name)}">${icon('x')}</button>
      </span>`).join('')
    : '<span class="muted-text">尚未偵測到病灶，請輸入主訴與病史，或手動新增</span>';

  // 移除過的病灶不會再被關鍵字加回，要讓醫師看得到、也能復原
  const removed = rx.record.removed_conditions;
  const box = $('#removedConditions');
  box.hidden = !removed.length;
  box.innerHTML = removed.length
    ? `<span>已移除，不再自動偵測：</span>${removed.map((n) => `<button type="button" class="restore-chip" data-restore-condition="${escapeHtml(n)}" aria-label="復原病灶 ${escapeHtml(n)}">${escapeHtml(n)}<span aria-hidden="true">復原</span></button>`).join('')}`
    : '';
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

$('#conditionChips').addEventListener('click', (event) => {
  const name = event.target.closest('[data-remove-condition]')?.dataset.removeCondition;
  if (name) removeCondition(name);
});
$('#removedConditions').addEventListener('click', (event) => {
  const name = event.target.closest('[data-restore-condition]')?.dataset.restoreCondition;
  if (name) restoreCondition(name);
});

$('#conditionAdd').addEventListener('change', (event) => {
  const name = event.target.value;
  event.target.value = '';
  if (!name || rx.record.conditions.some((c) => c.name === name)) return;
  const info = rx.catalog.conditions.find((c) => c.name === name);
  rx.record.removed_conditions = rx.record.removed_conditions.filter((n) => n !== name);
  rx.record.conditions.push({ name, source: 'manual', icd10: info?.icd10 || '' });
  renderConditions();
  scheduleSave();
  refreshRecommendations();
});

$('#aiDetectButton').addEventListener('click', async () => {
  const button = $('#aiDetectButton');
  const text = [$('#rChief').value, $('#rHistory').value, $('#rAssessment').value].join('\n');
  if (!text.trim()) return showToast('請先輸入主訴或病史');
  button.disabled = true;
  button.innerHTML = `${icon('sparkles')}<span>AI 偵測中…</span>`;
  try {
    const result = await api('/api/detect/ai', jsonBody({ text }));
    const before = rx.record.conditions.length;
    // AI 明確找到的病灶，即使先前被移除也重新加入
    rx.record.removed_conditions = rx.record.removed_conditions.filter((n) => !result.conditions.some((c) => c.name === n));
    mergeConditions(result.conditions, 'ai');
    renderConditions();
    const added = rx.record.conditions.length - before;
    const other = $('#aiOther');
    other.hidden = !result.other.length;
    other.textContent = result.other.length ? `AI 另外看到：${result.other.join('、')}（這些病灶目前沒有推薦清單）` : '';
    showToast(added ? `AI 新增 ${added} 個病灶` : 'AI 沒有找到其他病灶');
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = `${icon('sparkles')}<span>AI 偵測</span>`;
  }
});

/* ---------- 推薦 ---------- */

async function refreshRecommendations() {
  const r = rx.record;
  if (!r) return;
  const box = $('#recRows');
  if (!r.conditions.length) {
    rx.recs = { rows: [], excluded: [], risks: [] };
    box.innerHTML = `<div class="recs-empty"><div class="empty-mark">${icon('pill')}</div>
      <p>寫下主訴與病史後，這裡會依每個病灶列出推薦藥品。</p></div>`;
    $('#excludedBox').hidden = true;
    renderTray();
    return;
  }
  try {
    rx.recs = await api('/api/recommendations', jsonBody({
      conditions: r.conditions.map((c) => c.name), allergies: r.allergies, dismissed: r.dismissed,
      text: [$('#rChief').value, $('#rHistory').value, $('#rAssessment').value].join('\n'), age: $('#pAge').value.trim(),
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

function renderRecommendations() {
  const text = [$('#rChief').value, $('#rHistory').value, $('#rAssessment').value].join('\n');
  const rows = rx.recs.rows.map((row, rowIndex) => {
    const cond = row.condition;
    if (rx.collapsed[cond] === undefined) {
      rx.collapsed[cond] = Boolean(rx.catalog.conditions.find((c) => c.name === cond)?.chronic && CONTROLLED.test(text));
    }
    const collapsed = rx.collapsed[cond];
    const { items } = row;
    const activeAtc = items.some((i) => i.atc_code === rx.railActive[cond]) ? rx.railActive[cond] : items[0]?.atc_code;
    const railId = `rail-${rowIndex}`;
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
  renderTray();
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

/* ---------- 本次處方（推薦欄頂部）與過敏排除 ---------- */

function renderTray() {
  if (!rx.record) return;
  const list = rx.record.prescriptions;
  $('#trayCount').textContent = list.length ? `${list.length} 項` : '';
  $('#trayJump').hidden = !list.length;
  $('#trayList').innerHTML = list.length
    ? list.map((p, i) => `
      <div class="tray-item" data-index="${i}">
        <div class="tray-name">
          <b>${escapeHtml(rxName(p))}</b>
          ${p.nhi_code ? '<span class="nhi-tag">健保</span>' : p.nhi_code === '' ? '<span class="nhi-tag self-pay">自費</span>' : ''}
          ${p.condition ? `<span class="rx-for" style="${hueStyle(p.condition)}">${escapeHtml(p.condition)}</span>` : ''}
        </div>
        <div class="rx-dose">${doseHtml(p)}</div>
        <button type="button" class="rx-remove" data-remove-rx="${i}" aria-label="移除 ${escapeHtml(rxName(p))}">${icon('x')}</button>
        <div class="tray-hints">${rxHints(p, i)}</div>
      </div>`).join('')
    : '<p class="tray-empty">還沒有採用藥品。按下卡片上的「採用」，藥品會出現在這裡，頻率與天數由你決定。</p>';

  // 安全資訊只寫系統真的做了什麼：過敏會排除；病史風險只在卡片提醒；其他禁忌由醫師確認
  const allergies = rx.record.allergies.map(allergyLabel);
  const blocked = new Set(rx.recs.excluded.filter((e) => e.reason === 'allergy').map((e) => e.atc_code)).size;
  const risks = rx.recs.risks || [];
  $('#traySafety').classList.toggle('has-allergy', allergies.length > 0);
  $('#traySafety').innerHTML = `${icon('shield-alert')}<div>
    <p>${allergies.length
      ? `過敏：<b>${allergies.map(escapeHtml).join('、')}</b>。${blocked
        ? `已從推薦排除 ${blocked} 個藥品 <button type="button" class="link-button" data-show-excluded>查看</button>`
        : '目前的推薦中沒有相關藥品。'}`
      : '無已知過敏。若病人有過敏，請在「新增過敏」加入，推薦會自動排除。'}</p>
    ${risks.length ? `<p class="safety-risk">病史風險：<b>${risks.map((r) => escapeHtml(r.label)).join('、')}</b>。相關藥品卡片已加上提醒，未排除。</p>` : ''}
    <p class="safety-scope">系統只依過敏排除藥品；病史中的其他禁忌請自行確認。</p>
  </div>`;
  updateTrayFab();
}

// 單欄版面（窄螢幕）時，本次處方不在畫面上就顯示浮動按鈕，點一下回到本次處方
let trayVisible = true;
function updateTrayFab() {
  const count = rx.record?.prescriptions.length || 0;
  const fab = $('#trayFab');
  fab.hidden = !count || trayVisible || !matchMedia('(max-width: 860px)').matches;
  fab.querySelector('span').textContent = `本次處方 ${count} 項`;
}
new IntersectionObserver(([entry]) => {
  trayVisible = entry.isIntersecting;
  updateTrayFab();
}).observe($('#recsTray'));
matchMedia('(max-width: 860px)').addEventListener('change', updateTrayFab);
$('#trayFab').addEventListener('click', () => {
  $('#recsTray').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#trayTitle').focus({ preventScroll: true });
});

function doseHtml(p) {
  const name = escapeHtml(rxName(p));
  return `
    <select data-field="frequency" aria-label="${name} 頻率">
      <option value="">頻率</option>
      ${FREQUENCIES.map(([code, label]) => `<option value="${code}" ${p.frequency === code ? 'selected' : ''}>${code}・${label}</option>`).join('')}
    </select>
    <select data-field="days" aria-label="${name} 天數">
      ${DAYS.map((d) => `<option value="${d}" ${Number(p.days) === d ? 'selected' : ''}>${d} 天</option>`).join('')}
    </select>`;
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
  const select = event.target.closest('select[data-field]');
  if (!select) return;
  const where = select.closest('#trayList') ? '#trayList' : '#rxList';
  const index = Number(select.closest('[data-index]').dataset.index);
  const field = select.dataset.field;
  const item = rx.record.prescriptions[index];
  if (field === 'days') { item.days = Number(select.value); item.days_default = false; }
  else { item.frequency = select.value; item.frequency_from_ai = false; }
  renderPrescriptions();
  scheduleSave();
  $(`${where} [data-index="${index}"] select[data-field="${field}"]`)?.focus();
}
$('#trayList').addEventListener('change', onDoseChange);
$('#rxList').addEventListener('change', onDoseChange);

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

$('#trayList').addEventListener('click', (event) => {
  const remove = event.target.closest('[data-remove-rx]');
  if (remove) removeRx(Number(remove.dataset.removeRx));
});
$('#traySafety').addEventListener('click', (event) => {
  if (!event.target.closest('[data-show-excluded]')) return;
  const box = $('#excludedBox');
  box.open = true;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('#excludedSummary').focus({ preventScroll: true });
});
$('#trayJump').addEventListener('click', () => {
  $('#rxSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#rxSection .rx-product, #rxDrugSearch')?.focus({ preventScroll: true });
});

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
        <div class="rx-dose">${doseHtml(p)}${rxHints(p, i)}</div>
        ${p.condition ? `<span class="rx-for" style="${hueStyle(p.condition)}">${escapeHtml(p.condition)}</span>` : ''}
      </div>
      <button type="button" class="rx-remove" data-remove-rx="${i}" aria-label="移除 ${escapeHtml(rxName(p))}">${icon('x')}</button>
      <div class="product-picker" hidden></div>
    </div>`).join('')
    : '<p class="rx-empty">從推薦藥品按「採用」，或用下方搜尋加入藥品。劑量與頻率由醫師決定。</p>';
  renderTray();
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
      <a href="https://dailymed.nlm.nih.gov/dailymed/search.cfm?labeltype=all&query=${q}" target="_blank" rel="noopener noreferrer">DailyMed 仿單${icon('external-link')}</a>
      <a href="https://clinicaltrials.gov/search?intr=${q}" target="_blank" rel="noopener noreferrer">ClinicalTrials.gov 臨床試驗${icon('external-link')}</a>
      <a href="https://pubmed.ncbi.nlm.nih.gov/?term=${q}" target="_blank" rel="noopener noreferrer">PubMed 文獻${icon('external-link')}</a>
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
