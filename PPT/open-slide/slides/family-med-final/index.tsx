import type { DesignSystem, Page, SlideMeta } from '@open-slide/core';
import { ImagePlaceholder, useSlidePageNumber } from '@open-slide/core';
import type { CSSProperties, ReactNode } from 'react';

// 視覺沿用 App 的設計系統「臨床手札」（見專案根目錄 DESIGN.md）
export const design: DesignSystem = {
  palette: { bg: '#f5f3ee', text: '#16232c', accent: '#1f5e8c' },
  fonts: {
    display: '"Noto Serif TC", "Songti TC", serif',
    body: '"PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif',
  },
  typeScale: { hero: 150, body: 34 },
  radius: 16,
};

const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@700&display=swap';
const FONT_LINK_ID = 'osd-webfont-family-med-final';
if (typeof document !== 'undefined') {
  let link = document.getElementById(FONT_LINK_ID) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.id = FONT_LINK_ID;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  if (link.href !== FONT_HREF) link.href = FONT_HREF;
}

// 設計系統以外的顏色
const graphite = '#3a4a55';
const pencil = '#5f6b74';
const rule = '#e4dfd5';
const white = '#ffffff';
const inkWash = '#e6eef5';
const inkDeep = '#164a70';
const sage = '#2a7262';
const sageWash = '#e5f2ee';
const amber = '#93600f';
const amberWash = '#fbf0dc';
const iodine = '#b4432f';

const PAD_X = 140;

const fill: CSSProperties = {
  width: '100%',
  height: '100%',
  position: 'relative',
  background: 'var(--osd-bg)',
  color: 'var(--osd-text)',
  fontFamily: 'var(--osd-font-body)',
  boxSizing: 'border-box',
};

const serif: CSSProperties = { fontFamily: 'var(--osd-font-display)', fontWeight: 700 };

/* ---------- 共用元件 ---------- */

const Footer = () => {
  const { current, total } = useSlidePageNumber();
  return (
    <div
      style={{
        position: 'absolute',
        left: PAD_X,
        right: PAD_X,
        bottom: 44,
        display: 'flex',
        justifyContent: 'space-between',
        fontSize: 22,
        color: pencil,
        borderTop: `1px solid ${rule}`,
        paddingTop: 16,
      }}
    >
      <span>新手家醫看診助手 · 練習資料，非臨床建議</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>
        {String(current).padStart(2, '0')} / {String(total).padStart(2, '0')}
      </span>
    </div>
  );
};

const Frame = ({ children }: { children: ReactNode }) => (
  <div style={{ ...fill, padding: `100px ${PAD_X}px 0` }}>
    {children}
    <Footer />
  </div>
);

const Eyebrow = ({ children, color = 'var(--osd-accent)' }: { children: ReactNode; color?: string }) => (
  <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: '0.16em', color }}>{children}</div>
);

const Heading = ({ eyebrow, children }: { eyebrow: string; children: ReactNode }) => (
  <div style={{ marginBottom: 56 }}>
    <Eyebrow>{eyebrow}</Eyebrow>
    <h2 style={{ ...serif, fontSize: 68, lineHeight: 1.2, margin: '16px 0 0' }}>{children}</h2>
  </div>
);

const ArrowRight = ({ width, label }: { width: number; label?: string }) => (
  <div
    style={{
      width,
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    }}
  >
    {label && <span style={{ fontSize: 22, color: pencil, whiteSpace: 'nowrap' }}>{label}</span>}
    <svg width={width - 16} height={20} viewBox={`0 0 ${width - 16} 20`}>
      <line x1={0} y1={10} x2={width - 30} y2={10} stroke={pencil} strokeWidth={3} />
      <path d={`M${width - 34} 2 L${width - 18} 10 L${width - 34} 18`} fill="none" stroke={pencil} strokeWidth={3} />
    </svg>
  </div>
);

const Pill = ({ children, color, bg }: { children: ReactNode; color: string; bg: string }) => (
  <span
    style={{
      display: 'inline-block',
      fontSize: 22,
      fontWeight: 600,
      color,
      background: bg,
      borderRadius: 999,
      padding: '6px 18px',
      whiteSpace: 'nowrap',
    }}
  >
    {children}
  </span>
);

