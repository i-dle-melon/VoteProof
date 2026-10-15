# 0018 remote D1 parser 修正與待授權發布步驟

2026-10-16；基準 RC `95f90a663390eec3c061ed46dbc008bb84279e7c`。
本次僅修改 0018、migration-specific test 與本文件，未操作 Production。
本文件的後續 Production 步驟均須 operator 另外授權與指定維護窗口。
舊 integration readiness 文件的 0011 狀態屬歷史紀錄；目前最後成功確認的 Production registry 為 0017。

## 根因與最小修正

原始 0018 的 60 個 logical statements 中，statement 53：

```sql
CREATE TRIGGER final_case_consume AFTER INSERT ON cases
BEGIN
 UPDATE proof_upload_intents SET state='consumed',consumed_case_id=NEW.id,consumed_at=NEW.created_at
 WHERE (session_id=NEW.upload_session_id AND completion_mode='legacy' AND state='sealed')
 OR (session_id=NEW.upload_intent_id AND completion_mode='direct' AND state='prepared');
 SELECT CASE WHEN NEW.upload_intent_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM proof_upload_intents WHERE session_id=NEW.upload_intent_id AND state='consumed' AND consumed_case_id=NEW.id)
 THEN RAISE(ABORT,'Direct intent consumption failed') END;
END;
```

