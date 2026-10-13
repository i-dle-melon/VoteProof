# SHA-256 V1：R2 驗證候選（尚未部署）

結論：**NO-GO**。本機已移除投稿／建案路徑的 Worker 整檔雜湊與緩衝，但完整建案請求仍反覆超過 Workers Free HTTP 的 10 ms CPU 限制。不得部署此候選、套用 0012 或執行 Production hash backfill。Production 保持 `91e0a707d0f1155907ebf3a15d3d6564d72a98ad`；本次起始候選為 `84b1bf28d1d731fb86eb5d28f472207c3e0e611b`。

## 候選契約與信任邊界

瀏覽器每個 File 計算一次 SHA-256，技術重試沿用同一 digest、上傳 context 與案件 Idempotency-Key。prepare 的每個 file 必須提供 `algorithm: "sha256"` 與 64 字元小寫 hex `sha256`；缺少、格式錯誤或其他演算法均拒絕。這只是未驗證宣告。

prepare 保留 Turnstile、submission gate、檔案數量／大小／MIME／安全名稱驗證，改發 300 秒 AES-GCM 不透明 grant。新增專用 `UPLOAD_GRANT_SECRET`（隨機 256-bit、小寫 hex），不得重用 relay、auth 或 case secret。`AUTH_ORIGIN` 對 Guest 上傳也必須設定。grant 綁定 route、staging key、檔案長度、MIME、宣告 SHA、期限；在 `X-Upload-Grant` header 傳送，不能放在 query、log 或 storage。prepare 與 complete 仍是原 Guest-capable 公開 metadata API；case 的會員 cookie／CSRF、Admin MFA 與 relay 驗證完全保留。

PUT 使用同源 `/api/uploads/put/<session UUID>/<file UUID>`，檢查 Origin、grant、精確 Content-Type、Content-Length 與 submission gate。Worker 將原始 `request.body` 直接送入 `R2.put(key, body, {sha256, httpMetadata})`。只有 provider 成功回傳且 checksum／實際 size／MIME 相符才 ACK；Worker 不呼叫 proof body 的 `arrayBuffer()`、Blob、tee、WebCrypto digest 或 JS chunk hash。錯誤 checksum 與 storage failure 返回可重試的 sanitized 502；不宣稱一定是哪種 upstream 失敗。

complete 使用 R2 HEAD 的 checksum；沒有 SHA 的舊 staging object 拒絕且不因缺 SHA 而刪除。0012 新增 `proof_upload_checksums`，在完成上傳的同一 D1 batch 綁定 SHA／ETag／size／session manifest。公眾回應隱藏 SHA。建案先條件 GET 捕捉完成時的 ETag，核對已保存 SHA 與 R2 checksum，再以同一 native stream 與 checksum 寫入私人 archive；使用 archive 回傳的驗證值，案件／proof／exact hash／consumption／idempotency 同一 D1 transaction。GET 是既有私人歸檔所需，沒有額外 GET 用來雜湊。

既有 MIME 機制是允許 PNG／JPEG／WEBP、精確 Content-Type／副檔名及 R2 實際 metadata；既有流程沒有伺服器圖片解碼或 magic-byte parser，本次未移除任何檢查。前端仍一圖一案、最多 20 筆依序；backend 原有每案最多 5 個檔案、每檔 5 MiB／每案 25 MiB 保留。

歷史已建案件仍可 query／review；未完成的舊 staging session 在未來 rollout 後須重新 prepare。舊成功案件的 Idempotency-Key replay 仍回同一收據。現有 R2 清理／lost-D1-ACK 政策保留：只清理本次私人 copies，無法判定是否已提交時保留 archive；上傳中斷可留下不可完成的 staging object，沿用既有技術恢復與生命周期政策，不新增掃描或刪除。

## 真實隔離 CPU 證據

所有雲端測試只使用新建 Worker／R2／D1、合成 PNG、合成會員及官方 Turnstile 測試 secret；測試 envelope 另有私人認證。正式 API source 與 auth／CSRF／MFA／D1／R2／Drive enqueue 全部實際執行。

舊完整流程 120 requests／78 CPU traces。5 MiB 建案：min 20、median 22、p95 30、max 30 ms。控制組 5 MiB：讀取 5–9 ms、讀取＋SHA 7–19 ms、buffer copy 4–23 ms、stream copy 1–2 ms。非同 invocation 的控制組只能提供統計差異，不能將 16 ms 完全歸因於某一函式。

新流程 429 requests／333 CPU traces，68 個獨立案件，包含四種大小各 12 次完整流程、same／cross member evidence、重試、錯誤 checksum 與 20 筆混合批次。下列為完整 **建案 HTTP request** CPU，不是所有 endpoint 混在一起的平均：

| Bytes | CPU traces | min | median | p95 | max（ms） |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 13,082 | 11 | 9 | 13 | 23 | 23 |
| 262,144 | 12 | 10 | 13.5 | 16 | 16 |
| 2,097,152 | 12 | 9 | 12 | 15 | 15 |
| 5,242,880 | 12 | 8 | 10.5 | 14 | 14 |

