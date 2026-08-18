# 企業級請假管理系統 — Phase 3 Design System

> 承接 Phase 1（IA/架構）與 Phase 2（16 個核心畫面規格）。本階段輸出可供工程直接落地的
> Design Token、Color Palette、Typography、Icon 規範、Spacing、Grid、Component Library。
> 方法論依循 **Material Design 3**：Token 分三層（Reference → System → Component），
> 色彩以「種子色（Seed Color）→ Tonal Palette → Role 對應」產生，並以 WCAG AA 對比公式驗證。

---

## 1. Design Token 架構

### 1.1 三層式 Token

```
Reference Token（原始色階，不可直接用在畫面）
    └─ 例：--ref-primary-40: #251DAF;
System Token（語意角色，Light/Dark 各一套，畫面應優先使用這層）
    └─ 例：--sys-color-primary: var(--ref-primary-40);   /* light */
    └─ 例：--sys-color-primary: var(--ref-primary-80);   /* dark */
Component Token（元件專屬，參照 System Token，允許元件微調）
    └─ 例：--comp-button-filled-container: var(--sys-color-primary);
```

**規則**：畫面／元件開發只允許使用 System Token 或 Component Token，禁止直接寫入 Reference Token 或 hex 值，確保深色模式與未來改色（rebrand）只需改 Reference 層。

### 1.2 命名慣例

`--{layer}-{category}-{role}-{variant?}`，例如：
`--sys-color-on-primary-container`、`--sys-typescale-title-medium-size`、`--sys-shape-corner-medium`。

---

## 2. Color Palette

### 2.1 種子色與 Tonal Palette

沿用現有系統識別色 **Seed `#4F46E5`（Indigo）** 作為 Primary 種子，並依 HCT/HSL 明度階生成 5 組
Tonal Palette（Primary／Secondary／Tertiary／Neutral／Neutral Variant）＋ 固定的 Error 色階。
下表為關鍵色階（Tone 0–100，數字越大越淺）：

| Tone | Primary（indigo） | Secondary（muted indigo） | Tertiary（amber accent） | Neutral | Neutral Variant | Error |
|---|---|---|---|---|---|---|
| 0 | #000000 | #000000 | #000000 | #000000 | #000000 | #000000 |
| 10 | #0D0C27 | #16161D | #221A11 | #18181B | #17171C | #26100D |
| 20 | #1B174F | #2D2C3A | #443522 | #313135 | #2F2E38 | #4C1F1A |
| 30 | #1C1584 | #403F5A | #6F502A | #484851 | #444356 | #7E251B |
| 40 | #251DAF | #565478 | #946B38 | #61606C | #5B5A72 | #A83124 |
| 50 | #2E24DB | #6B6996 | #B98646 | #797887 | #72708F | #D23D2D |
| 60 | #5850E2 | #8987AB | #C79E6B | #94939F | #8E8DA5 | #DB6457 |
| 70 | #827BEA | #A6A5C0 | #D5B690 | #AEAEB7 | #AAA9BC | #E48B81 |
| 80 | #ABA7F1 | #C4C3D5 | #E3CFB5 | #C9C9CF | #C7C6D2 | #EDB1AB |
| 90 | #DEDDEE | #E4E3E8 | #EBE6E0 | #E5E5E6 | #E4E4E7 | #EDE0DE |
| 95 | #EFEEF6 | #F1F1F3 | #F5F3F0 | #F2F2F3 | #F2F2F3 | #F6EFEF |
| 98 | #F9F9FB | #FAFAFA | #FAFAF9 | #FAFAFA | #FAFAFA | #FBF9F9 |
| 100 | #FFFFFF | #FFFFFF | #FFFFFF | #FFFFFF | #FFFFFF | #FFFFFF |

> 另有 Tone 4/6/12/17/22/87/92/94/96/99 供 Surface Container 階層使用，完整 25 階數值見
> `scratchpad/gen_palette.py` 產出（工程實作建議改用 Material Theme Builder 以 HCT 精算，本表為近似值，已逐一通過 AA 對比驗證，見 2.3）。

### 2.2 System Token：Light／Dark Role 對應

