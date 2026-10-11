# Production frontend integration

本階段僅修改前端及本機測試工具。沒有改動 backend、API contract、migration、Worker binding、CSP 或 Production。正式投稿開關保持由既有 server setting 決定；本機測試開關使用獨立 D1，不會操作 Production。

2026-10-11 已依 operator 的「繼續」指示完成最後本機驗收；393 項 browser tests 全部通過，等待另行授權部署。暫停與接續歷程見 `frontend-integration-checkpoint.md`。

## 頁面與資料來源

| 頁面 | 實作與資料來源 |
| --- | --- |
| 首頁 | 保留 Hero、活動卡與快速入口。`/api/campaigns` 提供名稱、期間、點數與每日計分；`/api/submissions/status` 獨立決定投稿狀態。沒有公開榜單時顯示空狀態，不補示範成績。 |
| 投稿 | 初始、讀取失敗及 OFF 皆關閉檔案選擇、驗證與投稿。只有 ON 加有效活動才能走原有 prepare → PUT → complete → case 流程。入頁、回前景及投稿前重新檢查，不保存 ON，也不自動送出先前失敗的投稿。 |
| 案件查詢 | 案件編號／查詢碼使用原有 Guest API；查詢碼放 request header，沒有 URL、storage 或 log 持久化。不存在與無權限使用同一文案。 |
| 我的案件 | `/api/me/cases` 及 owner detail；支援 cursor。只呈現回傳的狀態、日期與點數；找不到活動名稱時明確顯示資訊不可取得，不虛構歷史活動。 |
| 排行榜 | 使用已發布 D1 API 結果與 server rank；不排序重算，不讀 Apps Script，不推算自己的名次。 |
| 登入／註冊 | 保留 Google 主按鈕與收合式密碼登入；收合不清空輸入。一般 Google 登入免 VoteProof TOTP；密碼仍使用原有 trusted device／TOTP／復原流程。已登入者轉會員中心。 |
| 會員中心 | 真實暱稱、玩家 ID、會員編號、owner cases、`/api/me/points` 點數與等級。玩家 ID 可留空以保留現值，不生成假的公開 ID 或點數明細。 |
| 登入與安全 | `/api/auth/security`、Google connect/add-password、密碼變更、Authenticator enrollment/reset、復原碼重新產生與 trusted-device 撤銷。一次性 QR／復原碼離頁或身份失效即清除。 |
| 管理案件 | `/api/admin/cases` filter/cursor/detail/review 與受授權 file endpoint；支援 backend 允許的狀態轉換與 RBAC。 |
| 活動管理 | create/update、合法狀態轉換、台灣時間輸入。已開放活動的時間／時區鎖定，封存後不可編輯。每日規則：null＝不限次數、0＝不計分、1–1000＝上限。 |
| 排行榜管理 | 定義、create/update、versioned rebuild、目前成績；可選 backend 支援的 scope／vote type／公開設定，不提供 rank／points 直接編輯。 |
| 會員等級 | 讀取真實八個等級；普通不可修改，未啟用與未設定門檻明確顯示。其他等級依 backend 校驗、version 及原因更新，不預填門檻。 |
| 投稿設定 | `/api/admin/submissions`、`/update`。活動與全域開關分離，OFF → ON 必須明確確認。成功後重新讀取公開狀態。 |
| 操作紀錄 | `/api/admin/audit-logs` cursor；只呈現時間、操作、管理會員、目標與原因，不把整份內部 JSON 或 audit 假裝成點數流水。 |

## 身份與管理安全

Google 安全驗證按鈕使用既有 `POST /api/auth/google/start`，`purpose: "security"`。callback/result 後顯示 Authenticator 欄位，再以 `POST /api/auth/google/step-up` 完成安全驗證。密碼會員可使用既有 `POST /api/auth/step-up`，提交密碼與 TOTP。這些流程不編輯 auth timestamp，也不授予角色。

只有 `/api/admin/me` 成功確認 reviewer/admin/super_admin 後才顯示管理導覽。每個管理讀取／變更都重新確認會員與角色；MFA 過期、身份改變、logout 或權限錯誤即清除管理內容與私人圖片。手機五個底部導覽固定不變，管理入口位於已授權會員區。

Reviewer 只看到案件審核及自己的 backend 允許操作；admin/super_admin 才看到設定與 audit。Frontend 不把 email、member_id、profile role、storage 或按鈕可見性當作授權。Backend RBAC／CSRF／exact Origin／MFA 仍是權限邊界。

管理變更攜帶 `expected_version` 與 CSRF。409 會清除舊編輯內容並要求明確重新讀取。網路錯誤不自動重送變更，使用者應先重新載入確認結果。表單與 tabs 處理中不可互動，避免重複操作；回前景只重新確認權限，不清空正在編輯的資料。

證明圖片只透過既有授權 API 取 raster stream，前端檢查 MIME／大小後產生記憶體 blob preview；不公開 R2 key 或永久 URL。離頁／權限失效撤銷 blob URL。所有 API 文字使用 DOM textContent，沒有新增 inline script、inline style 或 API-driven innerHTML。

## 視覺、手機與可及性

保留固定桌面側欄、原品牌與 icon、分組導覽、卡片與 Hero 比例、深色綠色／淺色紫色，以及 mobile 五格導覽。新增管理設定沿用既有 form/card/button；48px 按鈕、16px 手機輸入字體、safe-area、focus outline、labels、aria-expanded、aria-busy、disabled/inert 與原生鍵盤可操作 confirmation dialog。

本機 browser matrix 涵蓋 Chrome、Android Chrome 與 iPhone WebKit，含 320/390/430px、短 viewport、desktop、深淺色、前景／背景與 Authenticator 切換後表單保留。這是本機瀏覽器驗證；新 UI 上線後仍需另做實機 smoke，不能代替實機測試。

`docs/reference/legacy-ui.html` 是使用者提供的視覺參考，保留在文件目錄；其中示範資料與邏輯沒有加入 `public/` 或部署 bundle。

## 本機驗收

- `npm test`：752 tests。
- `npm run test:frontend-unit`：52 tests（包含在上述 752 中）。
- `npm run test:frontend`：393/393 PASS，三套 browser projects；包括管理權限回前景確認不覆蓋未保存的會員資料。
- Google、Member、Submission、Admin frontend smoke：使用真實本機 Worker／D1／R2 與隔離 provider fixture，四套皆驗證既有 API integration。
- `npm run check:admin-schema`：全新 0001–0009、本機 FK／quick_check；沒有 remote migration。
- `npm run check:public-assets`：只有可部署的 13 個 static assets；test/fixture/reference/credential files 不包含在 public bundle。
- `npm run check:frontend-sensitive -- --tracked`：183 files／0 findings；所有 tracked 與可審閱新檔，禁止讀取 gitignored live credential config。
- `npm run check`：Wrangler deploy dry-run，不部署。

下一步必須另行授權前端 Production deployment、實機 smoke 與最後正式驗證。投稿是否開放仍由 operator 決定，本階段不啟用。
