# Direct Case integration assessment — 2026-10-15

本輪僅 integration/local validation，不做 CPU benchmark、Production deploy/migration/data writes、submission activation。CPU investigation 正式暫停；不再把 Free CPU <10 ms 作為硬保證。

## 第一階段唯讀結果

- `git status --short` / `git diff --stat` 均空；原 branch `codex/backend-simplification-v1`，HEAD `6bd61cad2ee6d29f04ef4b1e9f7f34a9b955c23a`。
- `git fetch origin` 後 main=`9ee795b6d105355ca08a8539adb8f55bbf5f62fc`。它也是 merge-base；沒有 main-only commits，沒有 diverged merge conflicts。
- simplification-only commits：`a296fab` immutable V2 uploads、`6febd2f` seal readback、`6bd61ca` Direct Case POC；總差異 42 files、3109 insertions、71 deletions。
- dedicated branch `codex/integration-direct-case-v1` 從最新 main 建立，再 fast-forward `6bd61cad`。main、原 POC branch 與既有工作均保留，沒有 reset/restore/clean。

## 差異與整合重點

| 範圍 | main 與 simplification 差異／風險 |
|---|---|
| Schema | 新增 0017 immutable intent、0018 direct reference；0018 重建 cases/case_files，需 populated-data / FK / rollback 驗證 |
| Frontend | 20 張、逐筆處理、RAM-only credentials、會員/匿名、retry 皆保留；POC 的 localhost query selector 尚不足作正式流程，需伺服器宣告 Direct protocol |
| Admin export | 原 UI、500 張/512 MiB 與 64 MiB 相容包、Web Worker ZIP STORE/CSV、獨立重試保留；POC 移除全部 SHA metadata 會退化 legacy export，整合時只恢復既有 legacy authoritative metadata read，direct 保持空值 |
| Review | gallery/inline/batch approve/詳細審核/審核後 points、reversal/audit 保留；direct evidence=`null`，legacy evidence reader 保留 |
| Storage | Direct 不呼叫 Complete、不建立 completed/checksum/duplicate rows；直接 reference create-only private R2 object；保留 V1 staging 與 V2 sealed readers、備份 reader |
| Rollout | 不能直接套用既有 Production deploy workflow；它會 deploy 全部新後端。必須先完成 integration gates、逐步 schema plan，再取得 operator rollout 授權 |

## Production 唯讀證據

使用固定 SELECT 取得 registry、DDL 與匿名化 preflight，所有回應 `rows_written=0`、`changed_db=false`。本機原始證據位於 ignored `.wrangler/integration-production-schema-readonly.json`，沒有取出會員私人內容。

- Production registry：0001～0011，最新 `0011_drive_backup_relay_lease_index.sql`；0012～0018 尚未套用。
- 現有 cases.upload_session_id / case_files.upload_object_key 仍是 NOT NULL legacy FK；沒有 intent/export/duplicate tables。
- submission gate=`0` / version=`16`；本輪未修改。
- normalized fan-ID collision groups=`0`；`idle_voteproof` 存在，保留原值。
- 一筆既有 Campaign 的分類是 `投票`，尚未具備 Solo/團體 authoritative category/solo_target，不能猜測或自動映射。

## Migration plan（規劃，不執行 Production mutation）

1. 重新確認 registry/DDL/Gate OFF，取得 operator 授權的完整 D1 備份與 restore 證據；本輪不取私人資料備份。
2. 精確待執行順序：0012 proof_exact_hashes → 0013 async_proof_duplicates（保留 legacy DB policy，不啟動 processor 或外部排程）→ 0014 fan_campaign_rules → 0015 admin_review_workflow → 0016 admin_image_exports → 0017 immutable_final_uploads → 0018 direct_intent_cases。
3. 0014 的 normalized unique index 必須先確認無 collision；有 collision 即停止，不 rename/delete/merge member。NULL ID 可保留，既有 Admin ID 不變。
4. 既有 Campaign 分類 `投票` 需要 operator 明確指定 Solo/團體與必要 stable target。0014 之後 active Campaign 的分類受 immutable trigger 保護，不能直接靠一般 PATCH 修復；需另行審閱、明確授權的 legacy-data remediation plan，在 transaction 內保留政策與 audit。未決定前，禁止 gate activation。
5. 0018 在本機使用 populated V1/V2 fixture、既有 points/audit/backup/export records 驗證所有 IDs、欄位與 FK，失敗必須 transaction rollback；不得依 `SELECT *` 列順序以外的未核實 production schema 冒然套用。
6. schema apply 與 code deploy 分階段，期間維持 OFF；0018 讓舊欄位 nullable，不能任意回滾至未能處理 direct references 的舊 code/schema。Rollback 應停止新 direct issuance、保留讀取與已 consumed intent，不能刪除 Case/Proof 或降版 schema。
7. A=code/schema rollout（另需明確授權）；B=operator 授權範圍內 smoke；C=獨立 gate activation 授權。A/B 成功不等於允許 C。

## 本輪 validation

最終結果、legacy compatibility、剩餘風險與精確下一步見 [readiness report](direct-case-launch-readiness.md)；本文件不代表 rollout 授權。