| System Token | Light 值（Tone） | Dark 值（Tone） | 用途 |
|---|---|---|---|
| `sys-color-primary` | Primary 40 `#251DAF` | Primary 80 `#ABA7F1` | 主要按鈕、啟用中導覽項目、連結 |
| `sys-color-on-primary` | Primary 100 `#FFFFFF` | Primary 20 `#1B174F` | Primary 容器上的文字/圖示 |
| `sys-color-primary-container` | Primary 90 `#DEDDEE` | Primary 30 `#1C1584` | 次要強調容器（如選取中 Chip） |
| `sys-color-on-primary-container` | Primary 10 `#0D0C27` | Primary 90 `#DEDDEE` | 上述容器內文字 |
| `sys-color-secondary` | Secondary 40 `#565478` | Secondary 80 `#C4C3D5` | 次要動作、非主要 CTA |
| `sys-color-secondary-container` | Secondary 90 `#E4E3E8` | Secondary 30 `#403F5A` | Filter Chip 選取態、Tonal Button |
| `sys-color-tertiary` | Tertiary 40 `#946B38` | Tertiary 80 `#E3CFB5` | 圖表第三色系、次要標籤（例如假別色之一） |
| `sys-color-tertiary-container` | Tertiary 90 `#EBE6E0` | Tertiary 30 `#6F502A` | 對應容器 |
| `sys-color-error` | Error 40 `#A83124` | Error 80 `#EDB1AB` | 錯誤文字、駁回/刪除按鈕 |
| `sys-color-error-container` | Error 90 `#EDE0DE` | Error 30 `#7E251B` | 錯誤 Banner 背景 |
| `sys-color-background` / `surface` | Neutral 98 `#FAFAFA` | Neutral 6 `#0F0F10` | 頁面底色 |
| `sys-color-on-surface` | Neutral 10 `#18181B` | Neutral 90 `#E5E5E6` | 主要文字 |
| `sys-color-surface-variant` | Neutral-Variant 90 `#E4E4E7` | Neutral-Variant 30 `#444356` | Card／Table 底色 |
| `sys-color-on-surface-variant` | Neutral-Variant 30 `#444356` | Neutral-Variant 80 `#C7C6D2` | 次要文字、Placeholder |
| `sys-color-outline` | Neutral-Variant 50 `#72708F` | Neutral-Variant 60 `#8E8DA5` | 邊框、分隔線（非文字用途 ≥3:1） |
| `sys-color-outline-variant` | Neutral-Variant 80 `#C7C6D2` | Neutral-Variant 30 `#444356` | 弱化邊框（Table 格線） |
| `sys-color-surface-container-lowest/low/(none)/high/highest` | Neutral 100/96/94/92/90 | Neutral 4/10/12/17/22 | 層級化卡片堆疊（Nav Rail、Dialog、Card on Card） |
| `sys-color-inverse-surface` / `inverse-on-surface` | Neutral 20 / 95 | Neutral 90 / 20 | Snackbar 背景（永遠與當前主題反相，確保跳出感） |
| `sys-color-inverse-primary` | Primary 80 | Primary 40 | Snackbar 內的動作連結色 |

### 2.3 WCAG AA 對比驗證（節錄，完整驗證見 gen_palette.py 輸出）

| 檢核組合 | 對比值 | 結果 |
|---|---|---|
| Light：on-primary／primary | 11.21:1 | ✅ 遠高於 4.5:1 |
| Light：on-primary-container／primary-container | 14.27:1 | ✅ |
| Light：on-surface／surface | 16.97:1 | ✅ |
| Light：on-surface-variant／surface-variant | 7.58:1 | ✅ |
| Light：outline／surface（非文字元件邊框，門檻3:1） | 4.54:1 | ✅ |
| Dark：on-primary／primary | 7.43:1 | ✅ |
| Dark：on-primary-container／primary-container | 10.53:1 | ✅ |
| Dark：on-surface／surface | 15.22:1 | ✅ |
| Dark：on-surface-variant／surface-variant | 5.70:1 | ✅ |
| Dark：outline／surface（門檻3:1） | 5.93:1 | ✅ |

**規則**：任何新增色彩用途，必須先算出與其疊放背景的對比值並記錄於此表，低於門檻不得上線。假別顏色（Phase 2 的 Event Chip／狀態色點）需從 Tertiary 與 Secondary 階再擴充 3–4 組輔助色相，並比照本表驗證，且一律「顏色 + 文字/圖示」雙重編碼，不單靠色彩區分（色盲友善）。

