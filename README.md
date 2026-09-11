# 請假管理系統（Leave Management System）

iDA Workplace 內部使用的請假與年度考核系統。

**正式網址**：<https://leave.idaworkplace.com.tw>

> **第一次接手這個系統的人，請先看 [`docs/維護指南.md`](docs/維護指南.md)。**
> 那份是寫給沒有工程背景的人看的，會告訴你這個系統平常怎麼顧、出事怎麼查、
> 哪些地方碰了會壞。這份 README 是給你「找東西」用的地圖。

---

## 這個系統在做什麼

員工用它請假，主管用它簽核，HR 與管理員用它管設定與跑報表，另外還包含一套
年度考核的填寫與評分流程。系統會透過 Slack 發通知（假單送出、核准、駁回，
以及每天固定兩則的請假公告）。

員工可以把它「裝」成手機或電腦上的 App（PWA），操作起來跟一般 App 一樣，
但實際上還是網頁——所以**系統更新是全自動的，使用者不需要重新安裝**。

## 系統由哪幾塊組成

這件事很多人會搞混，先講清楚。系統不是一個東西，是四個服務串起來的：

| 服務 | 負責什麼 | 弄丟的後果 |
|---|---|---|
| **Supabase** | 資料庫。所有請假紀錄、員工資料、考核內容、登入帳號都在這裡 | **無法重建** |
| **GitHub** | 存放程式碼與完整修改歷史 | 可從本機重推 |
| **Vercel** | 把程式碼變成大家看得到的網站 | 重新部署即可 |
| **Slack App** | 發送通知的權限與設定 | 照文件重設 |

**只有 Supabase 的資料弄丟是救不回來的**，其他三個最多花一個下午重建。
備份策略見「系統交接與資料保全」文件。

程式碼改動之後會自動上線，流程是：

```
有人把程式碼推到 GitHub  →  Vercel 自動偵測到  →  自動重新建置並上線
```

這條線是全自動的，沒有人需要手動按任何按鈕。

## 我想做 X，該看哪裡

