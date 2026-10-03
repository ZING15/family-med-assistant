/* ==========================================================
   病歷與開藥（F-03～F-07）
   流程：寫病歷 → 自動偵測病灶 → 依病灶列出推薦（每個病灶一排）
        → 醫師採用（寫入開藥區）／這次不用／此病灶不再推薦
   依賴 app.js 的 $、api、jsonBody、escapeHtml、showToast、hueStyle
   ========================================================== */

const FREQUENCIES = [
  ['QD', '每日一次'], ['BID', '每日兩次'], ['TID', '每日三次'], ['QID', '每日四次'],
  ['HS', '睡前'], ['PRN', '需要時'],
];
const DAYS = [1, 3, 5, 7, 14, 28];
const SOURCE_LABEL = { keyword: '關鍵字', ai: 'AI', manual: '手動' };

// ATC 有些名稱是全大寫（例：OTHER COLD PREPARATIONS），轉成一般大小寫
const drugLabel = (name) => (name && name === name.toUpperCase() ? name.charAt(0) + name.slice(1).toLowerCase() : name);

const rx = {
  catalog: { conditions: [], allergens: [] },
  records: [],
  record: null,
  recs: { rows: [], excluded: [] },
  category: '',
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
    const label = [r.patient_code || '未命名', r.age && `${r.age} 歲`, r.sex, r.chief_complaint && `・${r.chief_complaint.slice(0, 14)}`].filter(Boolean).join(' ');
    return `<option value="${r.id}" ${rx.record?.id === r.id ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
}

async function openRecord(id) {
  rx.record = await api(`/api/records/${id}`);
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
    $('#saveState').textContent = `儲存失敗：${error.message}`;
  }
}

['#pCode', '#pAge', '#pSex'].forEach((sel) => $(sel).addEventListener('input', scheduleSave));
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
      rx.allergyNames = { ...(rx.allergyNames || {}), [entry]: `${d.name_en}（個別藥品）` };
    } catch { /* 查不到就顯示代碼 */ }
  }
  renderAllergies();
}

function renderAllergies() {
  const list = rx.record.allergies;
  $('#allergyChips').innerHTML = list.length
    ? list.map((a) => `<span class="allergy-chip">${escapeHtml(allergyLabel(a))}<button type="button" data-remove-allergy="${escapeHtml(a)}" aria-label="移除 ${escapeHtml(allergyLabel(a))}">${icon('x')}</button></span>`).join('')
    : '<span class="muted-text">無已知過敏</span>';
  $$('#allergenOptions [data-allergen]').forEach((b) => b.classList.toggle('selected', list.includes(b.dataset.allergen)));
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

// Esc 關閉選單與過敏彈出框
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  closeMenus();
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
        ? items.map((d) => `<button type="button" data-atc="${d.atc_code}" data-name="${escapeHtml(d.name_en)}">
            <b>${escapeHtml(d.name_en)}</b><span>${escapeHtml(d.class_zh || '')}・${escapeHtml(d.sample_name || '')}</span></button>`).join('')
        : '<p class="muted-text">找不到符合的藥品</p>';
    }, 250);
  });
  results.addEventListener('click', (event) => {
    const button = event.target.closest('[data-atc]');
    if (!button) return;
    onPick(button.dataset.atc, button.dataset.name);
    input.value = '';
    results.innerHTML = '';
  });
}

bindDrugSearch($('#allergyDrugSearch'), $('#allergyDrugResults'), (atc, name) => {
  rx.allergyNames = { ...(rx.allergyNames || {}), [`atc:${atc}`]: `${name}（個別藥品）` };
  setAllergies([...rx.record.allergies, `atc:${atc}`]);
});

/* ---------- 病灶 ---------- */

async function detectConditions() {
  const text = [$('#rChief').value, $('#rHistory').value, $('#rAssessment').value].join('\n');
  const { conditions } = await api('/api/detect', jsonBody({ text }));
  mergeConditions(conditions, 'keyword');
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
}

function renderConditions() {
  const list = rx.record.conditions;
  $('#conditionChips').innerHTML = list.length
    ? list.map((c) => `
      <span class="condition-chip" style="${hueStyle(c.name)}" title="${c.matched ? `依據：${escapeHtml(c.matched)}` : ''}">
        <b>${escapeHtml(c.name)}</b><small>${escapeHtml(c.icd10 || '')}</small><em>${SOURCE_LABEL[c.source] || ''}</em>
        <button type="button" data-remove-condition="${escapeHtml(c.name)}" aria-label="移除 ${escapeHtml(c.name)}">${icon('x')}</button>
      </span>`).join('')
    : '<span class="muted-text">尚未偵測到病灶，請輸入主訴與病史，或手動新增</span>';
}

$('#conditionChips').addEventListener('click', (event) => {
  const name = event.target.closest('[data-remove-condition]')?.dataset.removeCondition;
  if (!name) return;
  const r = rx.record;
  r.conditions = r.conditions.filter((c) => c.name !== name);
  r.removed_conditions = [...new Set([...r.removed_conditions, name])];
  renderConditions();
  scheduleSave();
  refreshRecommendations();
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
    const added = rx.record.conditions.length - before;
    const other = $('#aiOther');
    other.hidden = !result.other.length;
    other.textContent = result.other.length ? `AI 另外看到：${result.other.join('、')}（不在推薦對照表中）` : '';
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
    box.innerHTML = `<div class="recs-empty"><div class="empty-mark">${icon('pill')}</div>
      <p>寫下主訴與病史後，這裡會依每個病灶列出推薦藥品。</p></div>`;
    $('#excludedBox').hidden = true;
    return;
  }
  try {
    rx.recs = await api('/api/recommendations', jsonBody({
      conditions: r.conditions.map((c) => c.name), allergies: r.allergies, dismissed: r.dismissed,
    }));
    renderRecommendations();
  } catch (error) {
    showToast(error.message);
  }
}

function inPrescription(atc) {
  return rx.record.prescriptions.some((p) => p.atc_code === atc);
}

function recCardHtml(item, condition, index) {
  const cover = item.image_url
    ? `<img src="${escapeHtml(item.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : `<span class="pill-glyph" aria-hidden="true">${escapeHtml(item.name_en.slice(0, 1).toUpperCase())}</span>`;
  const adopted = inPrescription(item.atc_code);
  return `
    <article class="rec-card ${adopted ? 'adopted' : ''}" style="${hueStyle(item.class_zh || item.atc_code.slice(0, 4))};--i:${index}" data-atc="${item.atc_code}" data-condition="${escapeHtml(condition)}">
      <button type="button" class="rec-open" data-open-drug="${item.atc_code}" aria-label="查看 ${escapeHtml(item.name_en)} 詳細資料">
        <div class="rec-cover">${cover}</div>
        <div class="rec-body">
          <b>${escapeHtml(drugLabel(item.name_en))}</b>
          <span class="rec-class">${escapeHtml(item.class_zh || item.atc_code)}</span>
          <span class="rec-reason">${escapeHtml(item.reasons[0] || '')}</span>
          ${item.warning ? `<span class="rec-warning">${icon('triangle-alert')}${escapeHtml(item.warning)}</span>` : ''}
        </div>
      </button>
      <div class="rec-actions">
        <button type="button" class="adopt-button" data-adopt="${item.atc_code}" ${adopted ? 'disabled' : ''}>${adopted ? `${icon('check')}已採用` : '採用'}</button>
        <button type="button" class="rec-more" data-more aria-label="更多動作" aria-haspopup="menu" aria-expanded="false">${icon('ellipsis')}</button>
        <div class="rec-menu" role="menu" hidden>
          <button type="button" role="menuitem" data-dismiss>這次不用</button>
          <button type="button" role="menuitem" data-never>此病灶不再推薦</button>
          <button type="button" role="menuitem" data-save-drug>存到學習庫</button>
        </div>
      </div>
    </article>`;
}