/* ---------- 01 封面 ---------- */

const Cover: Page = () => (
  <div
    style={{
      ...fill,
      padding: `0 ${PAD_X}px`,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
    }}
  >
    <Eyebrow>個人專題成果發表 · 2026.10.15</Eyebrow>
    <h1
      style={{
        ...serif,
        fontSize: 'var(--osd-size-hero)',
        lineHeight: 1.1,
        margin: '40px 0 0',
        alignSelf: 'flex-start',
        background: `linear-gradient(transparent 68%, ${inkWash} 68%)`,
        padding: '0 12px',
        marginLeft: -12,
      }}
    >
      新手家醫看診助手
    </h1>
    <p style={{ fontSize: 40, lineHeight: 1.5, color: graphite, margin: '48px 0 0' }}>
      收藏所學 · 寫病歷時給出用藥候選 · 把醫囑變成長輩看得懂的衛教
    </p>
    <div style={{ display: 'flex', alignItems: 'center', gap: 32, marginTop: 96 }}>
      <span style={{ fontSize: 30, color: graphite }}>提案人：黃子哲</span>
      <Pill color={amber} bg={amberWash}>
        練習資料，非臨床建議
      </Pill>
    </div>
  </div>
);

/* ---------- 02 專題目的：三個痛點 ---------- */

const ProblemCard = ({ no, title, quote, detail }: { no: string; title: string; quote: string; detail: string }) => (
  <div
    style={{
      flex: 1,
      background: white,
      border: `1px solid ${rule}`,
      borderRadius: 'var(--osd-radius)',
      padding: '40px 40px 44px',
      display: 'flex',
      flexDirection: 'column',
    }}
  >
    <span style={{ ...serif, fontSize: 30, color: iodine }}>{no}</span>
    <h3 style={{ ...serif, fontSize: 42, lineHeight: 1.3, margin: '16px 0 0' }}>{title}</h3>
    <p style={{ fontSize: 30, lineHeight: 1.6, color: graphite, margin: '24px 0 0' }}>{detail}</p>
    <p
      style={{
        fontSize: 28,
        lineHeight: 1.6,
        color: 'var(--osd-accent)',
        margin: 'auto 0 0',
        paddingTop: 28,
        borderTop: `1px dashed ${rule}`,
      }}
    >
      「{quote}」
    </p>
  </div>
);

const Problem: Page = () => (
  <Frame>
    <Heading eyebrow="專題目的">新手家醫的三個卡關時刻</Heading>
    <div style={{ display: 'flex', gap: 40, height: 560 }}>
      <ProblemCard
        no="01"
        title="筆記散落，回找困難"
        detail="期刊圖表存在手機相簿和備忘錄，要用時翻不到。"
        quote="用手機備忘錄，把它記下來"
      />
      <ProblemCard
        no="02"
        title="少見病灶，選藥靠經驗"
        detail="跨科主訴很廣，比較少遇到的問題，不容易想到可用的藥。"
        quote="比較少遇到的話，你就會比較不熟悉"
      />
      <ProblemCard
        no="03"
        title="病人聽不懂醫囑"
        detail="長串醫囑與藥名，長輩很難帶回家照著做。"
        quote="病人聽得懂的話給他聽"
      />
    </div>
    <p style={{ fontSize: 24, color: pencil, margin: '28px 0 0' }}>引言來源：醫師訪談 2 份，共 3 位醫師</p>
  </Frame>
);

/* ---------- 03 定位 ---------- */

const PositionBox = ({ title, sub, strong }: { title: string; sub: string; strong?: boolean }) => (
  <div
    style={{
      flex: 1,
      height: 240,
      borderRadius: 'var(--osd-radius)',
      background: strong ? 'var(--osd-accent)' : white,
      color: strong ? white : 'var(--osd-text)',
      border: strong ? 'none' : `1px solid ${rule}`,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      padding: '0 40px',
    }}
  >
    <div style={{ ...serif, fontSize: 44, lineHeight: 1.3 }}>{title}</div>
    <div style={{ fontSize: 28, lineHeight: 1.5, marginTop: 16, color: strong ? inkWash : pencil }}>{sub}</div>
  </div>
);

