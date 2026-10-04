---
target: 病歷與開藥
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
target_identity: "file:/Users/zingbook/Documents/ZINBOOKAIR/緯育GAE265/個專/frontend/records.js"
target_fingerprint: "sha256:106bc209c6576af1f32d53cd6fe753e4b94d740de4a47d6a6149ca1f6f63b26c"
target_path: /Users/zingbook/Documents/ZINBOOKAIR/緯育GAE265/個專/frontend/records.js
timestamp: 2026-10-03T14-10-30Z
slug: frontend-records-js
closed: true
---
Method: dual-agent (A: a3fb907b059877748 · B: a618a5df8b9df587c)

# Critique：病歷與開藥（frontend/records.js / #records）

## Design Health Score — 21/40（普通）
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | 採用結果落在折線下的開藥區，只有 2.6 秒 toast |
| 2 | Match with real world | 2 | 理由多為「TFDA 有效品項 n」；「combinations」當藥名；ATC 碼當類別 |
| 3 | User control & freedom | 2 | 移除病灶／處方／採用無復原；× 病灶靜默寫入 removed_conditions |
| 4 | Consistency & standards | 3 | 「採用」vs「採用到開藥區」；篩選缺 aria-pressed |
| 5 | Error prevention | 2 | 紅色「不再推薦」緊鄰「這次不用」一鍵永久；無同類重複警示 |
| 6 | Recognition over recall | 2 | 推薦區與藥品卡看不到過敏；已排除收在最底 |
| 7 | Flexibility & efficiency | 1 | 推薦區約 180 個 Tab 停駐；橫向 rail 需 shift+滾輪 |
| 8 | Aesthetic & minimalist | 2 | 60 張卡；118px 照片封面決策價值低 |
| 9 | Error recovery | 2 | 照片載入失敗封面全空；錯誤 toast 直接顯示 error.message |
| 10 | Help & documentation | 3 | 空狀態文案好；排序依據缺乏說明 |

## Design Specificity Verdict
- LLM：視覺語言（紙色、墨水、襯線病灶名、「因為 X」）高度專屬；互動模式（Netflix 照片貨架）可替換。應像「學長在處方集上的眉批」而非「精選貨架」。
- Deterministic：detect CLI 7 項（cream-palette 刻意＝誤報；nested-cards 無法定位；5 個 advisory 皆在側欄／學習庫上傳）。瀏覽器 52 項：buried-raster ~48 為 lazy fade-in 誤報；low-contrast ×4 為真（.condition-chip small ICD 碼 11px，3.3–4.1:1）。live server 已停止。

## Priority Issues
- [P0] 採用時刻看不見、過敏排除無保證 → 推薦欄頂部固定「本次處方」區＋常駐過敏排除列＋toast 復原。/impeccable layout → /impeccable harden
- [P1] Rail 適合瀏覽不適合決策（12 卡/病灶、照片封面、boilerplate 理由、60 個主按鈕）→ 每病灶前 3–4 個可比較密集列＋「看其餘 n 個」；理由降級；採用改次要樣式。/impeccable distill → /impeccable layout
- [P1] 臨床命名可信度（combinations、Miscellaneous衍生物、ATC 碼當類別、buformin/cyproheptadine 標第一線）→ 複方以上層 ATC 命名、補中文類別、對照表請受訪醫師審。/impeccable clarify
- [P2] 無障礙：ICD 對比不足、chip × 22px、rec-open aria-label 覆蓋內容、drugDialog 無名稱、Escape 失焦、篩選無 aria-pressed、aria-live 洪水。/impeccable audit → /impeccable harden
- [P2] 641–860px hero 崩版（h1 擠成 4 行、按鈕直條）；照片失敗封面全空 → ≤860px 堆疊、img-failed 顯示字母。/impeccable adapt

## Persona Red Flags
- Alex：無快捷鍵；每次採用需捲到左欄設頻率；對話框主按鈕在折線下；600ms 偵測使卡片重排。
- Sam：rec-open 只唸「查看 X 詳細資料」；對話框無名稱；選單 Escape 失焦；病灶依據在 title；採用結果只在 toast。
- 林醫師：無「與主治討論」總覽；過敏是否處理要翻已排除；× 移除病灶永久且無提示。

## Minor Observations
- 「已排除 0 個（）」空括號；⋯ 選單向上蓋住藥名；天數預設 3 天（含 metformin）；1280px 螢幕推薦欄僅約 2.5 張卡；AI 注意事項含糊（dextromethorphan 應點名 MAOI／血清素）；對話框照片空白帶。

## Questions to Consider
- 每病灶只採 1–2 個，為何給 12 個？只給 3 個並各自說理由會怎樣？
- 藥品照片在幫醫師決策，還是在讓頁面像 Netflix？是否該留給衛教單？
- 「越用越懂這位醫師」在畫面上哪裡看得到？
