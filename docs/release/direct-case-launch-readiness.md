# Direct Case mainline integration / launch readiness

2026-10-15。本輪只做本機整合、correctness regression 與 Production 唯讀 assessment。沒有 deploy、push、remote migration、Production data mutation、submission activation 或 CPU benchmark。

## A. MAINLINE STATUS

- 兩次 `git fetch origin` 確認 main=`9ee795b6d105355ca08a8539adb8f55bbf5f62fc`。
- main 是 `6bd61cad2ee6d29f04ef4b1e9f7f34a9b955c23a` 的 ancestor，main-only=0，沒有需要解決的 merge conflict。
- main 的 Review V2 gallery、batch approve、固定/自訂排行榜、Admin image export、粉絲 ID/暱稱、Dark/Light、Pages fixtures 都保留。

## B. SIMPLIFICATION BRANCH STATUS

- 原 branch `codex/backend-simplification-v1`、HEAD `6bd61cad` 原封保留。
- POC-only commits：`a296fab` → `6febd2f` → `6bd61ca`。
- 從 main 建立 `codex/integration-direct-case-v1`，fast-forward POC，再建立本輪 integration commit；沒有在 main 上開發。

## C. INTEGRATION DIFF

- 原 main→POC：42 files、+3109/-71；沒有引入 Queue/Split Complete 或 image heuristic subsystem。
- `/api/submissions/status` 明確宣告 `upload_flow=direct`；正式 renderer 依伺服器協定選 Prepare→Worker PUT→Direct Case，不需要 localhost POC query。
- 每個 logical submission 固定協定與 idempotency context，refresh/retry 不會切換 endpoint 或 owner。舊 backend/fixtures 未宣告協定時保留 legacy 相容性。
- 新 Direct 路徑不呼叫 Complete、不寫 completed receipts、checksum evidence 或 duplicate jobs/groups；native R2 SHA 驗證只用於物件完整性，沒有內容 heuristic 或 duplicate processor rollout。
- legacy export 恢復讀取既有、ETag/size 相符的 SHA metadata；Direct CSV SHA 為空，不重新計算或新增 cloud evidence。
- 修正 offline campaign release builder 遺漏 `solo_target` 的問題，並維持原 MFA、權限、transaction 與 audit guards。
- 更新落後於產品的測試導覽/fixtures 與 local schema checker；沒有放寬 Production CSP、授權或資料政策。

## D. MIGRATION PLAN

Production 固定 SELECT 證據：registry=0001～0011；所有 response `rows_written=0`、`changed_db=false`。DDL-only fixture `test/fixtures/production-schema-0011.json` 不含會員、案件、憑證或 proof rows。

精確待套順序如下；**本輪未執行**：

1. `0012_proof_exact_hashes.sql`
2. `0013_async_proof_duplicates.sql`（保留 legacy DB policy，不啟動 processor 或外部排程）
3. `0014_fan_campaign_rules.sql`
4. `0015_admin_review_workflow.sql`
5. `0016_admin_image_exports.sql`
6. `0017_immutable_final_uploads.sql`
7. `0018_direct_intent_cases.sql`

先取得 operator rollout 授權、受控完整備份與還原演練證據，再重新核對 registry/DDL/FK/gate 與 fan-ID collision。順序套用，每一步核對 registry、FK、row counts 與 Gate OFF；任何不符立即停止。

- normalized fan-ID collision groups=0；既有 `idle_voteproof` 存在且不變。碰到新 collision 時 fail，不能 rename/delete/merge member。
- 現有一個 Campaign category=`投票`，沒有可靠 Solo/團體與 target mapping。需 operator 決定 legacy remediation 或另建有效活動；不能猜測，也不能繞過 0014 immutable type policy。此決定與 remediation SQL 仍未批准，阻擋 gate activation。
- 0018 重建 cases/case_files；保留既有 IDs、columns、政策與 references，新增 direct/legacy exclusive source。populated migration、deferred FK graph 與失敗 rollback 已在 disposable D1 驗證。
- 不能將已產生 Direct Case 的 schema 倒退為 NOT NULL legacy-only schema。回復策略是 Gate OFF、停止新 Direct issuance，保留相容 reader 與既有 intent/case/file；不能刪除新案件來配合降版。

## E. TEST RESULTS

最終 Node correctness suite **1101/1101 PASS**、無 skipped；Direct real Worker/browser smoke **6/6 PASS**；local schema/registry replay、FK/quick_check 與 Worker `deploy --dry-run` **PASS**。詳細本機輸出在 ignored `.wrangler/integration-*.log`；全部 mutation tests 使用 disposable local D1/R2 或純 fixture，不是 Production smoke。

Browser 全套首跑 744 項，704 PASS、40 項失敗；原因是舊測試仍預期 gallery 隱藏操作、會員 private ID、舊 Solo 分類、未收合 receipt 與舊唯讀請求/CSP native-select allowlist。修正這些 assertions/操作後，相關五份 spec 在三瀏覽器重跑 **207/207 PASS**；其餘未變更 **537 項**已於首跑通過。因此 744 個測試皆有通過證據，並非宣稱最後單次完整執行 744/744。Node 首跑 1090/1100，10 項舊 release fixtures/build-plan 失敗已修復，最終完整重跑如上全數通過；沒有跳過失敗。