在 populated temporary remote D1 單獨送出 LF 原文，得到 HTTP 400、7500、
`incomplete input: SQLITE_ERROR`。只將 `SELECT CASE … END` 改成
`SELECT (CASE … END)`，同一 temporary DB、同一 `/query` 路徑即 HTTP 200。
這是 remote trigger parser 對未括號 CASE expression 的相容性問題；沒有改掉任何 guard、FK 或 consume 行為。
上游亦有[同類 parser 問題紀錄](https://github.com/cloudflare/workers-sdk/issues/4727)，本次判定以自身 remote 對照實驗為準。

Wrangler 4.149.0 remote migration 將整份 SQL 加 registry INSERT 後送往 `/query`；
local migration 先使用 `unstable_splitSqlQuery` 再送 Miniflare batch。
先前備份演練使用 `node:sqlite` transaction，其他 tests 使用 local D1 batch，皆接受原 SQL，無法捕捉 remote parser 缺陷。
診斷中直接送 CRLF 的 statement 36 也失敗，但 LF 版本通過；正式 Wrangler 會正規化 SQL 的 CRLF，故它不是本次 Production failure 的根因。
未採用 trigger 單行化、移除 guards、拆 migration 或更換 execution mechanism。
0012～0017 與 migration 名稱完全不變，local/remote registry 不分叉。

## 驗證與私人證據

原始 0018 使用 Wrangler 4.149.0、`d1 migrations apply --remote`，在
`voteproof-0018-parser-temp-original-a49bab4d`（`369a5861-5fd1-4582-8438-3c5984adbb8d`）
重現相同 error 7500；registry 留在 0017，FK=0、quick_check=ok。

完整 export 的循環 FK 建表順序不被 remote file import 接受；schema-first import 另回 `D1_RESET_DO`。
失敗後 application schema 為空。後續改以 Cloudflare 官方支援的
[`/query` batch](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
在 temporary DB 還原已驗證 0017 副本：先建立全部 tables，再載入資料，最後建立 indexes/triggers。
這只處理測試 DB 的還原，並非新的 Production migration runner。
原始 Production export 未修改，SHA-256 仍為
`1ba7f7e2f3ead08039d5bf85907946c714e86fd56256b373f6d770b0040c6cd9`。

修正後使用相同正式 remote migration mechanism，3 個 fresh populated DB **3/3 PASS**：

| Database | ID | 結果 |
|---|---|---|
| voteproof-0018-parser-temp-fixed-1-e4461e17 | 56897e27-afa3-4bd9-81c6-23dbb217c9d6 | PASS |
| voteproof-0018-parser-temp-fixed-2-3de2d1ae | d47abb9a-1302-4822-be66-64f72bb9f9a4 | PASS |
| voteproof-0018-parser-temp-fixed-3-fc79f375 | b809c1e8-b4ba-46f6-90e4-063c321f23b8 | PASS |

每個 DB 都保留完整 backup 資料，另加入純 synthetic fixtures，涵蓋 approval/reversal、audit、backup/legacy references 與 prepared immutable intent。
每次 registry=0018、FK=0、quick_check=ok；45 張表的原欄位、筆數與逐列摘要一致，
36 個 Case/file IDs、5 位會員、9 筆 ledger（含 synthetic reversal）保留。
45 tables、53 named indexes、84 triggers 與修正後本機 oracle 完整一致；無額外 schema、partial artifacts 或 orphan references。
第一個 validation DB 另在完整修正 SQL 後注入不存在 table 的錯誤，確認 registry/schema rollback 回 0017，再執行正式 migration。

Targeted tests **99 PASS / 0 FAIL**：

```powershell
node --test --test-concurrency=2 test/direct-intent-consume-trigger.test.js test/direct-intent-cases.test.js test/direct-intent-migration.test.js test/integration-production-schema.test.js test/admin-review-workflow.test.js test/admin-image-export.test.js test/drive-backup-relay.test.js
```

涵蓋 Member/Guest Direct、one proof/Case、idempotency/replay/concurrency、legacy readers、private image、
review/batch/points/reversal/audit、Drive references、ZIP/CSV、populated rebuild 與 failure rollback。
新增 test 使用實際 migration trigger，驗證 legacy/direct consume，以及 missing/already-consumed/被忽略更新時 Case 必須 abort。
這個 local test 不宣稱能模擬 remote parser；remote evidence 是獨立必要條件。
原始 SQL、HTTP body、error/status、CLI stdout/stderr、SHA、registry、FK、quick_check 與清理證據僅存於 operator 私人目錄，不進 Git。

## 明天 A1：只補 corrected 0018

Operator 明確授權並指定新窗口後：

1. 核對本次 fix commit SHA、乾淨工作樹、Wrangler 4.149.0 與全數 source hashes；不要重用失敗時的舊 stage SQL。
2. 快速唯讀確認 registry=0017、submissions=OFF/version=16、relay=false、Apps Script trigger/Running/Queued=0、active lease/lock=0、FK=0、quick_check=ok。
3. 確認原備份存在且 SHA 符合；沿用已通過的 isolated restore，除非出現實際異常，不重新 export、restore 或跑 43-query precheck。
4. 使用新的 fix-only staging config（prefix 0001～0018 的精確核對副本；唯一 pending 為 corrected 0018），只執行：

```powershell
node node_modules/wrangler/bin/wrangler.js d1 migrations apply voteproof-cases --remote --config <approved-corrected-0018-config>
```

5. registry=0018、FK=0、quick_check=ok、完整 schema/indexes/triggers、既有資料/identity/legacy references 與 Gate OFF 全數通過後停止 A1。失敗立即停止，不重試或手動 patch。

不得重跑 0012～0017、rollback、改 Campaign、開 Gate 或恢復 relay。
舊 `type="投票"` Campaign 保留歷史；新 Campaign/type/必要 Solo target 需 operator 後續另行建立。

## A2 / B：準備，不執行

A2 另行授權後，fetch 最新 origin/main 並確認固定 release SHA。
先 push 核准的 integration branch；只有 main 仍是該 RC ancestor 且無其他變更時才採 fast-forward。
若 main 已分歧，停止並建立另經驗證、重新核准的 integration RC，不自動 merge 後部署未驗證 SHA。
核對外部 deploy hooks/Cloudflare Builds，再執行授權的 main 更新。
現有 Production workflow 是手動 dispatch，且只接受 main 上完整 approved SHA：

```powershell
gh workflow run production-deploy.yml --ref main -f approved_sha=<exact-approved-40-character-SHA>
```

workflow 有完整 release checks；不得跳過既有安全檢查來追求發布速度。
它只 deploy exact code，不套 migration；必須先有 A1 PASS。
保持 Gate OFF、relay=false、Apps Script stopped、Async disabled，核對 code SHA、100% serving version、routing、全部保留的 bindings/secrets。
`DIRECT_INTENT_CASE_ENABLED=true` 是獨立 issuance flag，不能當作 Gate 授權；其設定須明列於 A2 授權，未設定則 fail closed。

B 另行授權後，Gate OFF 下驗首頁、auth/member session、guest UI、Admin list、legacy/private proof、ranking reads、export，以及 relay-disabled 409 行為。
Prepare/PUT/Direct Case 在 Gate OFF 必須 fail closed，不做旁路或開 Gate 的 Production smoke。
成功投稿、review/batch/points/reversal 的完整正向流程沿用本次 isolated evidence；若要在 Production 實測，需 operator 另核准 controlled fixture/資料影響與清理方案，不能亂發 points。
因此 Gate OFF 的 B 報告要明確區分正向 isolated PASS 與 Production 拒絕測試，不能宣稱真實 Production 正向投稿已測。
本次沒有執行任何 Production smoke。

## Drive 恢復與最終 Gate

只有 A1、A2、B PASS 且 operator 另外授權恢復 Drive 後：

1. Apps Script triggers 保持停止；確認 Running/Queued=0、lease/lock=0。
2. 核對 latest 與 100% serving version 相同，只把 `GOOGLE_DRIVE_BACKUP_ENABLED=false` 改成 true；transport 保持 `apps_script_pull`。
3. 比對實際 code modules、其他 bindings、routing、schedules，不能只靠 code ETag 判斷。
4. 單次 manual `runBackup` smoke，確認 claim→identity→private content→complete 與 idempotent receipt；沿用既有 Drive IDs/receipts，不 backfill 或重建。
5. 確認所有已知 owner/project，恢復唯一一個每 5 分鐘 `runBackup` trigger，避免多帳號重複安裝。

上述全部 PASS、無 schema/data issue 且新活動資料有效後，仍須獨立 submission activation 授權才能開 Gate。
本次沒有恢復 relay/trigger，亦沒有開 submissions。