| 我想…… | 去看 |
|---|---|
| **第一次接手，不知道從哪開始** | [`docs/維護指南.md`](docs/維護指南.md) ← **從這裡開始** |
| 知道帳號在誰手上、離職怎麼交接、怎麼備份資料 | 「系統交接與資料保全」文件（見下方連結） |
| **改特休的計算方式** | [`docs/維護指南.md` 的「特休怎麼算」](docs/維護指南.md#特休怎麼算碰之前務必讀完這節) ← 牽涉三個地方，碰之前務必讀 |
| 改 Slack 通知的內容或發送時間 | [`supabase/functions/README.md`](supabase/functions/README.md) |
| 改資料庫結構（加欄位、改權限） | [`supabase/migrations/README.md`](supabase/migrations/README.md) |
| 清除測試資料、跑維護腳本 | [`supabase/maintenance/README.md`](supabase/maintenance/README.md) |
| 知道當初每個畫面是怎麼設計的、為什麼這樣排 | [`docs/design/phase2-screens.md`](docs/design/phase2-screens.md) |
| 改顏色、字級、間距（設計規範） | [`docs/design/phase3-design-system.md`](docs/design/phase3-design-system.md) |
| 了解整體架構與角色權限的設計邏輯 | [`docs/design/phase1-foundation.md`](docs/design/phase1-foundation.md) |

> `supabase/migrations/README.md` 目前是英文的，內容是每一次資料庫改動的紀錄。
> 如果看不懂，可以把整份貼給 AI 工具請它翻譯說明——內容本身寫得很完整，
> 只是語言的問題。

## 程式碼放在哪

```
src/
├─ pages/          每一個畫面（Login 登入、Home 首頁、LeaveForm 請假申請……）
├─ components/     共用的元件（按鈕、對話框、表格……）
├─ context/        跨畫面共用的狀態（登入身分、深色模式……）
├─ i18n/           中英文翻譯字典
├─ lib/            共用的計算邏輯（例如假期額度怎麼算）
└─ styles/         設計 token（顏色、字級、間距的定義）

supabase/
├─ functions/      Slack 通知程式（跑在 Supabase 上，不是網站的一部分）
├─ migrations/     資料庫結構的變更歷史，一份一份按時間排
└─ maintenance/    偶爾才手動跑一次的維護腳本
```

畫面對應關係（`src/pages/` 底下）：

| 檔案 | 對應的畫面 |
|---|---|
| `Login.jsx` | 登入頁 |
| `Home.jsx` | 首頁（依角色顯示不同內容） |
| `LeaveForm.jsx` | 申請請假 |
| `MyLeaves.jsx` | 假單管理（自己的假單＋待簽核的假單） |
| `Review.jsx` | 考核管理 |
| `AdminPanel.jsx` | 管理後台（員工帳號、簽核流程、通知對象） |
| `EmployeeLeaveManagement.jsx` | 員工假期管理（額度設定） |
| `ExportReport.jsx` | 報表匯出 |
| `Settings.jsx` | 個人設定 |
| `InstallGuide.jsx` | 安裝說明（裝到手機／電腦） |
| `LeaveTypeNames.jsx` | 假別名稱設定 |

## 在自己電腦上跑起來

需要先裝 [Node.js](https://nodejs.org/)（選 LTS 版本即可）。

```bash
npm install     # 第一次才需要，把相依套件裝起來
npm run dev     # 啟動開發用的網站，畫面會顯示一個 localhost 網址
```

打開它顯示的網址（通常是 `http://localhost:5173`）就能看到系統。

**重要**：這樣跑起來的系統，連的是**正式的 Supabase 資料庫**，不是測試用的。
所以在本機做的任何操作（送假單、改設定）都會影響真實資料，測試時請小心。

其他指令：

```bash
npm run build   # 打包成正式版（Vercel 自動部署時會跑這個，平常不用自己跑）
npm run lint    # 檢查程式碼有沒有明顯寫錯的地方
```

## 環境變數

系統需要兩個值才能連上資料庫：

| 名稱 | 用途 |
|---|---|
| `VITE_SUPABASE_URL` | Supabase 專案的網址 |
| `VITE_SUPABASE_ANON_KEY` | 公開金鑰（給瀏覽器用的，安全性靠資料庫的 RLS 規則把關） |

這兩個值同時存在兩個地方，**必須一致**：

- 本機的 `.env` 檔（給 `npm run dev` 用）
- Vercel 專案的 Settings → Environment Variables（給正式站用）

改了 Vercel 上的值之後，**必須重新部署一次才會生效**——因為這類變數是在
「打包當下」就寫進程式碼裡的，不是網站執行時才讀取。

Slack 相關的金鑰不放在這裡，設定在 Supabase 的 Edge Functions → Secrets，
詳見 [`supabase/functions/README.md`](supabase/functions/README.md)。

## 這個專案的一個特色：註解寫的是「為什麼」

程式碼註解與資料庫變更說明**全部是中文**，而且刻意記錄了「當初為什麼這樣做」
而不只是「做了什麼」。

這對接手的人很重要——很多看起來奇怪的寫法其實是刻意的，註解會告訴你原因。
**改任何東西之前先讀該處的註解**，不要把當初刻意的設計當成 bug 改掉。

## 相關文件

- **系統交接與資料保全**（帳號歸屬、備份策略、離職交接流程）：
  <https://claude.ai/code/artifact/01adfb4f-eaa7-41e1-86f4-506fe1bfd20f>
- **維護指南**（給非工程背景的接手者）：[`docs/維護指南.md`](docs/維護指南.md)

## 技術堆疊

React 19 + Vite（前端）、Supabase（資料庫與登入）、Vercel（部署）、
Slack API（通知）。前端沒有用任何 UI 框架，元件都是自己寫的，
設計 token 定義在 `src/styles/`。