function renderRecommendations() {
  const rows = rx.recs.rows.map((row, rowIndex) => {
    const items = row.items.filter((item) => !rx.category || item.categories.includes(rx.category));
    return `
      <section class="rec-row" style="animation-delay:${rowIndex * 60}ms">
        <div class="rec-row-head" style="${hueStyle(row.condition)}">
          <h3><span class="because">因為</span>${escapeHtml(row.condition)}</h3>
          <span>${items.length} 個推薦${row.total > row.items.length ? `・共 ${row.total} 個候選` : ''}</span>
        </div>
        ${items.length
          ? `<div class="rec-rail">${items.map((item, i) => recCardHtml(item, row.condition, i)).join('')}</div>`
          : '<p class="muted-text rec-none">這個篩選條件下沒有推薦藥品</p>'}
      </section>`;
  }).join('');
  $('#recRows').innerHTML = rows;

  const excluded = rx.recs.excluded;
  const box = $('#excludedBox');
  box.hidden = !excluded.length;
  const counts = excluded.reduce((acc, e) => ({ ...acc, [e.reason]: (acc[e.reason] || 0) + 1 }), {});
  $('#excludedSummary').textContent = `已排除 ${excluded.length} 個（${[
    counts.allergy && `過敏 ${counts.allergy}`, counts.never && `不再推薦 ${counts.never}`, counts.dismissed && `這次不用 ${counts.dismissed}`,
  ].filter(Boolean).join('、')}）`;
  $('#excludedList').innerHTML = excluded.map((e) => `
    <li><span class="excluded-name">${escapeHtml(e.name_en)}</span><span class="excluded-why ${e.reason}">${escapeHtml(e.label)}・${escapeHtml(e.condition)}</span>
      ${e.reason === 'never' ? `<button type="button" class="link-button" data-restore-never="${e.atc_code}" data-condition="${escapeHtml(e.condition)}">復原</button>` : ''}
      ${e.reason === 'dismissed' ? `<button type="button" class="link-button" data-restore-dismiss="${e.atc_code}" data-condition="${escapeHtml(e.condition)}">復原</button>` : ''}
    </li>`).join('');
}

