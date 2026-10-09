# B4.x.1：Production password-KDF feasibility assessment

評估日期：2026-10-09。只做本機隔離 benchmark；正式 auth、schema、Wrangler、首頁及其他 B3/B5 功能均未修改。沒有 push、部署或 remote migration。

## 決策

- **Option A，建議採用：保留 scrypt N=32768 / r=8 / p=3，使用 Workers Paid。** 此參數符合 OWASP 列出的 scrypt 最低配置之一。Paid 的 CPU 預算足以容納目前 KDF；這是 runtime feasibility 結論，仍須將完整 auth request 的 CPU、並發記憶體與登入流量納入正式上線驗收。
- **Option B：原生 PBKDF2-HMAC-SHA256 600k 可作後續候選，這次不切換。** 本機速度與目前 scrypt 接近，較省記憶體，但沒有 scrypt 的 memory-hard 防護；600k 只是符合 PBKDF2 的 OWASP 參考值，不代表兩個演算法有量化相等的抗破解能力。Production iteration 限制另需驗證，見下文。
- **Option C：目前直接在 Worker 內計算 password KDF 的帳號密碼方案，判定與 Workers Free 的 10 ms CPU 預算不相容。** 已測配置沒有任何同時滿足安全要求與該預算的方案。100k～300k 不可宣稱與 600k 或目前 scrypt 等價；不降參數、不使用 fast-hash verifier，也不把 KDF 拆成自製 workaround。

[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)：Free 10 ms；Paid 預設 30 秒、可設定至 5 分鐘。兩者均為 128 MB / isolate。網路等待不計 CPU，但執行 native cryptography 不等於網路等待；`await crypto.subtle` 不能當作免 CPU 的證據。

## 重現方法

```sh
npm run benchmark:password-kdf
```

- `scripts/password-kdf-benchmark.mjs` 啟動獨立 Miniflare/workerd，沒有正式 API route、D1/R2、`.dev.vars` 或 Production credential。
- scrypt 直接呼叫既有 `passwordRecord` / `verifyPassword`，參數不變。PBKDF2 測試模組只在 scripts 中，使用 workerd 原生 `crypto.subtle.importKey` / `deriveBits`。
- 兩者均納入與正式 auth 相同的 pepper HMAC 前處理；pepper/password 在每組開始時隨機產生，只存在暫存 runtime，不輸出或保存。HMAC 後仍有真正 KDF，不是 HMAC password verifier。
- 每個演算法／參數使用新的 workerd process；hash 與 verification 各 warmup 5 次、量測 40 次，序列執行。verification 使用預先建立的 record，只做一次 KDF；不把「hash + verify」誤當驗證成本。
- median 是第 20/21 筆排序樣本平均；p95 是 nearest-rank 第 38 筆。沒有 performance pass/fail assertion，也沒有加入 `npm test`。
- 正確／錯誤密碼驗證均檢查。每組 PBKDF2 在計時外與 Node crypto 參考輸出比對；Node crypto 未參與 workerd 的計時運算。

## 本機環境及結果

Windows x64，Intel Core i5-13420H；Node v24.21.0，workerd 1.20261006.1，Miniflare 5.20261006.1-alpha，Wrangler 4.149.0。compatibility date `2026-10-07`。16-byte 隨機 salt、32-byte derived output。

原始安全統計／樣本見 `password-kdf-benchmark.json`，沒有 hash record、salt、password、pepper 或本機絕對路徑。

| KDF | Hash median / p95 ms | Verification median / p95 ms | Workerd CPU mean，hash / verify ms |
|---|---:|---:|---:|
| scrypt N=32768 r=8 p=3 | 232.48 / 248.90 | 230.45 / 250.15 | 221.88 / 219.14 |
| PBKDF2-SHA256 100k | 38.53 / 43.31 | 38.49 / 41.62 | 36.72 / 36.72 |
| PBKDF2-SHA256 200k | 74.84 / 83.95 | 74.39 / 82.38 | 75.39 / 71.88 |
| PBKDF2-SHA256 300k | 111.48 / 118.70 | 111.36 / 118.68 | 107.03 / 107.81 |
| PBKDF2-SHA256 600k | 220.41 / 230.09 | 221.88 / 233.49 | 214.06 / 214.06 |

先前 5 次 hash median 約 214 ms；這次 warmup 後 40 次 median 約 232 ms。不同樣本數、機器負載／溫度、GC 會影響結果，不代表正式 implementation 改變。

**計時限制：** median/p95 是 Node host 量到的 dispatch → 讀完 response wall time，包含本機 IPC、HMAC、JSON/comparison，不是 Production billed CPU median/p95。CPU 欄為專用 workerd 子程序的 Windows `TotalProcessorTime` 批次差值除以 40；不含 Node/PowerShell CPU，但含本機 runtime／背景 GC，且 OS counter 有解析度限制。不得將它直接等同 Cloudflare billed CPU。沒有部署，故沒有 Production CPU metrics。此 benchmark 也不是完整 register/login HTTP 流程測試。

| KDF | Baseline process RSS MiB | Peak process RSS MiB | Peak − baseline MiB | End private bytes MiB |
|---|---:|---:|---:|---:|
| scrypt | 47.40 | 121.58 | 74.18 | 108.09 |
| PBKDF2 100k | 47.36 | 53.42 | 6.06 | 43.98 |
| PBKDF2 200k | 47.38 | 53.23 | 5.85 | 43.86 |
| PBKDF2 300k | 47.53 | 53.11 | 5.59 | 44.46 |
| PBKDF2 600k | 47.48 | 53.09 | 5.61 | 43.64 |