const Positioning: Page = () => (
  <Frame>
    <Heading eyebrow="定位">不做另一個醫學問答 AI</Heading>
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <PositionBox title="OpenEvidence" sub="醫師已經在用，查證做得很好" />
      <ArrowRight width={150} label="查到的圖表" />
      <PositionBox title="看診助手" sub="收藏 · 用藥候選 · 衛教" strong />
      <ArrowRight width={150} label="衛教單" />
      <PositionBox title="病人" sub="以長輩為主" />
    </div>
    <p style={{ ...serif, fontSize: 48, lineHeight: 1.4, margin: '88px 0 0' }}>不跟它比查證，而是接在它的下游。</p>
    <p style={{ fontSize: 32, lineHeight: 1.6, color: graphite, margin: '24px 0 0', maxWidth: 1500 }}>
      把醫師自己查到、學到的變成個人知識庫；寫病歷時，依醫師的採用紀錄與過敏資料給出用藥候選。
    </p>
  </Frame>
);

/* ---------- 04 更新說明：構想 → 成品 ---------- */

const MapRow = ({ from, to, tag, tagColor, tagBg }: { from: string; to: string; tag: string; tagColor: string; tagBg: string }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      padding: '20px 0',
      borderBottom: `1px solid ${rule}`,
      fontSize: 32,
      lineHeight: 1.4,
    }}
  >
    <span style={{ width: 440, color: pencil }}>{from}</span>
    <ArrowRight width={90} />
    <span style={{ flex: 1, paddingLeft: 24 }}>{to}</span>
    <span style={{ width: 120, textAlign: 'right' }}>
      <Pill color={tagColor} bg={tagBg}>
        {tag}
      </Pill>
    </span>
  </div>
);

const Changes: Page = () => (
  <Frame>
    <Heading eyebrow="更新說明">從構想到成品：哪些變了</Heading>
    <div style={{ display: 'flex', fontSize: 24, fontWeight: 600, letterSpacing: '0.12em', color: pencil, paddingBottom: 12, borderBottom: `2px solid var(--osd-text)` }}>
      <span style={{ width: 530 }}>9/15 構想圖</span>
      <span style={{ paddingLeft: 24 }}>10/15 成品</span>
    </div>
    <MapRow from="學習成長：整理經驗" to="學習庫：圖片、文字、語音＋AI 整理" tag="保留" tagColor={sage} tagBg={sageWash} />
    <MapRow from="用藥資訊" to="用藥推薦：TFDA＋健保資料、過敏排除" tag="擴充" tagColor="var(--osd-accent)" tagBg={inkWash} />
    <MapRow from="給病人的說明與圖表" to="衛教單＋AI 衛教圖" tag="保留" tagColor={sage} tagBg={sageWash} />
    <MapRow from="病歷解讀、問診建議" to="只偵測病灶對應藥理類別，不給診斷" tag="縮小" tagColor={amber} tagBg={amberWash} />
    <MapRow from="連結最新論文" to="交給 OpenEvidence，收藏它的結果" tag="移出" tagColor={iodine} tagBg="#f6e4df" />
  </Frame>
);

/* ---------- 05 使用情境 ---------- */

const Lane = ({ when, title, a, b, c }: { when: string; title: string; a: string; b: string; c: string }) => (
  <div
    style={{
      flex: 1,
      background: white,
      border: `1px solid ${rule}`,
      borderRadius: 'var(--osd-radius)',
      padding: '36px 40px',
    }}
  >
    <Pill color="var(--osd-accent)" bg={inkWash}>
      {when}
    </Pill>
    <h3 style={{ ...serif, fontSize: 46, lineHeight: 1.3, margin: '24px 0 28px' }}>{title}</h3>
    <ol style={{ fontSize: 30, lineHeight: 1.6, color: graphite, margin: 0, paddingLeft: 36 }}>
      <li>{a}</li>
      <li>{b}</li>
      <li>{c}</li>
    </ol>
  </div>
);

