---
name: 新手家醫看診助手
description: 新手家醫科醫師的臨床手札：收藏所學、在寫病歷時給出用藥候選、把醫囑變成長輩看得懂的衛教。
colors:
  prescription-ink-blue: "#1f5e8c"
  prescription-ink-deep: "#164a70"
  prescription-ink-wash: "#e6eef5"
  notebook-ink: "#16232c"
  graphite: "#3a4a55"
  pencil-grey: "#6e7a83"
  faded-pencil: "#9aa4ab"
  notebook-paper: "#f5f3ee"
  sheet-white: "#ffffff"
  margin-rule: "#e4dfd5"
  faint-rule: "#eeeae2"
  sage-confirm: "#2f7d6b"
  sage-wash: "#e5f2ee"
  amber-caution: "#93600f"
  amber-wash: "#fbf0dc"
  iodine-red: "#b4432f"
typography:
  display:
    fontFamily: "Noto Serif TC, Songti TC, serif"
    fontSize: "clamp(30px, 3.4vw, 44px)"
    fontWeight: 700
    lineHeight: 1.22
    letterSpacing: "0.01em"
  headline:
    fontFamily: "Noto Serif TC, Songti TC, serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.3
  title:
    fontFamily: "Noto Serif TC, Songti TC, serif"
    fontSize: "19px"
    fontWeight: 700
    lineHeight: 1.35
  body:
    fontFamily: "Inter, Noto Sans TC, PingFang TC, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  body-small:
    fontFamily: "Inter, Noto Sans TC, PingFang TC, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Inter, Noto Sans TC, PingFang TC, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    letterSpacing: "0.14em"
rounded:
  sm: "10px"
  md: "16px"
  dialog: "22px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "10px"
  md: "16px"
  lg: "20px"
  xl: "28px"
  section: "56px"
components:
  button-primary:
    backgroundColor: "{colors.notebook-ink}"
    textColor: "{colors.sheet-white}"
    rounded: "{rounded.pill}"
    padding: "11px 20px"
  button-primary-hover:
    backgroundColor: "#24343f"
  button-secondary:
    backgroundColor: "{colors.sheet-white}"
    textColor: "{colors.notebook-ink}"
    rounded: "{rounded.pill}"
    padding: "10px 18px"
  button-link:
    textColor: "{colors.prescription-ink-blue}"
    rounded: "{rounded.pill}"
    padding: "4px 8px"
  input-field:
    backgroundColor: "#fdfcfa"
    textColor: "{colors.notebook-ink}"
    rounded: "{rounded.sm}"
    padding: "11px 13px"
  card:
    backgroundColor: "{colors.sheet-white}"
    rounded: "{rounded.md}"
  chip-topic:
    backgroundColor: "{colors.sheet-white}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.pill}"
    padding: "8px 14px"
  chip-topic-active:
    backgroundColor: "{colors.notebook-ink}"
    textColor: "{colors.sheet-white}"
  chip-allergy:
    backgroundColor: "#fbe9e5"
    textColor: "{colors.iodine-red}"
    rounded: "{rounded.pill}"
    padding: "4px 6px 4px 12px"
---

# Design System: 新手家醫看診助手

## Overview

**Creative North Star: "The Clinical Notebook"（臨床手札）**

這套介面是一本醫師自己的臨床手札：米白紙頁、墨色字跡、襯線體寫下的標題，像資深學長借你翻的那本筆記。它沉穩、溫和、專業。可靠，但不冷漠；安靜，但每一頁都有內容。資訊密度適中，讓醫師在看診空檔的幾分鐘內就能找到東西、做出決定，再回到病人身上。

色彩被刻意壓低：紙、墨、鉛筆灰構成九成畫面，只有「處方簽藍」標記可以點的東西與目前的位置。真正有顏色的是內容本身：每個臨床主題由名稱算出一個固定色相，像在手札頁緣貼上的彩色索引貼，讓「蟲咬的問題」在索引、卡片、主題頁上永遠是同一個顏色。

元件手感是**柔軟而親切**：膠囊形按鈕、大圓角卡片、溫暖的紙白輸入框。深度追求**有層次的立體感**：紙頁疊在紙頁上，每一層看得出前後。（目前實作的卡片在靜止時幾乎是平的，見 Elevation & Depth 的方向說明。）

**Key Characteristics:**
- 紙感暖白底（notebook-paper）與墨色字，不用純黑、不用純灰
- 襯線體只給標題與主題名稱，內文、標籤與數字都用無襯線體
- 單一強調色「處方簽藍」，只用在互動、焦點與目前位置
- 主題色由名稱雜湊而來（色相 0–360，飽和度約 35–40%），是唯一的「彩色」來源
- 膠囊形動作與標籤、16px 圓角卡片、22px 圓角對話框
- 動態只有一種曲線：緩出的 `cubic-bezier(.2, .7, .2, 1)`，以浮起與淡入呈現

