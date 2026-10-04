---
target: 病歷與開藥
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
target_identity: "file:/Users/zingbook/Documents/ZINBOOKAIR/緯育GAE265/個專/frontend/records.js"
target_fingerprint: "sha256:7c7121d55607c2b771b5b4ec9d8d36af37f7477f3f0aefc6cf3a57a6821df25e"
target_path: /Users/zingbook/Documents/ZINBOOKAIR/緯育GAE265/個專/frontend/records.js
timestamp: 2026-10-04T01-23-31Z
slug: frontend-records-js
closed: true
---
Method: dual-agent (A: design review · B: detector + browser evidence)

# Critique：病歷與開藥（frontend/records.js / #records）— 2026-10-04

## Design Health Score — 23/40（可接受；上次 21）
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | 桌機本次處方區有效；≤1180px 本次處方在約 1370–1650px 處，採用結果又看不到 |
| 2 | Match with real world | 2 | 「various」卡名；複方未列成分；兩張 diclofenac 只靠灰字區分；健保 n／m 是庫存數字 |
| 3 | User control & freedom | 3 | 全面可復原；復原提示 6 秒、鍵盤按不到 |
| 4 | Consistency & standards | 2 | 採用按鈕卡片外框 vs 對話框實心；處方兩處可編輯；健保標籤用狀態綠 |
| 5 | Error prevention | 2 | 病史「吃止痛藥曾胃出血」但 NSAID 排第 2–6 名無警示；過敏提示製造假安全感 |
| 6 | Recognition over recall | 3 | 過敏重複顯示；年齡、胃出血等風險不在卡片旁 |
| 7 | Flexibility & efficiency | 2 | 無快捷鍵、無慣用劑量一次採用、慢性病排無法收起 |
| 8 | Aesthetic & minimalist | 2 | 36 張等重卡片；paracetamol 跨排重複；外觀圖多為尺 |
| 9 | Error recovery | 2 | 其他錯誤顯示伺服器原文；不再推薦 API 失敗無補救 |
| 10 | Help & documentation | 2 | 未說明排序依據（含外觀圖、品項數） |

## Design Specificity Verdict
- LLM：外殼專屬（紙色、因為＋病灶、本次處方區）；卡片在無採用紀錄時沒有理由，退化成商品格。
- Deterministic：CLI 7 項（5 advisory 皆在側欄／學習庫、cream-palette 刻意、nested-cards 無位置）。瀏覽器 15–31 項：buried-raster（延遲淡入）與 edge-flush-cards（橫向列表）為誤報；真問題：375px 水平溢出 13px（#recordSelect 選項文字撐寬）。live server 已停止。

## Priority Issues
- [P0] 推薦未讀病史禁忌（胃出血→NSAID 無警示），過敏提示卻像完整安全檢查 → 安全提示限縮宣稱；病史風險關鍵字在相關類別卡片加琥珀提醒（不排除）。/impeccable harden → /impeccable clarify
- [P1] 卡片不助決策：每排 12 張、冷啟動無理由、排序含外觀圖與品項數 → 每排前 3 張＋「其他 n 個」、每卡一行理由（採用過→此病灶常用→類別用途）、外觀圖不影響排序、慢性病排可收起。/impeccable distill → /impeccable layout
- [P1] ≤1180px 採用回饋在畫面外、「新病歷」直排、「從右側推薦」文案錯、375px 溢出 → 861–1180 維持兩欄、按鈕不換行、文案中性、選單限寬。/impeccable adapt
- [P2] 命名殘留：various、複方無成分、同名劑型不分、每卡重複健保分數、健保標籤用狀態綠 → 劑型入標題、成分列出、健保只標健保／自費、標籤改中性外框。/impeccable clarify
- [P2] 暫時性控制項無障礙：復原提示 6 秒、確認狀態不播報、× 24px、對話框連結 20px 高、#rxDrugSearch 無標籤 → 懸停或聚焦暫停、≥10 秒、快捷鍵、播報、32px、aria-label。/impeccable audit → /impeccable harden

## Persona Red Flags
- Alex：無鍵盤直達採用、每藥重選頻率天數、不能收起無關排、方向鍵最多 11 步、處方雙編輯器。
- Sam：復原來不及、確認狀態不播報、外觀圖替代文字重複 6 次、menu 按 Tab 離開仍開著。
- 林醫師：約 1000px 並排時推薦在一頁半外；36 張無註解卡；紅色排除框可能讓人誤信 NSAID 安全。

## Minor Observations
- 外觀圖藥丸太小；「共 16 個候選」未說明差額；排除清單無類別；1440 寬時推薦欄自己捲動且本次處方蓋住第二排；副標排序說明不完整；aiOther 系統用語；本次處方 H3 置於推薦藥品 H2 下。

## Questions to Consider
- 右欄本次處方已是真正處方，左欄開藥區還需要是第二個編輯器嗎？
- 給新手每排 12 個選項合理嗎？預設 3 個附理由、看全部改為主動展開？
- 讀得懂 penicillin 過敏卻讀不懂胃出血，臨床與簡報上說得過去嗎？