**記憶體限制：** 這是整個 fresh workerd process 的 OS counters，包括 runtime、Miniflare 的內部 isolates、JIT、GC 與多次 allocation，並非單次 KDF peak 或 Workers isolate 的 128 MB 使用量。scrypt 主工作陣列為 `128 × N × r = 32 MiB`，p=3 重用陣列，另外有小 buffers／GC 成本。PBKDF2 沒有隨 iterations 放大的 memory-hard 工作陣列；表中的約 6 MiB 差值不能宣稱為 PBKDF2 本身的 workspace。Paid 不會提高 isolate 的記憶體限制。

## Native implementation 與 Production 相容性

全部四组 PBKDF2 使用未替換的 workerd WebCrypto，`deriveBits` 為 native function，正確性參考比對全部通過；沒有 JS/WASM PBKDF2 polyfill。scrypt KDF 本體則是現有 `@noble/hashes` JavaScript，前處理 HMAC 與驗證比較仍用 WebCrypto。

[Cloudflare WebCrypto 文件](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)列出 PBKDF2 的 importKey／deriveBits／deriveKey 支援；[workerd PBKDF2 C++ source](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/crypto/pbkdf2.c%2B%2B) 顯示 native `ncrypto::pbkdf2Into` 呼叫，並先經過 iteration limit enforcer。

**本機能跑 600k 不證明 Production 能跑 600k。** [IsolateLimitEnforcer](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/limit-enforcer.h) 的預設 PBKDF2 ceiling 為 100,000，允許 implementation override；[standalone workerd server](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/server.c%2B%2B) 的實作取消該 iteration ceiling，因此本機四組均成功。這次未對 Production 作 probe，不能確認託管 Workers 的 override／上限，也不能宣稱 Paid 自動解除 PBKDF2 iteration ceiling。若未來考慮 Option B，必須先在獲准的目標環境驗證單次 native 600k derivation、CPU、memory 與完整登入成本；若 600k 被拒絕，不能退回 100k 當安全等價替代。

## 安全／維護比較

| 面向 | 現有 scrypt | Native PBKDF2-SHA256 |
|---|---|---|
| Work factor | N=2^15,r=8,p=3，OWASP 列出的 scrypt 配置 | 600k 是 OWASP SHA256 參考值；100k/200k/300k 只量測，未採用 |
| Offline cracking | CPU + memory 成本；memory-hard 增加大量並行猜測成本 | 主要是 CPU 成本，較適合攻擊者 GPU/ASIC 並行，沒有 memory-hard 特性 |
| Maturity | 成熟標準 KDF，使用既有 Noble implementation，現有測試覆蓋 | 成熟標準 KDF，Cloudflare native crypto provider，减少 JS implementation 負担 |
| Workers | 現有 JavaScript KDF 本機相容，工作陣列受控 | Native API 相容；Production iterations/policy 仍須確認 |
| Memory | 32 MiB 主工作陣列，加 runtime／GC | 小型固定 workspace，明顯較低 process memory |
| Migration | 保留 record v1，不需改 DB 或正式 auth | 需 algorithm dispatch、參數驗證、dual-read 與成功登入後 rehash；不能直接把既有 hash 轉成另一 KDF |

[OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) 的配置要求及記憶體防護是決策依據。pepper 不取代安全 KDF；native speed 不代表等價抗破解。也沒有以 native implementation 推論 FIPS certification。

## Password record versioning 檢查

現有 `member_credentials.password_record` 是受 `json_valid` constraint 保護的 JSON TEXT，已保存：

- `algorithm: scrypt`
- `version: 1`（hash format version）
- `N`, `r`, `p`
- `salt` 與 `hash`

所以 **不需要 schema migration** 即可保存未來 algorithm/parameters/salt/hash version。dkLen=32 目前由 v1 contract 定義，日後可明確加入 JSON。不要將獨立的 `member_credentials.version`（安全狀態 CAS version）誤認為 hash format version。

**目前未實作自動 rehash**：`verifyPassword` 僅接受現有 exact v1 algorithm/parameters。若未來升級，最小設計是 server-controlled 的合法舊／新 algorithm+parameter allowlist、bounded parameter validation、`needsRehash`，成功密碼驗證後以新 salt 建新 record，CAS 更新 exact 舊 record，並尊重既有 credential/MFA concurrency。密碼 rehash 與安全狀態 version 的相互作用需要測試，不應順手更改 TOTP／session semantics。首次升級登入有舊驗證 + 新 hash 的雙 KDF 成本，應計入 Paid CPU 預算。這次只提出設計，不改 auth。

## 本機驗收與範圍

- 五組 benchmark 全部成功；每組正確密碼通過、錯誤密碼被拒絕，PBKDF2 native/reference 比對通過。
- `npm test`：502 / 502 通過，0 fail / skipped。benchmark 未混入正常 test discovery。
- 新增／修改的五個檔案通過敏感字面值掃描、JavaScript syntax check 與 `git diff --check`；正式 `src`、migrations、首頁、Wrangler 與 lockfile 均無 diff。
- 只新增獨立 benchmark、量測結果與此評估文件，以及 package command；不需改/amend 目前 B4.x commit。
- 沒有新增 Secret／Variable／migration，也沒有存入本機產生的 credential。
- 保留 scrypt 為建議最終 KDF；Workers Paid 是此架構的上線前置條件。Production load/CPU 驗收仍留待獲准的發布階段。
- Git：main 比 origin/main 領先原有 6 個 commits；本次 1 modified + 4 untracked，尚未 commit。