### 2.4 State Layer（互動狀態透明度，套用於 on-color 疊在 container 上）

| 狀態 | Opacity |
|---|---|
| Hover | 8% |
| Focus（鍵盤） | 12% |
| Pressed | 12% |
| Dragged | 16% |
| Disabled 容器 | 12%（container 本身降不透明度） |
| Disabled 內容（文字/圖示） | 38% |

---

## 3. Typography

### 3.1 多語系字型堆疊

| Locale | Font Stack |
|---|---|
| `zh-TW`（預設） | `"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", "Inter", sans-serif` |
| `zh-CN` | `"Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Inter", sans-serif` |
| `en` | `"Inter", "Roboto", -apple-system, "Segoe UI", sans-serif` |
| `ja`（保留擴充） | `"Noto Sans JP", "Hiragino Sans", "Inter", sans-serif` |

**規則**：`<html lang>` 依使用者語言設定切換 `font-family` 對應堆疊；數字與日期一律加 `font-variant-numeric: tabular-nums`，確保報表/表格數字對齊。CJK 內文行高一律採用下表「寬鬆」數值（不可比照純英文縮減），避免中文字重疊感。

### 3.2 Type Scale（MD3 十五階，已調整 CJK 行高）

| Token | Size / Line-height | Weight | 用途 |
|---|---|---|---|
| Display Large | 57 / 64 | 400 | 行銷/登入頁大標題（極少用） |
| Display Small | 36 / 44 | 400 | 儀表板歡迎語（可選） |
| Headline Large | 32 / 40 | 400 | 頁面主標題 |
| Headline Small | 24 / 32 | 400 | Dialog 標題、Section 大標 |
| Title Large | 22 / 28 | 500 | Card 標題 |
| Title Medium | 16 / 24 | 500 | 表格欄位標題、List 主文字 |
| Title Small | 14 / 20 | 500 | 次要卡片標題 |
| Body Large | 16 / 24 | 400 | 表單輸入文字、內文主體 |
| Body Medium | 14 / 20 | 400 | 預設內文（列表、說明文字） |
| Body Small | 12 / 16 | 400 | 輔助說明、時間戳 |
| Label Large | 14 / 20 | 500 | 按鈕文字 |
| Label Medium | 12 / 16 | 500 | Chip、Badge 文字 |
| Label Small | 11 / 16 | 500 | 極小標籤（如表格內狀態 tag） |

> 中文排版不使用字母間距（letter-spacing）縮放（MD3 英文版常見的負 tracking 在 CJK 會造成擠壓），所有中文情境 `letter-spacing: 0`。

---

## 4. Icon 規範

- **圖示集**：Material Symbols（Outlined 為預設風格，Filled 僅用於「當前選中/啟用」狀態，如 Nav Rail 選中項目、已讀取消為未讀的鈴鐺）。
- **尺寸**：導覽/按鈕圖示 24px；Chip／Badge 內圖示 18–20px；Data Table 行內操作圖示 20px。統一使用 Optical Size 對應尺寸的圖示變體，避免縮放模糊。
- **顏色**：預設 `sys-color-on-surface-variant`；互動中/選取態 `sys-color-primary`；破壞性操作（駁回/刪除/停用）圖示 `sys-color-error`，且必為 Icon+Text 並存，不單獨用紅色圖示表達語意。
- **可觸控範圍**：Icon Button 最小點擊區 40x40px（桌面）/ 44x44px（觸控），圖示本身置中，視覺留白由元件 padding 負責，不緊貼圖示邊界畫觸控框。
- **語意一致性**：同一動作全站使用同一圖示（例如「篩選」固定用 `filter_list`，不可不同頁面混用 `tune`／`filter_list`）。建立 Icon 對照表（`docs/design/icon-map.md`，待工程實作階段補齊）作為單一真實來源。

---

## 5. Spacing（間距）

### 5.1 基礎單位與數值階

以 **4px** 為基礎單位，避免半像素造成跨螢幕密度失真：