$$('.recs-filters .seg').forEach((seg) => seg.addEventListener('click', () => {
  rx.category = seg.dataset.cat;
  $$('.recs-filters .seg').forEach((s) => s.classList.toggle('active', s === seg));
  renderRecommendations();
}));

$('#recRows').addEventListener('click', async (event) => {
  const card = event.target.closest('.rec-card');
  if (!card) return;
  const atc = card.dataset.atc;
  const condition = card.dataset.condition;
  const item = rx.recs.rows.find((r) => r.condition === condition)?.items.find((i) => i.atc_code === atc);

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
    rx.record.dismissed.push({ condition, atc });
    scheduleSave();
    showToast(`${item.name_en}：這次不用（不影響之後的推薦）`);
    return refreshRecommendations();
  }
  if (event.target.closest('[data-never]')) {
    await api('/api/feedback', jsonBody({ condition, atc_code: atc, action: 'never' }));
    showToast(`之後「${condition}」不再推薦 ${item.name_en}，可在「已排除」復原`);
    return refreshRecommendations();
  }
  if (event.target.closest('[data-save-drug]')) return saveDrugToLibrary(atc, condition);
});

$('#excludedList').addEventListener('click', async (event) => {
  const never = event.target.closest('[data-restore-never]');
  if (never) {
    await api(`/api/feedback?condition=${encodeURIComponent(never.dataset.condition)}&atc_code=${never.dataset.restoreNever}`, { method: 'DELETE' });
    showToast('已復原推薦');
    refreshRecommendations();
  }
  const dismiss = event.target.closest('[data-restore-dismiss]');
  if (dismiss) {
    rx.record.dismissed = rx.record.dismissed.filter((d) => !(d.condition === dismiss.dataset.condition && d.atc === dismiss.dataset.restoreDismiss));
    scheduleSave();
    refreshRecommendations();
  }
});

/* ---------- 開藥區 ---------- */

const drugCache = {};
async function drugDetail(atc) {
  if (!drugCache[atc]) drugCache[atc] = await api(`/api/drugs/${atc}`);
  return drugCache[atc];
}

async function adoptDrug(item, condition, quiet = false) {
  if (inPrescription(item.atc_code)) return;
  const detail = await drugDetail(item.atc_code);
  const product = detail.products.find((p) => p.image_url) || detail.products[0] || {};
  const summary = detail.summary;
  rx.record.prescriptions.push({
    atc_code: item.atc_code,
    name_en: item.name_en,
    name_zh: summary?.name_zh || '',
    class_zh: item.class_zh || detail.ahfs_main_name_zh || '',
    condition,
    license_no: product.license_no || '',
    product_name: product.name_zh || '',
    image_url: product.image_url || '',
    form: product.dosage_form || '',
    frequency: summary?.frequency || '',
    days: 3,
    frequency_from_ai: Boolean(summary?.frequency),
  });
  if (condition) api('/api/feedback', jsonBody({ condition, atc_code: item.atc_code, action: 'adopt' })).catch(() => {});
  renderPrescriptions();
  scheduleSave();
  renderRecommendations();
  if (!quiet) showToast(`已加入開藥區：${item.name_en}，請確認品項與用法`);
}