驗證範圍包含：

| 範圍 | 證據 |
|---|---|
| Member / Guest / one proof one Case | Direct API/domain suite、20 張逐筆與 partial batch、真實 Worker browser smoke |
| Prepare → PUT → Case | 正式頁面自動選 Direct；請求紀錄確認沒有 Complete |
| Retry / idempotency / concurrent same proof | lost PUT/Case ACK、原 key/payload 回放、consume CAS、唯一 Case/file、points 不重複 |
| Cleanup race / immutable private proof | write pin、consume/deleting conflict、native checksum/ETag、消失或變更物件 fail closed |
| Review / batch / points / reversal / audit | 既有全套 domain regression 加 Direct 單筆/20 筆與 partial failure |
| Ranking / campaign / fan-ID | 正式 ledger、固定榜/自訂榜、綁定 type、identity immutable/security regression |
| Drive backup | 既有 relay suite；另以 Direct proof 完整 claim→private content→identity→verified complete→lost-ACK replay |
| ZIP / CSV image export | legacy SHA read compatibility、Direct null SHA、authenticated stream、ZIP filename/CSV mapping |
| V1 / sealed V2 readers | populated migration、case/file read、private image/export、legacy control smoke |
| Dark / Light / mobile | Chrome、Android、WebKit；320/390/430/1024/1440；modal/inline/gallery 與 no horizontal overflow |
| Security | auth/ownership/RBAC/MFA/CSRF/Origin/query-key isolation、private R2 無 public URL、Pages safety |
| Migrations | 觀察到的 Production 0011 DDL→0018；populated preservation、FK/quick_check、失敗 rollback、fresh local registry replay |

CPU 結論沿用使用者已接受的 POC 決策；本輪沒有重新 benchmark 或聲稱硬保證 <10 ms。

## F. LEGACY COMPATIBILITY

V1 staging/case copy 與 V2 sealed references/readers 都保留；既有案件、附件、points、audit、備份與 export 不需重寫。新 UI 不依賴 Complete。舊 client 可完成既有 legacy protocol，不能為此刪掉 reader；舊 UI/cache 的排空策略應列入正式發布視窗，避免誤把 legacy compatibility 當成新路徑。

## G. PRODUCTION RISKS

1. Production 比 main 少 0012～0018，也尚未部署 main 的完整後端；不能只更新 UI 或直接 dispatch 現有 workflow。
2. 0018 parent-table rebuild 必須有 operator 備份、受控 migration window 與還原證據。local replay 不等同 Production 執行成功。
3. legacy Campaign category `投票` 尚未由 operator 決定如何處理；0014 不允許任意修改 active Campaign 類型。
4. Direct issuance 需明確設定 `DIRECT_INTENT_CASE_ENABLED=true`；未設定時 fail closed。這不是 submission gate，也不授權開放投稿。
5. Free CPU 沒有 <10 ms 硬保證；保留有限重試、idempotency 與 operator 觀察。不得藉此重新開始 CPU investigation。
6. 外部 Supabase/Drive 與實際 Production browser/設備/負載尚未做本輪 smoke；本輪只驗 local provider/relay contracts。
7. 既有 Production workflow 只手動 dispatch，且 deploy 全 Worker、`--keep-vars`，不會替 operator 套 migration。不可把它當成自動 schema rollout 或 Pages-only 發布。

## H. LAUNCH READINESS

本機 integration correctness 與 operator rollout readiness 分開判定。通過 local regression 可送審 integration；不代表已完成遠端 migration、Production smoke、資料修復或獲得部署許可。

## I. GO / NO-GO

- Local integration：**GO（可送審）**，1101 Node correctness、744 distinct browser tests 的通過證據、6 個 real Worker smoke 及 local migration checks 已完成。
- Production rollout：**NO-GO**，尚未收到「允許部署 Production」，migration/backup/legacy Campaign 決策仍需 operator 處理。
- Submission activation：**NO-GO / OFF**，即使 A/B 完成也須另一份明確授權。

## J. EXACT NEXT PRODUCTION STEPS

1. 審閱 integration commit、0012～0018 migration 與此報告；決定 legacy Campaign 分類/活動方案、備份/還原與回復窗口。
2. Operator 明確授權 A：指定 release SHA、code/schema rollout 範圍；仍維持 Gate OFF。授權前不 push/merge/deploy/migrate。
3. 重新唯讀 preflight；完成授權的 D1 備份/還原驗證，凍結操作視窗，依 D 節順序套 migration、逐步核對 row/FK/registry/gate，再 deploy 精確 SHA；核對 Direct flag、保留 auth/backup vars，Async processor/trigger 維持不啟用。
4. B：在 Gate OFF 下驗首頁/會員/Admin、private image/legacy readers、schema、授權與投稿拒絕行為。不得為 Production smoke 加入 bypass 或暗中打開投稿；投稿全流程已在隔離本機驗證。
5. 產出 A/B 實際結果與殘餘風險，交 operator；任何失敗保持 OFF，依前述相容 reader 策略處理，不盲目 downgrade schema。
6. C：**等待另外明確的 submission gate activation 授權**，才可進行開放及授權範圍的 canary。A/B 成功不能自動執行 C。