| Token | 值 | 常用情境 |
|---|---|---|
| `space-025` | 2px | 圖示與緊鄰文字間微調 |
| `space-050` | 4px | Chip 內文字與圖示間距 |
| `space-100` | 8px | 表單欄位內 padding、按鈕圖示間距 |
| `space-150` | 12px | 卡片內元素間距 |
| `space-200` | 16px | 卡片 padding、列表項目間距、手機版頁面邊界 |
| `space-300` | 24px | 區塊（Section）間距、桌面卡片間 gutter |
| `space-400` | 32px | 頁面主內容左右邊界（桌面/平板） |
| `space-500` | 40px | 大區塊分隔（如 Dashboard Widget 群組間） |
| `space-600` | 48px | 頁首與內容間距（桌面） |
| `space-800` | 64px | 極大留白（登入頁插畫區） |

**規則**：元件內部間距（padding）一律取 `space-050`～`space-200`；版面級間距（Section、Grid gutter）取 `space-200` 以上，避免元件內外間距混用同一數值造成視覺層級混淆。

---

## 6. Grid（響應式格線）

| 斷點 | 寬度範圍 | 欄數 | 邊界 Margin | Gutter | 說明 |
|---|---|---|---|---|---|
| Compact | < 600px | 4 | 16px | 16px | 手機，Bottom Nav |
| Medium | 600–1023px | 8 | 24px | 24px | 平板／小螢幕筆電，Nav Rail 收合 72px |
| Expanded | 1024–1439px | 12 | 32px | 24px | 桌面，Nav Rail 可展開 240px |
| Large | 1440–1919px | 12 | 32px（內容置中，max-width 1440px） | 24px | 主流桌面 |
| Extra-large | ≥ 1920px | 12 | 自動（置中留白） | 24px | 內容仍限制 max-width 1440–1600px，避免單行過長影響閱讀 |

- Dashboard／報表等資訊密集頁面在 Expanded 以上採 12 欄；表單頁（如申請請假）內容欄限制在 8 欄寬（約 720px）以維持適當行長，右側試算面板佔剩餘欄位。
- Data Table 於 Compact/Medium 一律轉為卡片式列表（見 Phase 2 各畫面 Responsive 規則），不得將表格整體縮小到不可讀的字級。

---

## 7. Component Library

依 Atomic 層級彙整 Phase 2 所有畫面用到的元件，狀態統一為 **Enabled／Hover／Focus／Pressed／Disabled**（另有 Error／Selected 依元件而定），並標註對應 Token。

### 7.1 按鈕類

| 元件 | 變體 | 主要 Token | 使用場景 |
|---|---|---|---|
| Button | Filled（強調） | container=`primary`, label=`on-primary` | 主要送出動作（送出申請、核准） |
| Button | Tonal | container=`secondary-container`, label=`on-secondary-container` | 次要但仍重要（儲存草稿） |
| Button | Outlined | border=`outline`, label=`primary` | 次要動作（取消、返回） |
| Button | Text | label=`primary` | 低強調動作（了解更多、清除篩選） |
| Icon Button | Standard / Toggle（選中變 Filled 樣式） | icon=`on-surface-variant`→`primary`(選中) | 通知鈴鐺、行內快速操作 |
| Segmented Button | 單選/多選 | selected container=`secondary-container` | 檢視切換（月/週/清單） |

### 7.2 輸入類

| 元件 | 說明 | 狀態重點 |
|---|---|---|
| Text Field（Outlined） | 統一使用外框樣式（非底線），標籤浮動於邊框上 | Focus：邊框變 `primary` 2px；Error：邊框變 `error` 並顯示下方說明 |
| Textarea | 多行，最小 3 行，可調整高度上限 8 行後內部捲動 | 同 Text Field |
| Select / Dropdown | 支援搜尋型（Autocomplete，如代理人選擇需頭像） | 選單為 Elevated Surface，`surface-container-high` |
| Date / Date Range Picker | 桌面 Popover Calendar，手機 Full-screen Dialog | 不可用日期以 `on-surface-variant` 38% 顯示且 `aria-disabled` |
| File Upload | 拖曳區 + 清單，需鍵盤可觸發（Enter/Space 開啟檔案選擇） | 上傳中顯示進度條；失敗顯示錯誤 icon + 重新上傳連結 |
| Switch / Checkbox / Radio | 標準三態 + Disabled | 觸控區 40x40px 內含視覺元件本身 20-24px |