const Scenario: Page = () => (
  <Frame>
    <Heading eyebrow="使用情境">一位新手醫師的三個時刻</Heading>
    <div style={{ display: 'flex', gap: 40 }}>
      <Lane when="通勤・空檔" title="學習庫" a="截圖或錄音存起來" b="AI 整理標題與主題" c="用一句話找回來" />
      <Lane when="看診中" title="病歷與開藥" a="輸入主訴與評估" b="列出可考慮的藥" c="醫師挑選、採用" />
      <Lane when="看診後" title="衛教單" a="AI 寫白話草稿" b="醫師修改並確認" c="交給病人帶回家" />
    </div>
    <div
      style={{
        marginTop: 40,
        padding: '24px 36px',
        borderRadius: 'var(--osd-radius)',
        background: sageWash,
        color: sage,
        fontSize: 30,
        lineHeight: 1.5,
      }}
    >
      ↺ 藥品卡與衛教單可一鍵存回學習庫；採用與排除紀錄回饋到下次推薦
    </div>
  </Frame>
);

/* ---------- 06 功能：學習庫 ---------- */

const Stage = ({ step, title, children }: { step: string; title: string; children: ReactNode }) => (
  <div
    style={{
      flex: 1,
      height: 470,
      background: white,
      border: `1px solid ${rule}`,
      borderRadius: 'var(--osd-radius)',
      padding: '36px 36px',
      boxSizing: 'border-box',
    }}
  >
    <Eyebrow color={pencil}>{step}</Eyebrow>
    <h3 style={{ ...serif, fontSize: 42, lineHeight: 1.3, margin: '12px 0 28px' }}>{title}</h3>
    {children}
  </div>
);

const InputChip = ({ kind, desc }: { kind: string; desc: string }) => (
  <div style={{ display: 'flex', alignItems: 'baseline', gap: 20, padding: '16px 0', borderTop: `1px solid ${rule}` }}>
    <span style={{ ...serif, fontSize: 32, color: 'var(--osd-accent)', width: 72 }}>{kind}</span>
    <span style={{ fontSize: 28, color: graphite }}>{desc}</span>
  </div>
);

const Library: Page = () => (
  <Frame>
    <Heading eyebrow="功能一 · 學習庫">拍下、寫下、說出來，之後找得回</Heading>
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <Stage step="新增" title="三種方式">
        <InputChip kind="圖片" desc="期刊圖表、截圖" />
        <InputChip kind="文字" desc="自己寫的重點" />
        <InputChip kind="語音" desc="通勤時錄一段" />
      </Stage>
      <ArrowRight width={80} />
      <Stage step="AI 整理" title="醫師確認後儲存">
        <ul style={{ fontSize: 30, lineHeight: 1.6, color: graphite, margin: 0, paddingLeft: 32 }}>
          <li>擷取圖中文字</li>
          <li>語音轉逐字稿</li>
          <li>建議標題、主題、標籤</li>
          <li>帶入期刊、年份、DOI</li>
        </ul>
      </Stage>
      <ArrowRight width={80} />
      <Stage step="回找" title="依臨床問題分類">
        <p style={{ fontSize: 30, lineHeight: 1.6, color: graphite, margin: 0 }}>例：咳嗽的處置、蟲咬的問題</p>
        <div
          style={{
            marginTop: 36,
            border: `2px solid var(--osd-accent)`,
            borderRadius: 999,
            padding: '14px 28px',
            fontSize: 28,
            color: 'var(--osd-text)',
          }}
        >
          🔍 胃出血嚴重度評估
        </div>
        <p style={{ fontSize: 24, color: pencil, margin: '16px 0 0 8px' }}>語意搜尋：不用記得原本的關鍵字</p>
      </Stage>
    </div>
    <p style={{ fontSize: 28, color: amber, margin: '32px 0 0' }}>看不到來源就留空，不杜撰；AI 失敗時仍可手動完成。</p>
  </Frame>
);

/* ---------- 07 功能：用藥推薦 ---------- */

const FlowStep = ({ step, title, desc }: { step: string; title: string; desc: string }) => (
  <div
    style={{
      flex: 1,
      height: 270,
      background: white,
      border: `1px solid ${rule}`,
      borderRadius: 'var(--osd-radius)',
      padding: '32px 32px',
      boxSizing: 'border-box',
    }}
  >
    <Eyebrow color={pencil}>{step}</Eyebrow>
    <h3 style={{ ...serif, fontSize: 38, lineHeight: 1.3, margin: '12px 0 16px' }}>{title}</h3>
    <p style={{ fontSize: 28, lineHeight: 1.5, color: graphite, margin: 0 }}>{desc}</p>
  </div>
);

