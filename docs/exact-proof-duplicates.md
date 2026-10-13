# SHA-256 exact-file 證據 V1（本機候選）

**尚未 push／部署／套用 Production migration 或 Production hash backfill。**

瀏覽器 prepare 取得 staging PUT URL；complete 用私有 R2 HEAD 核對 MIME、size、ETag。
case 建立前以 ETag conditional GET 讀取來源，封存至不可被 staging PUT 覆寫的 case object。
此候選在該伺服器可信串流逐 chunk 計算 SHA-256；Workers 以 FixedLengthStream 保持 R2.put
所需長度，沒有完整 proof buffer。Node 測試呼叫的非 Workers fallback 使用有上限的 ArrayBuffer。
哈希與 case_files 在同一 D1 batch 保存；任何 rollback 不留下 hash，模糊 ACK 則沿用既有
consumed session／idempotency reconciliation，不將技術 retry 變成新案件。
[Workers stream API](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/)。

0012_proof_exact_hashes.sql 只新增 table、非 unique exact lookup index 與 metadata／immutability
guards。每 proof object 一個 file_id PK；algorithm=sha256、version=1、verified_at、source_etag、source_size
皆保存，D1 不存影像。相同 digest 可出現在多筆不同 proof，絕不以 UNIQUE 阻擋。

| 相符關係 | 證據解讀 |
|---|---|
| same_member_same_campaign | 強 exact 重複訊號，仍交由人工審核 |
| cross_member_exact | 跨會員 exact 風險訊號，禁止單憑此自動拒絕 |
| same_member_other_campaign | 歷史 exact 相符，不自動無效 |
| guest_exact_unknown | 訪客關係無法證明，不將兩個 NULL 當成同一會員 |

只比對較早提交的其他案件；時間相同時以內部 UUID 穩定排序。Admin detail 的 duplicate_evidence
最多回傳最近 100 match records，含舊 case ID、status、submitted time、same_campaign、same_member、
relationship；不回傳其他會員 ID／email、digest 或 object key。hash_state 可為 verified／partial／not_verified，
舊 proof 沒有 hash 時不聲稱已檢查。Admin UI 使用 textContent，保留人工 review 操作；public response
維持原契約，不揭露跨會員訊號、不指控作弊、不改 status／duplicate_flag／points。

產品 batch 仍由 submission.js 每張各自 upload session／Idempotency-Key／case／review／points。
20 張 exact duplicates 仍是 20 個獨立 pending cases；同一成功 item retry 不再建立案件／hash。
equal size 不是證據；不同一 byte 或 re-encoded visual equivalent 不相符。V1 沒有 OCR、pHash、視覺比對。

本機 backfill：

```powershell
node scripts/backfill-proof-hashes-local.mjs --limit=10
node scripts/backfill-proof-hashes-local.mjs --apply-local --limit=10 --after=LAST_FILE_ID
```

只有 .wrangler/proof-hash-local 下的 isolated local state 可使用；CLI 沒有 remote／Production 參數或服務憑證。
預設 dry-run，batch 1–20，輸出 next_cursor。只 conditional GET 舊 R2 bytes、寫 absent hash；不寫 R2、
不轉檔、不新增案件／點數，重跑 idempotent。失敗 ID 保留 code，修復後從空 cursor 重跑以補漏；
不要將 cursor advancement 解讀為失敗已恢復。Library 接收 db／bucket 供隔離測試；不得自行套用 Production。

未執行即時 Production SHA canary：Production 仍釘住已接受 91e0a70，候選完全 local。
SHA 串流 CPU 在代表性最大檔案大小仍需後續 release 前量測；此次不把 13KB Drive canary CPU 當成 SHA CPU。