所有新 endpoint 的可取得 CPU trace：min 1、median 3、p95 13、max 23 ms；`exceededCpu` outcome 0 不代表 Free 有安全餘裕。5 MiB PUT 13 samples：min 2／median 2／p95 6／max 6 ms；complete 13 samples：2／3／6／6 ms；Admin evidence 12 samples：3／5／9／9 ms；replay 12 samples：1／2／3／3 ms。5 MiB 建案 platform wall time：1056／1482.5／3138／3138 ms，與 CPU 分開記錄。

一筆正常會員建案：13 D1 statements、R2 GET 1／PUT 1／DELETE 1。prepare：D1 1；PUT：D1 1／R2 PUT 1；complete：D1 6／HEAD 1；Admin evidence：D1 6；replay：D1 2。此為應用層 SQL statement 計數，不把 trigger 的內部操作假稱為額外 D1 requests。

追加組件 probe：JSON parse 約 1 ms；parse＋真實會員／CSRF／idempotency 2–5 ms；5 MiB preflight 4–5 ms；累積 preflight＋stream archive＋本次 copy cleanup 6–12 ms。13 次順序 D1 讀取控制組 7–14 ms，單 D1 batch 13 statements 控制組 1–5 ms。這些為不同請求的統計控制，不是同請求的精確 CPU profiler。證據指出固定建案／D1 往返與 metadata/auth 成本，並非 proof body SHA。下一階段應在不破壞原子提交與 auth 的前提下減少順序查詢與 binding 往返，再量測完整請求。不得依賴平台偶發容忍 >10 ms。

來源檢查及 5 MiB 真實路徑證明 Worker 沒有 JS 整檔 buffer／copy／tee，且沒有記憶體超限 outcome；平台 tail 不提供本次 heap peak，因此沒有宣稱量得峰值低於 128 MB。128 MB 安全評估基於順序串流與有界 metadata，不是偽造的記憶體量測。

## 歷史 34 筆 backfill 設計

舊寫入沒有送 SHA；真實隔離舊寫入 HEAD 有 MD5、沒有 SHA。Production 的既有 metadata／Drive manifest 沒有可用的可信 SHA 證據，本次沒有讀取任何 Production proof body，也沒有為了查 checksum 把 Production bucket 綁到測試 Worker。不可把 ETag／MD5、任意 customMetadata 或 Drive 檔案 checksum 改稱 SHA-256。

優先選擇一次性、受信任操作員 resumable 工具：固定 34 筆批准 manifest（file ID／key／ETag／size／MIME），私密讀取原 R2 條件 GET，在本機串流 SHA，讀前／讀後核對來源版本。先 dry-run；每次最多一筆或小批。未來回寫需獨立批准、受保護的 MFA／operator identity 或專用 hash-job callback、allowlist 與 transaction guard；唯一 file ID 使 lost ACK／重啟續跑冪等。不得公開 digest 或任意查 hash。此工具尚無 Production writer。

隔離證明已使用真實舊 R2 proof，Worker 只串流、本機 Node 計算 SHA，與先前獨立 hash 相符；兩次讀取相符，模擬遺失 hash 後兩次寫入只有一筆最終 hash、案件／點數不變，無認證讀取 404。這證明傳輸／本機計算／metadata 綁定／續跑，但**不證明惡意受信任 writer 的任意 digest 正確**。來源 metadata guard 本身不能密碼學驗證 callback。受信任 backfill 計算者屬明確額外信任邊界，與新上傳的 R2 bytes verification 不同。

私人 Apps Script 可用 `Utilities.computeDigest(SHA_256, bytes)`；若未來採用，應另設 hash-job 類型與 secret、限定 lease／nonce／file ID／version／演算法／size／ETag、回寫時核對 job state、來源 HEAD 與來源不可變；一筆／次、callback transaction 與 replay readback。不得擴充現有 backup complete 為可接受任意 SHA 的通道，也不得把既有 relay secret 授予案件／點數／任意 proof 寫入。已完成 Drive copy 只能當交叉核對，主來源仍是原私人 R2 bytes。script editor／script properties／備份帳號若被控制，callback 可造假，需把它視為受信任計算服務；不是 R2 重新驗證原歷史 bytes。

Apps Script 一次執行 6 分鐘、免費帳號 trigger runtime 90 分鐘／日、UrlFetch 20,000 calls／日、response 50 MB；5 MiB 單檔在 payload 限額內，但實際 runtime、配額與二進位轉換須在隔離專案驗收，不對目前健康的 Production backup 觸發器加工作。本次沒有執行 Apps Script 歷史 hash、沒有增設排程。34 筆一次性操作員工具更容易限制權限與留下驗收紀錄，因此目前推薦此設計而非直接 piggyback backup。

官方依據：[R2 Workers checksum API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)、[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、[Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)、[Utilities digest](https://developers.google.com/apps-script/reference/utilities/utilities)。
