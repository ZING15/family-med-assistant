# Demo 素材

所有內容都是**練習資料**，醫學重點依公開指引整理，**待醫師確認**，非臨床建議。
病例全部是虛構的，不含任何真實病人資料。

---

## 一、學習庫素材

### 1. 圖片（`學習庫-圖片/`）

在學習庫按「新增筆記 → 圖片」上傳，AI 會擷取圖中文字、寫摘要，並自動帶入圖下方的出處。

| 檔案 | 內容 | 建議展示 |
|---|---|---|
| `衛教單-咳嗽.png` | 系統產生的咳嗽衛教單 | 上傳後看 AI 擷取文字、寫摘要與主題 |

另有期刊圖表、一般圖表與健保給付規定的截圖（`期刊圖表-*.png`、`一般圖表-*.png`、`膽固醇藥物給付規定.jpg`）可用來展示「來源自動帶入」。這些圖片的著作權屬於原出處，只放在本機，不放進公開的 repo。

### 2. 文字（複製後貼到「新增筆記 → 文字」）

**文字 1：急性腹瀉什麼時候要給抗生素**

```text
急性腹瀉抗生素使用時機（學長討論後整理）
- 大多數急性感染性腹瀉會自己好，第一步是補充水分與電解質，優先用口服電解質液（ORS）
- 不建議常規給經驗性抗生素
- 可以考慮經驗性抗生素的情況：發燒合併血便、看起來病很重或疑似敗血症、免疫功能低下
- 血便但沒有發燒時，要想到產志賀毒素大腸桿菌（STEC），這時給抗生素可能增加溶血性尿毒症候群的風險
- 有發燒或血便時，不要用 loperamide 止瀉
- 回診警訊：尿量明顯變少、精神變差、持續血便、腹痛加劇
參考：IDSA 2017 Clinical Practice Guidelines for the Diagnosis and Management of Infectious Diarrhea
```

**文字 2：流感抗病毒藥給誰**

```text
流感抗病毒藥物使用對象
- 住院、病情嚴重或持續惡化的流感病人：不論發病多久，都應盡快給藥
- 高風險族群：65 歲以上、5 歲以下（尤其 2 歲以下）、孕婦、慢性心肺腎肝疾病、糖尿病、免疫功能低下、肥胖，不論發病多久都建議給藥
- 一般健康成人門診：發病 48 小時內開始效果最好
- 不要因為等快篩結果而延誤高風險病人的治療；快篩陰性也不能完全排除流感
- 常用藥：oseltamivir（口服 5 天）、baloxavir（單次口服）、zanamivir（吸入）
參考：CDC Influenza Antiviral Medications: Summary for Clinicians
```

**文字 3：兩歲以下發燒何時要驗尿**

```text
兒童發燒與泌尿道感染（2–24 個月）
- 發燒沒有明顯來源的 2–24 個月幼兒，要考慮泌尿道感染
- 要做尿液培養時，用導尿或恥骨上穿刺取得檢體；尿袋收集的尿液汙染率高，不適合拿來培養
- 尿液分析有膿尿或細菌尿，加上培養有意義的菌量，才診斷為泌尿道感染
- 第一次發燒型泌尿道感染治療後，安排腎臟超音波
- 衛教家長：之後再發燒要早點就醫驗尿
參考：AAP Clinical Practice Guideline: Urinary Tract Infection（2011，2016 再確認）
```

### 3. 語音（`學習庫-語音/`）

按「新增筆記 → 語音 → 上傳音檔」，Gemini 轉成逐字稿，再由 AI 整理成筆記。

| 檔案 | 長度 | 內容 |
|---|---|---|
| `01_痛風急性發作處理_語音筆記.m4a` | 43 秒 | 急性期用藥選擇、降尿酸藥不要停、尿酸目標 < 6 mg/dL |
| `02_蕁麻疹用藥_語音筆記.m4a` | 38 秒 | 第二代抗組織胺、加量最多四倍、類固醇短期、過敏性休克警訊 |