const Stat = ({ value, label }: { value: string; label: string }) => (
  <div style={{ flex: 1, borderTop: `2px solid var(--osd-text)`, paddingTop: 24 }}>
    <div style={{ ...serif, fontSize: 76, lineHeight: 1.1, color: 'var(--osd-accent)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    <div style={{ fontSize: 28, lineHeight: 1.5, color: graphite, marginTop: 12 }}>{label}</div>
  </div>
);

const Recommend: Page = () => (
  <Frame>
    <Heading eyebrow="功能二 · 用藥推薦">寫病歷的當下，列出可以考慮的藥</Heading>
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <FlowStep step="1" title="寫病歷" desc="輸入主訴與評估" />
      <ArrowRight width={56} />
      <FlowStep step="2" title="偵測病灶" desc="27 個常見家醫問題；關鍵字為主、AI 為輔" />
      <ArrowRight width={56} />
      <FlowStep step="3" title="對應藥理類別" desc="ATC 分類；排除過敏與「不再推薦」" />
      <ArrowRight width={56} />
      <FlowStep step="4" title="醫師採用" desc="按下「採用」才寫入開藥區" />
    </div>
    <div style={{ display: 'flex', gap: 64, marginTop: 64 }}>
      <Stat value="22,501" label="有效 TFDA 藥品許可證" />
      <Stat value="13,833" label="健保給付品項（10/01 資料）" />
      <Stat value="14 類" label="過敏原 → 排除對應藥理類別" />
    </div>
  </Frame>
);

/* ---------- 08 功能：衛教單 ---------- */

const NumberedStep = ({ no, children }: { no: string; children: ReactNode }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 28, marginBottom: 32 }}>
    <span
      style={{
        ...serif,
        width: 60,
        height: 60,
        flexShrink: 0,
        borderRadius: 999,
        background: 'var(--osd-accent)',
        color: white,
        fontSize: 30,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {no}
    </span>
    <span style={{ fontSize: 34, lineHeight: 1.4 }}>{children}</span>
  </div>
);

const Education: Page = () => (
  <Frame>
    <Heading eyebrow="功能三 · 衛教單">把醫囑變成長輩看得懂的衛教單</Heading>
    <div style={{ display: 'flex', gap: 80 }}>
      <div style={{ width: 760, flexShrink: 0 }}>
        <NumberedStep no="1">從病歷帶入病灶與本次處方</NumberedStep>
        <NumberedStep no="2">AI 產生白話草稿與一張衛教圖</NumberedStep>
        <NumberedStep no="3">醫師直接修改，勾選「已確認」</NumberedStep>
        <NumberedStep no="4">下載圖片，或存回學習庫</NumberedStep>
        <div
          style={{
            marginTop: 24,
            padding: '24px 32px',
            borderRadius: 'var(--osd-radius)',
            background: amberWash,
            color: amber,
            fontSize: 28,
            lineHeight: 1.55,
          }}
        >
          AI 不寫劑量、不改頻率與天數；衛教圖不含文字，也不畫藥品外觀。
        </div>
      </div>
      <ImagePlaceholder hint="衛教單畫面截圖（含 AI 衛教圖）" width={800} height={560} />
    </div>
  </Frame>
);

/* ---------- 09 DEMO ---------- */

const DemoStep = ({ no, title, path }: { no: string; title: string; path: string }) => (
  <div style={{ display: 'flex', alignItems: 'baseline', gap: 32, padding: '22px 0', borderTop: `1px solid ${rule}` }}>
    <span style={{ ...serif, fontSize: 36, color: iodine, width: 48 }}>{no}</span>
    <span style={{ ...serif, fontSize: 40, width: 260 }}>{title}</span>
    <span style={{ fontSize: 32, color: graphite }}>{path}</span>
  </div>
);

const Demo: Page = () => (
  <Frame>
    <Eyebrow>DEMO</Eyebrow>
    <h2 style={{ ...serif, fontSize: 130, lineHeight: 1.1, margin: '24px 0 64px' }}>現場操作</h2>
    <DemoStep no="1" title="學習庫" path="上傳期刊圖表 → AI 整理 → 用一句話搜尋" />
    <DemoStep no="2" title="病歷與開藥" path="示範病歷 → 推薦藥品 → 採用、過敏排除" />
    <DemoStep no="3" title="衛教單" path="產生草稿與衛教圖 → 醫師確認 → 下載" />
    <p style={{ fontSize: 24, color: pencil, margin: '28px 0 0' }}>示範病歷皆為練習假資料</p>
  </Frame>
);

/* ---------- 10 AI 運用 ---------- */

const AiRow = ({ use, model, when, head }: { use: string; model: string; when: string; head?: boolean }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      padding: head ? '0 0 12px' : '15px 0',
      borderBottom: head ? `2px solid var(--osd-text)` : `1px solid ${rule}`,
      fontSize: head ? 24 : 30,
      fontWeight: head ? 600 : 400,
      letterSpacing: head ? '0.12em' : 0,
      color: head ? pencil : 'var(--osd-text)',
      lineHeight: 1.4,
    }}
  >
    <span style={{ width: 560 }}>{use}</span>
    <span style={{ width: 560, color: head ? pencil : 'var(--osd-accent)' }}>{model}</span>
    <span style={{ flex: 1, color: head ? pencil : graphite }}>{when}</span>
  </div>
);