### 7.3 導覽類

| 元件 | 說明 |
|---|---|
| Navigation Rail | 72px 收合／240px 展開，選中項目 pill 背景 `secondary-container`，圖示 Filled |
| Navigation Bar（Bottom） | 手機 4 項＋更多，選中項目上方 indicator pill |
| Top App Bar | 高 64px（桌面）／56px（手機 Compact），含 Search／Notification／Locale／Theme／Avatar |
| Tabs | 底線指示器 2px `primary`，未選中文字 `on-surface-variant` |
| Breadcrumb | 用於 Admin 巢狀設定頁，分隔符使用 `/`，最後一項不可點擊且加粗 |

### 7.4 溝通類

| 元件 | 說明 |
|---|---|
| Snackbar/Toast | 背景 `inverse-surface`，文字 `inverse-on-surface`，動作連結 `inverse-primary`；桌面左下角，手機貼齊 Bottom Nav 上緣 |
| Dialog（Basic） | `surface-container-high`，Headline 用 Headline Small，主要動作在右 |
| Dialog（Full-screen，手機） | 頂部固定列：取消／標題／確認，內容可捲動 |
| Tooltip | 深色反相樣式（同 Dark 主題色，即使目前為 Light 模式），延遲 500ms 顯示 |
| Badge | 圓形數字徽章，`error` 底色＋`on-error` 文字，用於未讀/待辦計數 |

### 7.5 容器與資料呈現類

| 元件 | 說明 |
|---|---|
| Card | `surface-container` 底色，圓角 `shape-corner-medium`(12px)，1px `outline-variant` 邊框（Light 模式可選，Dark 模式建議保留以區分層次） |
| Data Table | 表頭 `surface-container-high`＋Title Medium；列 hover `on-surface` 8% overlay；分頁固定於底部 |
| List Item | 單/雙行，支援 Leading Icon/Avatar + Trailing Action |
| Chip | Assist（單一提示）／Filter（可選取，選取態用 `secondary-container`）／Input（可移除，如已選代理人） |
| Divider | 1px `outline-variant`，僅用於區隔同層級內容，不可取代 Section 間距 |
| Timeline/Stepper（簽核歷程） | 已完成節點：實心圓 `primary`；進行中：外框圓 `primary` + 動畫脈動；未開始：`outline-variant` |
| Calendar Grid | 沿用 Date Picker 色彩系統，事件 Chip 依假別色（需通過 2.3 對比驗證） |
| Progress（Linear/Circular） | `primary` 前景，`surface-variant` 軌道 |
| Skeleton | `surface-variant` 底 + shimmer 至 `surface-container-high`，尊重 `prefers-reduced-motion` 關閉動畫改為靜態灰塊 |
| Empty State Pattern | 圖示（`on-surface-variant`）＋ Title Medium 標題 ＋ Body Medium 說明 ＋ 主要 Button |
| Avatar | 圓形，無照片時以姓名縮寫＋依 hash 分配的 Tertiary/Secondary 色階背景 |

---

## 8. 交付物與後續

本文件（連同 Phase 1／Phase 2）構成可直接交付前端工程的完整規格：

- **Token 實作**：建議以 CSS Custom Properties 或 Style Dictionary 產出 `light.css` / `dark.css` 兩組 System Token，元件庫（如自建或 MUI/M3 for Web）綁定至 System Token 而非寫死色碼。
- **色彩精算**：本文 Tonal Palette 為 HSL 近似算法（已附腳本 `gen_palette.py`），建議工程 onboarding 時以 Google Material Theme Builder 用同一 Seed `#4F46E5` 重新產生正式 HCT 色階並覆蓋本文數值，色彩角色對應關係（2.2 節）不變。
- **元件庫落地**：若採用現成 Web 元件庫，建議 MUI v6（支援 MD3 token 映射）或自建 Design System 套件；Icon 建議直接引入 Material Symbols 字型/SVG sprite。

至此 Phase 1–3 皆已完成，系統具備從架構、畫面到視覺規範的完整基礎，可交付前端團隊實作或進入高保真 Prototype 階段。
