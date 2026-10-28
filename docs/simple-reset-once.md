# 一次性簡化 REST CLI

僅供 Operator 本機使用。Worker 保持 `aab87e6dc596344cd346d9338be10e384230603e`；不安裝新 Schema、不部署、不操作 R2/Drive，不自動恢復服務。

## 保留與簡化

- 沿用 0028 分類、既有 Manifest/FK 閉包、已部署 Reset 0001 與 REST 單次 batch 通道。
- 交易內只核對清理相關表的完整原始列、精確 PK、Gate/Epoch/Version、未決作業及完整 Schema。使用集合差集，沒有字典或重複全歷史快照。
- 只對有待清資料的表發出帶 PK 條件的 DELETE，只暫時處理必要 Immutable Trigger；同一交易恢復原定義、記錄 Receipt、CAS 前進 Epoch、移除 Permit、核對 FK/末態。SQL 條數依實際清理範圍決定。
- 31 張身分/設定/容量表在交易前後完整讀取並比對全部欄位雜湊；保留的混合設定 Audit 與榜單定義在交易內精確核對。歷史盤點/配額紀錄不被刪除，也不反覆讀取。
- 所有實際 ID、Key、會員內容、備份與私有 package 均放既有 owner-only ACL 私有目錄，不能放入公開交付或 Git。

## 本機命令

私有 package 欄位：`snapshot_file`、`manifest_file`、`approved_manifest_sha256`、`approved_cutover_sha256`、`recovery_file`、`prepared_file`。執行時另需 `approved_prepared_sha256`、`authorization_file`、`journal_file`、`simple_cloud_proof_file`、`freeze_file`、`existing_auth_resolver_file`。

```powershell
node scripts/prelaunch-reset-simple.mjs --package <private-package.json> --prepare
node scripts/prelaunch-reset-simple.mjs --package <private-package.json>
# 以下只在新的精確正式授權成立後執行，本輪禁止：
node scripts/prelaunch-reset-simple.mjs --package <private-package.json> --execute
# UNKNOWN 時只能在唯讀對帳授權下使用，不能再次 --execute：
node scripts/prelaunch-reset-simple.mjs --package <private-package.json> --reconcile
```

預設 dry-run 不解析憑證、不送出網路請求。正式執行限制在既有正式 account/D1 UUID，先驗證所有非秘密授權/Proof/凍結/還原條件，再解析既有 OAuth。CLI SHA-256 與 Worker Git SHA 分開記錄。

## 正式一次性接續順序（尚未授權）

1. 唯讀確認 Worker/Bindings/Reset 0001/FENCE，Gate OFF、Script 暫停、維護模式、有效的既有 Super Admin/MFA 恢復能力；外部控制面由 Operator 獨占、不做其他寫入。未知操作/Lease/Pin/ACK 存在就停。舊 DELETE 不宣稱完成，以既有 Key 世代隔離處理。
2. 建立新鮮私有 D1 Bookmark、完整備份及可還原核對。以本機還原資料產生最新 FROZEN Manifest；與已審查 PK/件數/Key 範圍核對。不得自動擴大清理範圍。
3. 產生 Prepared，核對 Manifest/CLI/Prepared SHA、2 MB body、每條 SQL/參數上限、最小雲端差異 Proof。Operator 一次批准精確範圍及後續服務恢復條件。
4. CLI 先完整核對會員/設定，再以 `wx` 建立並 fsync Journal。只送出一次原子 REST batch，不拆 DELETE、不自動重送。
5. ACK 不明立刻 HOLD，保留原 Journal。成功 ACK 仍需唯讀驗證不可變 Receipt、精確末態/Schema/FK/退休 Key，再完整核對會員、登入/MFA/角色/網站設定。HTTP 200 本身不是完成證明。
6. 驗收案件/積分/排行結果清零、榜單定義保留、舊圖片各伺服器讀取路徑被拒絕；R2 實體物件保留，容量不得假減。既有榜單快取仍須標記已接受的 `KNOWN_STALE_NOT_PASS` 並依正式核准條件處理。
7. 只有核心資料、原有網站必要 API、可信容量及服務恢復條件通過，才依同次核准的既有程序恢復維護控制、備份/盤點、最後恢復投稿。現有容量期限過期須合法重新盤點，不手改 TTL。Cleanup OFF、Dispatch9 HOLD 不變。

任一步不明就留在維護狀態。不自動回復舊 Worker、不自動 Time Travel；D1 還原不能回復 R2。需要回復時先核對是否已有新 Epoch 合法寫入，再取得精確還原授權。

## 剩餘最小驗證

既有 REST DDL/Trigger/FK 原子交易證據沿用。本機新測試不冒充雲端。僅需對本次簡化 Guard 做一個故意末態失敗的完整回滾，以及一個成功後遺失 ACK 的唯讀 Receipt 對帳。建議仍使用原未耗用上限：1 個 Free D1、0 Worker/R2/Drive/Supabase、Metadata GET≤6、D1 POST≤42、SQL≤1200；需 Operator 批准改用簡化 SQL 的測試範圍後才執行。不得重跑舊完整矩陣。