const AiUsage: Page = () => (
  <Frame>
    <Heading eyebrow="AI 運用">AI 用在哪裡，又怎麼省</Heading>
    <AiRow head use="用途" model="模型（Azure）" when="呼叫時機" />
    <AiRow use="學習庫：圖片辨識、建議標題" model="gpt-4o-mini" when="上傳時一次" />
    <AiRow use="學習庫：語音轉逐字稿" model="Azure Speech · MAI-Transcribe-2" when="錄音時一次" />
    <AiRow use="學習庫：語意搜尋" model="text-embedding-3-small" when="儲存時算一次" />
    <AiRow use="病歷：病灶擷取" model="gpt-4o-mini（JSON 輸出）" when="關鍵字找不到才呼叫" />
    <AiRow use="藥品卡：白話簡介" model="gpt-4o-mini" when="每種成分只產生一次" />
    <AiRow use="衛教單：文字＋衛教圖" model="gpt-4o-mini · MAI-Image-2.6" when="醫師按下時，結果快取" />
    <p style={{ fontSize: 26, color: pencil, margin: '24px 0 0' }}>
      AI 產出一律標示「AI 產生，待醫師確認」；沒設定金鑰時以示範模式運作。
    </p>
  </Frame>
);

/* ---------- 11 系統架構與部署 ---------- */

const ArchBox = ({
  x,
  y,
  w,
  h,
  title,
  children,
  dashed,
  strong,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  children: ReactNode;
  dashed?: boolean;
  strong?: boolean;
}) => (
  <div
    style={{
      position: 'absolute',
      left: x,
      top: y,
      width: w,
      height: h,
      boxSizing: 'border-box',
      background: strong ? inkWash : dashed ? 'transparent' : white,
      border: dashed ? `2px dashed ${pencil}` : `1px solid ${strong ? 'var(--osd-accent)' : rule}`,
      borderRadius: 'var(--osd-radius)',
      padding: '24px 30px',
    }}
  >
    <div style={{ ...serif, fontSize: 32, lineHeight: 1.3, color: strong ? inkDeep : 'var(--osd-text)' }}>{title}</div>
    <div style={{ fontSize: 24, lineHeight: 1.55, color: graphite, marginTop: 10 }}>{children}</div>
  </div>
);