語音是 macOS 內建的台灣華語語音「美佳」合成的，不是真人錄音。
語音看診的示範音檔在 `學習庫-語音/demo_看診對話_咳嗽發燒.mp3`（4 分 48 秒），對話文字稿在同一資料夾的 `.txt`。

---

## 二、病例文字（照醫師寫法：中英混寫、一行一項）

用法：病歷頁按「新病歷」→ 選病人 →「手動輸入」，再把每一段貼到對應欄位。
貼完會自動偵測問題與症狀，右側出現推薦藥品。

### 病例 A：尿路感染（新病人）

**病人資料**：新病人，年齡 `25`，性別 `女`，過敏：無
**展示重點**：否定句（no fever、no flank pain）不會被當成問題；問題清單只有「尿路感染」

主訴

```text
dysuria, frequency x 2 days
```

現病史

```text
排尿灼熱、頻尿兩天
urgency (+), suprapubic discomfort
no fever, no flank pain
無陰道分泌物異常
LMP 10/01，否認懷孕可能
過去無類似病史
```

身體檢查／檢驗

```text
BT 36.8'C, HR 82, BP 118/72
Abd: soft, mild suprapubic tenderness
CVA knocking (-/-)
U/A: WBC 50-100/HPF, RBC 5-10/HPF, nitrite (+)
```

評估

```text
Acute cystitis, uncomplicated
```

計畫

```text
Empirical oral antibiotics
多喝水，不憋尿
若發燒、腰痛、血尿加劇，盡快回診
症狀未改善則安排 urine culture
```

### 病例 B：高血壓回診（回診病人 練習-002）

**病人資料**：選「回診病人 → 練習-002」，年齡、性別、Penicillin 過敏會自動帶入
**展示重點**：第 2 次就診、過去就診列表、「帶入過去病史到 S」；推薦區自動排除 Penicillin 類

> 貼上後關鍵字會抓到「扁桃腺炎」。這次已經好了，可以在問題清單移除，示範醫師可以自己調整問題清單。

主訴

```text
血壓回診，喉嚨痛已改善
```

現病史

```text
上次 10/12 因扁桃腺炎就診，服藥後喉嚨痛已改善，no fever
HTN 十年，規則服 amlodipine
home BP 138-146/84-90（722 量測）
偶爾早上頭脹
no chest pain, no dyspnea, no ankle edema
```

身體檢查／檢驗

```text
BP 148/88 mmHg, HR 76
Throat: no exudate, tonsils not enlarged
Heart: RRR, no murmur
Lung: bilateral clear breathing sound
```

評估

```text
Essential hypertension, not at target
Tonsillitis, resolved
```

計畫

```text
Adjust antihypertensive regimen
Home BP 722 繼續記錄
低鹽飲食、規律運動
4 weeks follow up，帶血壓紀錄回診
Check lipid profile, Cr, eGFR
```

### 病例 C：急性腸胃炎（新病人）

**病人資料**：新病人，年齡 `32`，性別 `男`，過敏：無
**展示重點**：症狀列（噁心嘔吐、腹絞痛）補上對症用藥；同桌的人也拉肚子不會被誤判成病人的症狀

主訴

```text
watery diarrhea x 1 day
```

現病史

```text
昨晚公司聚餐吃海鮮，半夜開始水瀉 6-7 次
vomiting x 2，腹絞痛，陣發性
同桌 3 人也拉肚子
no bloody stool, no fever
可以喝水，尿量正常
```

身體檢查／檢驗

```text
BT 37.2'C, HR 96, BP 122/76
Abd: soft, hyperactive bowel sound, diffuse mild tenderness, no rebound
Skin turgor: fair
```

評估

```text
Acute gastroenteritis, suspected food-borne
```

計畫

```text
ORS 補充水分
Antiemetic, antispasmodic PRN
清淡飲食
若血便、高燒、尿量變少、精神變差，盡快回診
```

### 病例 D：蕁麻疹（新病人，NSAID 過敏）

**病人資料**：新病人，年齡 `40`，性別 `女`，過敏：點「新增過敏 → NSAIDs」
**展示重點**：過敏排除；否定句（無嘴唇腫、無呼吸困難）

