# R2 Archive：下一階段本機安全驗證／需求修正

基準：`ad528e81e755de315d80d1a07fc297a917ebcc48`。
本文件優先於原交付中要求冷讀、還原或 ZIP 支援的舊提案。原已審查 10 檔不改寫。

## 已確認的產品範圍

- 不新增 Google Drive 冷圖片 API、不自動還原 R2、不讓 cold 圖片加入 ZIP。
- 案件、積分、審核、圖片 metadata、備份紀錄、immutable audit 都保留。
- 管理端顯示「已封存至 Google Drive」；圖片 410 是預期生命週期，不是一般系統故障。顯示案件仍可用，但不顯示圖片重試／還原按鈕。
- ZIP 維持拒絕含 cold 圖片的整個範圍；不默默漏圖、不假造 ZIP、不變更完成 ACK。
- 原有權限可開啟 Drive 的連結保留，沿用 Google 私有權限；不是 Worker 冷讀或還原功能。沒有取回／還原開發交付。
- 保留 7 天結案、Drive confirmed、重新讀原始 bytes 的 SHA-256／身分／MIME／大小／資料夾驗證、HMAC nonce/timestamp、D1 pin/CAS、來源 R2 version/ETag、安全占用、失敗與 lost-ACK 保護。
- 10 GB 是十進位管理預算；90% 開始、85% 目標、95% 停止新 PUT、低於90%可信盤點才恢復；均不改。

## 本機實證與不能忽略的風險

1. 新測試入口直接執行原 Worker router 與新版 `{canary:true}` A、`{canary:true,handoff}` B。不同 HTTP invocation，沒有用空 body 充當 CPU 樣本。獨立 mock service binding 只回傳經 HMAC 簽署的合成收據。
2. 有界 1／3／5 MiB native local R2/D1 流程可完成；本機不能證明 Cloudflare Free CPU。
3. 缺少 exclusive-writer attestation 時封鎖。持久 pin 可阻止經 `reserveStorage` 的合作寫入。
4. 對抗測試證明：外部程式若繞過 D1，在最後 HEAD 後、DELETE 前以同 key PUT，現有無條件 DELETE 仍可能刪除新版本。ETag/version HEAD 不是原子 conditional DELETE。這項風險**已重現，未修復**，安全前提未成立不得 live。
5. 另一個對抗測試證明：已持有 A handoff、Canary Journal 暫停時，合法的舊 `{}` caller 仍可進 B。此空 body 僅為舊 caller 風險測試，絕非新版 CPU 樣本。
6. 不更改安全核心來掩蓋上述限制。不把先前容量盤點接受的在途 PUT 例外擴張為刪圖授權。

## Maintenance caller 範圍（原始碼唯讀盤點）

| 來源 | 行為／風險 | 本輪處理 |
|---|---|---|
| Code.gs `runStorageMaintenance` | quota、tick、舊 archive `{}` A/B；server live 開啟時可能刪除 | 保留原碼；列為啟用阻擋，必須先停用／隔離所有排程與手動來源 |
| StorageArchiveCanary.gs `runStorageArchiveCanary` | 新 A/B，ScriptLock＋持久 Journal；只 pin 同 Script／origin | 原10檔凍結；任何異常人工 hold，不逾時自清 |
| StorageInventory.gs `runStorageInventory` | quota、inventory_only、finalize；不 archive、不寄信 | 不改、不停既有備份／容量排程 |
| Code.gs `runBackup` | 原備份 claim/read/ack；不是 archive caller | 不改；清理 guard 仍需排除進行中備份 |
| Admin storage dry-run | `previewOnly:true` | 不會真刪；不拿來證明 server live 已停 |
| internal `/archive` 舊 API | 沒有 Canary 協定也可在 server live 時清理 | 尚無統一 operator pause／caller fencing；保留為未解決發布阻擋 |
| Worker scheduled | 僅 opt-in legacy backup transport，原始碼無 archive 呼叫 | 不新增 Cron；實際遠端設定未查，UNKNOWN |
| 舊 validate-archive-cloud／archive-isolated-worker | 舊離線工具含空 body、部署及資源建立邏輯 | 本輪不執行，不作新版驗收來源 |
| 其他 Google 帳號、其他 Script 專案、外部 CLI／CI | 本機無法列出 | UNKNOWN，不能由一次 `getProjectTriggers()` 推定不存在 |

Apps Script `getProjectTriggers()` 的結果不是跨帳號全域清單。後續由每位安裝者在該 Script 的「觸發條件」、個人 Apps Script「我的觸發條件」、專案「執行項目」核對；另外檢查其他專案副本、手動入口、外部服務／Workers bindings。沒有證據就維持 UNKNOWN。

## 暫停、lost-ACK 與恢復

- Script Journal 只暫停該執行器，LockService 不提供跨 Script／跨外部服務鎖。
- 新測試 Harness 的 D1 budget `paused=1` 只封鎖這個獨立測試 Worker 後續請求，也不是正式全系統停機開關。
- server live OFF 可阻擋之後進入的刪除，但不保證已通過 live 檢查的 B 被取消；移除 Trigger 同樣不撤銷在途請求。
- A 回覆遺失：物件仍在，保留 Journal；先唯讀核對 D1，不自動再 A/B。
- B 回覆遺失／DELETE ACK 遺失：保留 deleting pin、lease 與 audit，不能靠回覆 `deleted:0` 宣稱沒有刪除。新 Canary 不自動接管 deleting。
- 要恢復前，先確認所有舊 caller 及跨帳號排程受控，等待在途請求結束，再核對 R2 HEAD、cold_proofs、case/backups versions、terminal audit；只提出單筆受審恢復方案，另行授權，不清 pin、不整庫 restore。
- 現有舊 API 的 missing recovery 路徑不是此次自動開放的恢復工具。

## 正式啟用阻擋

Production 自動清理 **NO-GO**：真 Cloudflare CPU、真 Drive E2E 尚未驗收；全系統 caller／跨帳號 Trigger 控制未證實；HEAD→DELETE 仍依賴所有寫入者合作；本輪沒有部署版數與正式設定證據。手動 Drive 連結或 410 UI 改善不能消除這些阻擋。

沒有新增 Migration。只有隔離測試 schema 與合成資料 SQL；不得對正式 D1 使用。既有 Migration 歷史、Runtime 安全核心與容量門檻均保留。