const Architecture: Page = () => (
  <Frame>
    <Heading eyebrow="解決方案與部署">系統架構：目前本機展示</Heading>
    {/* 連線：座標以內容區左上角為原點 */}
    <div style={{ position: 'relative', width: 1640, height: 600 }}>
      <svg width={1640} height={600} style={{ position: 'absolute', inset: 0 }}>
        <defs>
          <marker id="fm-arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto">
            <path d="M0 0 L10 5 L0 10 z" fill={pencil} />
          </marker>
        </defs>
        {/* 瀏覽器 ⇄ 後端 */}
        <line x1={380} y1={120} x2={512} y2={120} stroke={pencil} strokeWidth={3} markerEnd="url(#fm-arrow)" />
        <line x1={520} y1={150} x2={388} y2={150} stroke={pencil} strokeWidth={3} markerEnd="url(#fm-arrow)" />
        {/* 後端 → Azure AI */}
        <line x1={1060} y1={135} x2={1172} y2={135} stroke={pencil} strokeWidth={3} markerEnd="url(#fm-arrow)" />
        {/* 後端 ⇄ SQLite */}
        <line x1={790} y1={270} x2={790} y2={352} stroke={pencil} strokeWidth={3} markerEnd="url(#fm-arrow)" />
        {/* 開放資料 → SQLite */}
        <line x1={380} y1={450} x2={512} y2={450} stroke={pencil} strokeWidth={3} markerEnd="url(#fm-arrow)" />
      </svg>
      <span style={{ position: 'absolute', left: 404, top: 74, fontSize: 22, color: pencil }}>HTTP</span>
      <span style={{ position: 'absolute', left: 1078, top: 92, fontSize: 22, color: pencil }}>API</span>
      <span style={{ position: 'absolute', left: 392, top: 404, fontSize: 22, color: pencil }}>建置腳本</span>

      <ArchBox x={0} y={30} w={380} h={220} title="醫師的瀏覽器">
        原生 HTML · CSS · JS
        <br />
        桌機與手機皆可用
      </ArchBox>
      <ArchBox x={520} y={0} w={540} h={270} title="FastAPI 後端" strong>
        Python 3.13 · Uvicorn
        <br />
        學習庫 · 病歷與開藥 · 衛教單
        <br />
        推薦排序、過敏排除、示範模式
      </ArchBox>
      <ArchBox x={1180} y={0} w={460} h={270} title="Azure AI">
        Azure OpenAI：gpt-4o-mini、
        <br />
        text-embedding-3-small
        <br />
        Speech：MAI-Transcribe-2
        <br />
        生圖：MAI-Image-2.6
      </ArchBox>
      <ArchBox x={0} y={350} w={380} h={220} title="政府開放資料">
        TFDA 許可證、ATC、
        <br />
        AHFS、外觀；健保署
        <br />
        健保用藥品項
      </ArchBox>
      <ArchBox x={520} y={360} w={540} h={210} title="SQLite">
        app.sqlite：學習庫、病歷、回饋
        <br />
        藥品參考表、健保藥品（唯讀）
      </ArchBox>
      <ArchBox x={1180} y={360} w={460} h={210} title="雲端部署（已備妥腳本）" dashed>
        Azure App Service B1
        <br />
        /home/data 持久保存
        <br />
        共用密碼登入
      </ArchBox>
    </div>
  </Frame>
);

/* ---------- 12 下一步 ---------- */

const Closing: Page = () => (
  <Frame>
    <Heading eyebrow="下一步">接下來要做的事</Heading>
    <ul style={{ fontSize: 36, lineHeight: 1.6, margin: 0, paddingLeft: 44, color: graphite }}>
      <li style={{ marginBottom: 24 }}>部署到 Azure，讓受訪醫師用網址直接試用</li>
      <li style={{ marginBottom: 24 }}>補訪：推薦排序時，醫師最在意什麼？</li>
      <li>補訪：衛教單由誰、透過什麼管道交給病人？</li>
    </ul>
    <div
      style={{
        position: 'absolute',
        right: PAD_X,
        bottom: 150,
        textAlign: 'right',
      }}
    >
      <div style={{ ...serif, fontSize: 120, lineHeight: 1.1 }}>謝謝</div>
      <div style={{ fontSize: 30, color: pencil, marginTop: 12 }}>歡迎提問</div>
    </div>
  </Frame>
);

export const meta: SlideMeta = {
  title: '新手家醫看診助手：個專成果發表',
  createdAt: '2026-10-05T16:10:02.390Z',
};