主訴

```text
全身起疹子、很癢 x 1 day
```

現病史

```text
昨天晚餐後開始全身起紅色膨疹，會移動，數小時內消退又冒新的
pruritus (+)
無嘴唇腫、無喉嚨緊、無呼吸困難
no abdominal pain
曾吃 ibuprofen 後臉腫
最近無新藥物
```

身體檢查／檢驗

```text
BT 36.6'C, BP 124/78, HR 84, SpO2 99%
Skin: multiple erythematous wheals on trunk and extremities
No angioedema, no wheezing
```

評估

```text
Acute urticaria
NSAID allergy
```

計畫

```text
2nd generation antihistamine
避免 NSAIDs
記錄可能誘發的食物
若嘴唇腫、呼吸困難、頭暈，立刻掛急診
```

### 病例 E：痛風急性發作（新病人，胃出血病史）

**病人資料**：新病人，年齡 `58`，性別 `男`，過敏：無
**展示重點**：病史風險提醒（胃出血 → 相關藥品卡出現琥珀色提醒，只提醒不排除）

主訴

```text
右腳大拇趾紅腫熱痛 x 1 day
```

現病史

```text
昨晚喝酒後半夜右腳大拇趾突然劇痛、紅腫
「被子碰到都痛」
無外傷
過去兩年痛風發作 2 次，沒有吃降尿酸藥
三年前胃潰瘍出血住院
```

身體檢查／檢驗

```text
BT 37.0'C, BP 138/86, HR 88
Rt 1st MTP joint: swelling, erythema, warmth, tenderness
Other joints: intact
```

評估

```text
Acute gout attack, Rt 1st MTP
History of peptic ulcer bleeding
```

計畫

```text
Colchicine or short-course oral steroid
避免 NSAIDs（GI bleeding history）
發作緩解後評估降尿酸治療，目標 uric acid < 6 mg/dL
少喝酒、少喝含糖飲料
check uric acid, Cr
```

### 病例 F：兒童流感（新病人，家人也發燒）

**病人資料**：新病人，年齡 `7`，性別 `男`，過敏：無
**展示重點**：流行性感冒與症狀列（發燒、流鼻水、肌肉酸痛）的推薦；「哥哥上週發燒」那一行不會算成病人的症狀；完成病歷後產生衛教單，插圖會畫成小男孩

主訴

```text
fever up to 39.2'C since yesterday
```

現病史

```text
昨天下午開始發燒，最高 39.2'C
cough, rhinorrhea, 全身痠痛
哥哥上週發燒、確診 B 型流感
食慾變差，但可以喝水
no dyspnea, no seizure
```

身體檢查／檢驗

```text
BT 38.9'C, HR 118, RR 22, SpO2 98%
Throat: injected, no exudate
Lung: bilateral clear breathing sound
Influenza rapid test: B (+)
```

評估

```text
Influenza B infection
```

計畫

```text
Oseltamivir
Antipyretics PRN
多喝水、多休息、戴口罩，暫停上學
若呼吸喘、嘴唇發紫、意識不清、抽搐，立刻就醫
```

---

## 三、建議的 demo 順序（約 5 分鐘）

1. **學習庫**：上傳 `03_居家血壓722…png` → 看 AI 整理與自動帶入出處 → 搜尋「血壓要量幾次」。
2. **病歷（新病人）**：貼病例 D，加 NSAIDs 過敏 → 看偵測、否定句、過敏排除 → 採用藥品 → 完成病歷。
3. **衛教單**：按「產生衛教單」→ 讀取畫面逐張畫插圖 → 圖卡式衛教單。
4. **病歷（回診病人）**：新病歷 → 回診病人 → 搜「高血壓」選練習-002 → 過敏自動帶入、過去就診、帶入過去病史 → 貼病例 B。

衛教單插圖每張約 25–30 秒，一份 7 張約 3–4 分鐘。現場時間不夠的話，建議**事先產生好**，報告時直接打開。