## Colors

紙、墨、鉛筆三種中性色撐起畫面，一個處方簽藍負責互動，狀態色只在需要醫師注意時出現。

### Primary
- **Prescription Ink Blue 處方簽藍**（#1f5e8c）：文字連結、「✦ AI 整理」「重新命名」這類連結按鈕、輸入框焦點外框、手機導覽的目前頁、拖放上傳的懸停邊框。像醫師開立處方時的簽名墨水：出現就代表「這裡可以動作」。
- **Prescription Ink Deep 深處方簽藍**（#164a70）：處方簽藍底上的文字，例如「新主題」標籤。
- **Prescription Ink Wash 處方簽淡藍**（#e6eef5）：焦點光暈（4px）、連結按鈕懸停底、上傳區懸停底。

### Neutral
- **Notebook Ink 手札墨**（#16232c）：主要文字、主要按鈕底色、選中的主題標籤底色、品牌方塊。帶一點藍綠的墨色，比純黑溫和。
- **Graphite 石墨**（#3a4a55）：次要文字、表單標籤、標籤文字。
- **Pencil Grey 鉛筆灰**（#6e7a83）：說明文字、計數、摘要、eyebrow。
- **Faded Pencil 淡鉛筆**（#9aa4ab）：最弱的輔助資訊：日期、圖示、placeholder、計數徽章。
- **Notebook Paper 手札紙**（#f5f3ee）：頁面底色、對話框內的次層底色、分段控制底。
- **Sheet White 紙頁白**（#ffffff）：卡片、對話框、輸入框聚焦時的底色。
- **Margin Rule 頁緣線**（#e4dfd5）：卡片邊框、輸入框邊框、區塊分隔線。
- **Faint Rule 淡格線**（#eeeae2）：卡片內部的分隔線、表格列線。

### Status
- **Sage Confirm 鼠尾草綠**（#2f7d6b）＋ **Sage Wash**（#e5f2ee）：AI 已連線、AI 整理完成、已採用、沿用現有主題。
- **Amber Caution 琥珀**（#93600f）＋ **Amber Wash**（#fbf0dc）：示範模式、「AI 產生，待醫師確認」、需要醫師補選的頻率、同類藥警示。
- **Iodine Red 優碘紅**（#b4432f）：錄音鍵、刪除、過敏標籤、「此病灶不再推薦」。過敏標籤底色為 #fbe9e5。

### Topic Hues
主題色不是固定色票，而是由主題名稱雜湊出的色相 `--hue`，以固定的低飽和公式套用：圓點 `hsl(hue 40% 52%)`、淡底 `hsl(hue 35% 94%)`、漸層封面 `hsl(hue 38% 93%) → hsl(hue 30% 86%)`、深色文字 `hsl(hue 30–35% 22–28%)`。

### Named Rules
**The Ink-Only-Where-You-Act Rule.** 處方簽藍只出現在可以點、正在聚焦或代表「你在這裡」的地方。它不拿來裝飾標題、圖示或背景。

**The Content-Carries-Color Rule.** 畫面上唯一的「彩色」來自內容（主題色、TFDA 藥品外觀照片、醫師上傳的圖表）。介面框架本身維持紙、墨、鉛筆三色。

**The Status-Means-Attention Rule.** 綠、琥珀、紅只用來傳達狀態（完成、待確認、危險或過敏），不可當作品牌色或裝飾使用。

## Typography

**Display Font:** Noto Serif TC（備援 Songti TC, serif）
**Body Font:** Inter 搭配 Noto Sans TC（備援 PingFang TC, system-ui）

**Character:** 襯線標題帶來手寫筆記與醫學書籍的份量；Inter 與思源黑體負責所有要快速掃讀的資訊，英文藥名、數字與中文並排時都清楚。

### Hierarchy
- **Display**（700，clamp(30px, 3.4vw, 44px)，1.22）：每頁開頭的大標，例如「把學到的，整理成自己的臨床知識」。一頁只有一個。
- **Headline**（700，24px，1.3）：對話框標題、搜尋結果標題、「推薦藥品」欄標題；主題頁大標放大到 clamp(28px, 3vw, 38px)。
- **Title**（700，19–22px，1.35）：書架與推薦列的標題（「因為 咳嗽」）、主題卡名稱、病歷卡片標題（18px）。
- **Body**（400，15px，1.55）：預設內文、表單輸入、卡片標題（以 600 字重呈現）。
- **Body Small**（400，13px，1.6）：卡片摘要、說明、提示、表格。全站最常見的字級。
- **Label**（600，12px，letter-spacing 0.14em）：eyebrow（「學習庫」「主題」）與區塊小標；計數與日期用 12px、400 字重、等寬數字。