export default [
  Cover,
  Problem,
  Positioning,
  Changes,
  Scenario,
  Library,
  Recommend,
  Education,
  Demo,
  AiUsage,
  Architecture,
  Closing,
] satisfies Page[];

// 講稿：總長 7 分鐘（含 setup），建議簡報約 3 分半、DEMO 約 3 分鐘
export const notes: (string | undefined)[] = [
  `（約 10 秒）
大家好，我的專題是「新手家醫看診助手」，給剛開始看門診的家醫科醫師用的工具。
先提醒：裡面的病例都是練習用的假資料，不是臨床建議。`,
  `（約 25 秒）
我訪談了 3 位醫師，整理出新手家醫最常卡住的三個時刻：
第一，期刊圖表存在手機相簿和備忘錄，要用的時候找不到。
第二，家醫科要看的問題很廣，遇到比較少見的病灶，不容易想到能用哪些藥。
第三，醫囑和藥名太長，長輩病人聽不懂，回家也照不著做。`,
  `（約 20 秒）
訪談中醫師說他們已經在用 OpenEvidence 查證，它做得比我能做的好。
所以我不做另一個醫學問答 AI，而是接在它的下游：
把醫師查到、學到的東西收進個人知識庫；寫病歷時給出用藥候選；最後產生病人看得懂的衛教單。`,
  `（約 20 秒）
跟最初的構想圖比，有幾個調整：
學習庫和衛教保留；用藥資訊擴充成推薦，接上 TFDA 和健保的開放資料；
病歷解讀縮小成只偵測病灶，不給診斷，因為醫師說 AI 的診斷不一定正確、出事也不能拿來當依據；
連結論文就交給 OpenEvidence。`,
  `（約 15 秒）
實際使用分成一天裡的三個時刻：通勤時存資料、看診中開藥、看診後給衛教。
而且三者會串起來：藥品卡、衛教單可以存回學習庫，採用紀錄也會讓下次推薦更貼近這位醫師。`,
  `（約 20 秒）
學習庫可以用圖片、文字或語音新增。
AI 會擷取圖中文字、把語音轉成逐字稿，建議標題、主題和標籤，看得到的期刊名稱和 DOI 也會帶進來；看不到就留空，不會亂編。
之後用一句自然語言就能找回，例如「胃出血嚴重度評估」。`,
  `（約 25 秒）
寫病歷時，系統用關鍵字對照偵測病灶，目前涵蓋 27 個常見家醫問題，找不到才呼叫 AI。
病灶對應到 ATC 藥理類別，再排除病人過敏的類別和醫師標過「不再推薦」的藥。
藥品資料來自 TFDA 和健保署的開放資料。重點是：醫師按下「採用」，才會寫進開藥區。`,
  `（約 20 秒）
看完診，按一下就能從病歷和本次處方產生衛教單草稿和一張衛教圖。
醫師可以直接改字，勾選確認後才能下載或存回學習庫。
安全上，劑量、頻率、天數都由醫師決定，AI 不碰；衛教圖也不畫藥品外觀，避免跟真的藥搞混。`,
  `（約 3 分鐘）
現在直接操作給大家看。
1. 學習庫：上傳一張期刊圖表，看 AI 整理，再用一句話搜尋。
2. 病歷與開藥：打開示範病歷，看推薦、採用一個藥、看過敏被排除。
3. 衛教單：產生草稿和衛教圖，勾選確認，下載。`,
  `（約 20 秒）
AI 的部分都用 Azure：對話用 gpt-4o-mini，語意搜尋用 embedding，語音用 MAI-Transcribe-2，生圖用 MAI-Image-2.6。
為了控制成本，每個 AI 呼叫都只在必要時做一次並快取，例如藥品簡介每種成分只產生一次。`,
  `（約 20 秒）
架構是：瀏覽器打 FastAPI 後端，後端讀寫 SQLite，需要 AI 時呼叫 Azure。
藥品資料先用 Python 腳本把 TFDA 和健保署的開放資料整理成唯讀的資料庫。
目前在本機展示；部署到 Azure App Service 的打包和設定腳本都已經準備好了。`,
  `（約 10 秒）
接下來會部署到 Azure 給受訪醫師試用，並補訪推薦排序和衛教交付的問題。謝謝大家。`,
];