function renderPrescriptions() {
  const list = rx.record.prescriptions;
  $('#rxCount').textContent = list.length ? `${list.length} 項` : '';
  $('#rxList').innerHTML = list.length ? list.map((p, i) => `
    <div class="rx-item" data-index="${i}">
      <div class="rx-thumb">${p.image_url ? `<img src="${escapeHtml(p.image_url)}" alt="" referrerpolicy="no-referrer" />` : icon('pill')}</div>
      <div class="rx-main">
        <b>${escapeHtml(p.name_en)}${p.name_zh ? `<small>${escapeHtml(p.name_zh)}</small>` : ''}</b>
        <button type="button" class="rx-product" data-pick-product="${i}"><span>${escapeHtml(p.product_name || '選擇品項')}</span>${icon('chevron-down')}</button>
        <div class="rx-dose">
          <select data-field="frequency" aria-label="頻率">
            <option value="">頻率</option>
            ${FREQUENCIES.map(([code, label]) => `<option value="${code}" ${p.frequency === code ? 'selected' : ''}>${code}・${label}</option>`).join('')}
          </select>
          <select data-field="days" aria-label="天數">
            ${DAYS.map((d) => `<option value="${d}" ${Number(p.days) === d ? 'selected' : ''}>${d} 天</option>`).join('')}
          </select>
          ${p.frequency_from_ai ? '<span class="rx-hint">常見用法（AI），請確認</span>' : p.frequency ? '' : '<span class="rx-hint warn">請選擇頻率</span>'}
        </div>
        ${p.condition ? `<span class="rx-for" style="${hueStyle(p.condition)}">${escapeHtml(p.condition)}</span>` : ''}
      </div>
      <button type="button" class="rx-remove" data-remove-rx="${i}" aria-label="移除 ${escapeHtml(p.name_en)}">${icon('x')}</button>
      <div class="product-picker" hidden></div>
    </div>`).join('')
    : '<p class="rx-empty">從右側推薦按「採用」，或用下方搜尋加入藥品。劑量與頻率由醫師決定。</p>';
}

$('#rxList').addEventListener('change', (event) => {
  const select = event.target.closest('select[data-field]');
  if (!select) return;
  const item = rx.record.prescriptions[Number(select.closest('.rx-item').dataset.index)];
  item[select.dataset.field] = select.dataset.field === 'days' ? Number(select.value) : select.value;
  item.frequency_from_ai = false;
  renderPrescriptions();
  scheduleSave();
});