### Named Rules
**The Serif-Is-For-Names Rule.** 襯線體只給「名字」：頁面標題、主題名稱、書架標題、引文封面。按鈕、表單、數字、藥名一律用無襯線體。

**The Tabular-Numbers Rule.** 計數、日期、計時器與 ICD-10 碼使用 `font-variant-numeric: tabular-nums`，讓數字對齊不跳動。

## Layout

- **外框**：左側固定側邊欄 232px（≤860px 收成 76px 圖示欄；≤640px 變成底部導覽列並留出 safe-area），右側內容最大寬度 1280px，桌面邊距 56px、平板 28px、手機 16px。
- **學習庫**：236px 主題索引（sticky）＋ 內容區，間距 48px；≤1080px 時索引改為可橫向捲動的膠囊列。卡片網格 `auto-fill, minmax(232px, 1fr)`，間距 20px；「最近新增」固定為一排 4 張（1081–1240px 為 3 張、手機 2 張）。
- **病歷與開藥**：左右兩欄 5:7（左欄最小 380px），間距 32px；右側推薦欄 sticky 並可獨立捲動；≤1180px 改為上下排列。推薦列為橫向捲動的軌道，卡片寬 196px（手機 168px），間距 14px，附 scroll-snap。
- **節奏**：元件內部常用 6／8／10／12px，卡片內距 16–22px，區塊之間 28–56px。
- **斷點**：640px、860px、1080px、1180px、1240px。

**The Grid-Must-Shrink Rule.** 任何包含橫向捲動內容的格線欄位都用 `minmax(0, 1fr)`，避免整頁在手機上被撐寬。

## Elevation & Depth

**目前實作**：紙張平放。卡片與面板靜止時只有 1px 的極淡陰影，懸停時上浮 3–4px 並出現柔和的環境陰影；對話框、彈出選單與 toast 使用最明顯的陰影。深度主要靠「紙頁白疊在手札紙上」的明度差，加上頁緣線。

**確立的方向**：**有層次的立體感**。紙頁疊在紙頁上，每一層靜止時就看得出前後，而不是等懸停才浮現：頁面底（手札紙）→ 區塊卡片（略浮起）→ 卡片內的元素（貼平）→ 彈出層（明顯浮起）。下一次打磨應把卡片的靜止陰影從 `shadow-sm` 提升到一個介於現有兩者之間的層級，並保留懸停時再上浮一層的回饋。

### Shadow Vocabulary
- **Resting Sheet**（`box-shadow: 0 1px 2px rgba(22, 35, 44, .05)`）：卡片、病歷面板、搜尋列的靜止狀態。
- **Lifted Sheet**（`box-shadow: 0 1px 2px rgba(22, 35, 44, .04), 0 12px 32px -12px rgba(22, 35, 44, .18)`）：卡片懸停、主要「新增」按鈕、彈出選單、toast。
- **Floating Page**（`box-shadow: 0 40px 100px -20px rgba(22, 35, 44, .45)`）：對話框；背後加 3px 模糊的墨色遮罩。
- **Focus Halo**（`box-shadow: 0 0 0 4px #e6eef5`）：輸入框與搜尋列聚焦。
- **Adopted Ring**（`box-shadow: 0 0 0 3px #e5f2ee`）：已採用的推薦藥卡。

### Named Rules
**The Stacked-Sheets Rule.** 深度表達「哪張紙在上面」。同一層的元素陰影一致；只有在上一層的東西（彈出層、對話框）才能比下面的東西更浮。

## Shapes

形狀語言柔軟而親切：沒有直角。
- **膠囊**（999px）：所有按鈕、主題標籤、篩選分段控制、狀態徽章、病灶與過敏標籤、搜尋列。
- **大圓角**（16px）：卡片、病歷面板、推薦藥卡、上傳區、空狀態框。
- **小圓角**（10px）：輸入框、文字區、預覽圖、提示列；縮圖與選單項目 8–12px。
- **對話框**（22px）；手機上改為底部滑出的面板，只有上方兩角為 22px。
- **邊框**：1px 頁緣線為預設；虛線（1.5px dashed #d3cbbd 或 1px dashed #d6cfc1）專門表示「可以放東西進來」的空位或新增動作。

## Components

### Buttons
柔軟、確定，按下去讓人放心。
- **Shape：** 膠囊（999px）。
- **Primary：** 手札墨底、白字、600 字重 14px，內距 11px 20px；主要新增動作（新增筆記、新病歷）加大為 13px 22px 並帶 Lifted Sheet 陰影。
- **Hover / Active：** 懸停時底色略亮（#24343f）；按下縮放 0.98；停用為 #b9c0c5。
- **Secondary：** 紙頁白底、頁緣線框、墨色字；懸停時框線加深。
- **Link button：** 無底、處方簽藍字 13px；懸停出現處方簽淡藍底。
- **Danger：** 白底、淡紅框、優碘紅字，只用於刪除。

### Chips
- **Topic chip（主題索引）：** 桌面為清單列（10px 圓角、色點＋名稱＋計數）；選中時變成紙頁白底加頁緣線。手機為膠囊，選中時反轉為墨底白字。
- **Condition chip（病灶）：** 主題淡底＋主題深色字，附 ICD-10 小字與來源徽章（關鍵字／AI／手動），右側 × 可移除。
- **Allergy chip（過敏）：** #fbe9e5 底、優碘紅字。
- **Dashed add chip：** 虛線膠囊表示「新增」；選中後轉為實線並套用對應狀態色。

### Cards / Containers
- **Corner Style：** 16px。
- **Background：** 紙頁白，放在手札紙上。
- **Shadow Strategy：** Resting Sheet，懸停上浮 3–4px 並轉為 Lifted Sheet（見 Elevation 的方向說明）。
- **Border：** 1px 頁緣線，懸停時加深為 #d9d2c5。
- **Internal Padding：** 16–22px。

### Inputs / Fields
- **Style：** #fdfcfa 暖白底、1px 頁緣線、10px 圓角、14px 字。
- **Focus：** 邊框轉為 #b9cad8、底色轉純白，外加 4px 處方簽淡藍光暈。
- **Search bar：** 膠囊形，左側放大鏡、右側搜尋模式選單與主要按鈕。

### Navigation
- **Desktop：** 側邊欄項目 14px／500 字重，左側淡色圖示；目前頁為紙頁白底加頁緣線與 Resting Sheet，圖示轉為處方簽藍。
- **Mobile：** 底部導覽列，半透明手札紙加 12px 背景模糊；目前頁只以處方簽藍文字與圖示標示，不加底色。

### Note Card（學習庫筆記卡，signature）
4:3 封面在上：圖片筆記用圖片（靠上裁切），文字筆記用主題淡底加襯線體引文，語音筆記用主題色波形條。左下角有半透明膠囊標示類型；下方依序是主題色點、600 字重標題、兩行摘要、以淡格線隔開的來源與日期。

### Topic Tile（主題卡，signature）
140px 主題色漸層封面，疊放最多三張該主題的圖片（輕微旋轉，像手札裡夾的照片）；沒有圖片時顯示主題名稱的第一個字，以大號襯線體呈現。下方為襯線主題名、三則筆記標題（破折號開頭）、類型計數與更新時間。

### Recommendation Rail（推薦藥卡軌道，signature）
每個病灶一排，標題為「因為　＋襯線病灶名」，前方有主題色點。藥卡 196px：118px 主題色漸層封面放 TFDA 外觀照片（multiply 混合去掉白底），沒有照片時顯示藥名首字；下方為藥名、藥理分類、一個推薦理由徽章與可能的琥珀色警示；底部是墨色膠囊「採用」與「⋯」選單。已採用的卡片外圍加一圈鼠尾草綠光環。

## Do's and Don'ts

### Do:
- **Do** 讓手札紙（#f5f3ee）當頁面底、紙頁白（#ffffff）當卡片，用明度差而不是大量邊框區分層級。
- **Do** 把處方簽藍（#1f5e8c）留給連結、焦點與目前位置。
- **Do** 用名稱雜湊出的 `--hue` 為主題上色，並在索引、卡片、主題頁、病灶標籤保持一致。
- **Do** 標題與主題名稱用 Noto Serif TC；資料、按鈕、藥名用 Inter／Noto Sans TC。
- **Do** 所有動作與標籤使用膠囊形，卡片 16px、輸入框 10px、對話框 22px。
- **Do** 用同一條緩出曲線 `cubic-bezier(.2, .7, .2, 1)` 做浮起與淡入，並遵守 `prefers-reduced-motion`。
- **Do** 在 AI 產生的內容旁放上琥珀色「AI 產生，待醫師確認」標籤。
- **Do** 外部圖片（TFDA 外觀圖）載入完成後再淡入。

### Don't:
- **Don't** 使用純黑 #000 或冷灰；文字最深就是手札墨 #16232c。
- **Don't** 把綠、琥珀、紅當裝飾色或品牌色。
- **Don't** 在介面框架上加入第二個強調色；彩色只能來自內容。
- **Don't** 用直角或小於 8px 的圓角。
- **Don't** 在內文、按鈕、表單或數字上使用襯線體。
- **Don't** 讓含橫向捲動的格線欄位使用 `1fr`（請用 `minmax(0, 1fr)`）。