$('#rxList').addEventListener('click', async (event) => {
  const remove = event.target.closest('[data-remove-rx]');
  if (remove) {
    rx.record.prescriptions.splice(Number(remove.dataset.removeRx), 1);
    renderPrescriptions();
    renderRecommendations();
    scheduleSave();
    return;
  }
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
        <span><b>${escapeHtml(p.name_zh)}</b><small>${escapeHtml(p.dosage_form)}・${p.category === 'rx' ? '處方' : '指示藥'}・${escapeHtml(p.applicant)}</small></span>
      </button>`).join('');
    picker.hidden = false;
    return;
  }
  const license = event.target.closest('[data-license]');
  if (license) {
    const index = Number(license.closest('.rx-item').dataset.index);
    const item = rx.record.prescriptions[index];
    const p = (await drugDetail(item.atc_code)).products.find((x) => x.license_no === license.dataset.license);
    Object.assign(item, { license_no: p.license_no, product_name: p.name_zh, image_url: p.image_url, form: p.dosage_form });
    renderPrescriptions();
    scheduleSave();
  }
});

bindDrugSearch($('#rxDrugSearch'), $('#rxDrugResults'), async (atc, name) => {
  const detail = await drugDetail(atc);
  await adoptDrug({ atc_code: atc, name_en: name, class_zh: detail.ahfs_main_name_zh || '' }, '', false);
});

/* ---------- 藥品資訊卡 ---------- */

const drugDialog = $('#drugDialog');

async function openDrug(atc, condition = '') {
  const body = $('#drugBody');
  body.innerHTML = '<div class="reorganize-loading"><div class="spinner"></div>載入藥品資料…</div>';
  drugDialog.showModal();
  const d = await drugDetail(atc);
  const pictured = d.products.filter((p) => p.image_url).slice(0, 6);
  const q = encodeURIComponent(d.name_en.split(',')[0]);
  const adopted = inPrescription(atc);
  body.innerHTML = `
    <div class="dialog-head">
      <div><h2>${escapeHtml(drugLabel(d.name_en))} <span class="drug-zh" id="drugZh">${escapeHtml(d.summary?.name_zh || '')}</span></h2>
        <p class="dialog-meta"><span>${icon('pill')}${escapeHtml(d.ahfs_main_name_zh || '藥品資訊')}</span><span>ATC ${escapeHtml(atc)}</span></p></div>
      <button class="close-button" type="button" data-close aria-label="關閉">${icon('x')}</button>
    </div>
    ${pictured.length ? `<div class="drug-gallery">${pictured.map((p) => `<figure><img src="${escapeHtml(p.image_url)}" alt="${escapeHtml(p.name_zh)}" referrerpolicy="no-referrer" /><figcaption>${escapeHtml(p.name_zh)}</figcaption></figure>`).join('')}</div>` : ''}
    <section class="drug-summary" id="drugSummary">${summaryHtml(d.summary, d.summary_meta)}</section>
    <section class="drug-facts">
      <div><span>藥理分類</span><b>${escapeHtml(d.ahfs_main_name_zh || '—')}</b></div>
      <div><span>ATC 階層</span><b>${d.class_path.filter(Boolean).map(escapeHtml).join(' › ')}</b></div>
      <div><span>TFDA 有效品項</span><b>${d.products.length} 個</b></div>
      <div><span>常見劑型</span><b>${escapeHtml(d.common_dosage_forms || '—')}</b></div>
      <div class="wide"><span>許可證適應症（範例）</span><p>${escapeHtml(d.sample_indication || '—')}</p></div>
    </section>
    <details class="drug-products">
      <summary>市售品項與藥廠（${d.products.length}）</summary>
      <table><thead><tr><th>品名</th><th>劑型</th><th>類別</th><th>許可證</th><th>申請商</th></tr></thead>
      <tbody>${d.products.map((p) => `<tr><td>${escapeHtml(p.name_zh)}</td><td>${escapeHtml(p.dosage_form)}</td><td>${p.category === 'rx' ? '處方' : '指示藥'}</td><td>${escapeHtml(p.license_no)}</td><td>${escapeHtml(p.applicant)}</td></tr>`).join('')}</tbody></table>
    </details>
    <div class="drug-links">
      <span>延伸閱讀</span>
      <a href="https://dailymed.nlm.nih.gov/dailymed/search.cfm?labeltype=all&query=${q}" target="_blank" rel="noopener noreferrer">DailyMed 仿單${icon('external-link')}</a>
      <a href="https://clinicaltrials.gov/search?intr=${q}" target="_blank" rel="noopener noreferrer">ClinicalTrials.gov 臨床試驗${icon('external-link')}</a>
      <a href="https://pubmed.ncbi.nlm.nih.gov/?term=${q}" target="_blank" rel="noopener noreferrer">PubMed 文獻${icon('external-link')}</a>
    </div>
    <p class="drug-source">藥品資料：TFDA 開放資料（許可證、ATC、AHFS/DI、藥品外觀）。練習用途，非臨床建議。</p>
    <div class="dialog-actions">
      <button class="secondary-button" type="button" data-save-drug="${atc}" data-condition="${escapeHtml(condition)}">存到學習庫</button>
      ${condition || rx.record ? `<button class="primary-button" type="button" data-adopt-drug="${atc}" data-condition="${escapeHtml(condition)}" ${adopted ? 'disabled' : ''}>${adopted ? `${icon('check')}已在開藥區` : '採用到開藥區'}</button>` : ''}
    </div>`;
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
      renderPrescriptions();
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
    await adoptDrug({ atc_code: atc, name_en: d.name_en, class_zh: d.ahfs_main_name_zh || '' }, adopt.dataset.condition);
    adopt.disabled = true;
    adopt.innerHTML = `${icon('check')}已在開藥區`;
  }
  const save = event.target.closest('[data-save-drug]');
  if (save) saveDrugToLibrary(save.dataset.saveDrug, save.dataset.condition);
});

async function saveDrugToLibrary(atc, condition) {
  try {
    const d = await drugDetail(atc);
    const s = d.summary;
    const image = d.products.find((p) => p.image_url)?.image_url || '';
    await api('/api/library', jsonBody({
      kind: 'drug',
      title: s?.name_zh ? `${d.name_en}（${s.name_zh}）` : d.name_en,
      topic: condition ? `${condition}的用藥` : (d.ahfs_main_name_zh || '藥品'),
      tags: [d.name_en, d.ahfs_main_name_zh, condition, atc].filter(Boolean),
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
