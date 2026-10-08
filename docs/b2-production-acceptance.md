# B2 Production 驗收

只驗收 B2，不開始 B3，不變更 Dashboard、binding、secret、CORS 或 public access。
在 repository 根目錄執行以下命令。報告只記錄狀態；不要把 token、signed URL、Access Key 或任何 Secret 寫入 Git／聊天。

## 本機與部署

```powershell
npm.cmd test
npm.cmd run test:smoke
npm.cmd run test:uploads-smoke
npm.cmd run check
```

commit／push 後等 Cloudflare Git deployment 完成。用 `wrangler deployments list` 查看最新版本與時間；Production uploads GET 必須由舊版 404 變成 405，才開始 live upload tests。

## A／B／D：無 token 的 HTTP 驗收

```powershell
node scripts/production-smoke.mjs
```

此腳本執行 15 項 live checks：B1 health、campaigns、leaderboards、首頁 bytes、未知 API；兩個 uploads GET；prepare 缺 token、無效 token、超過 5 個檔案、超過 16 KiB metadata、SVG；complete 不存在、不同 session、traversal。
預期全部 PASS。此腳本不寫入 R2，也不輸出 response body 或憑證。

## B／C／D：正常 Turnstile 與瀏覽器直接 PUT

1. 在 Chrome 開啟 `https://voteproof.i-dle-melon.workers.dev/`。
2. F12 → Console，貼入 `docs/b2-production-console.js` 的完整內容。
3. 執行：

```javascript
voteProofB2.run(prompt("Production public Turnstile Site Key"))
```

只輸入公開 Site Key；不輸入 Secret Key。Script 僅暫時在目前分頁載入官方 widget；若要求人機驗證，請手動完成。沒有新增網站測試頁，也沒有修改首頁檔案。
正常 token 直接提交到 prepare，由正式 Worker Siteverify；圖片由 canvas 產生無個資的真實 1px PNG。
腳本測試 5 個 server staging keys、300 秒參數、Content-Type signing、正確 PUT／CORS ETag、正常 complete、錯誤 Content-Type、不存在／不同 session、實際超限刪除及混合批次。
R2 拒絕測試必須讀到真正 HTTP 403；CORS network error 不當作簽名測試成功。
保持分頁開啟約 5 分鐘，等 `PUT rejected after 300 seconds` 顯示 PASS。

可重新列出安全報告：

```javascript
console.table(voteProofB2.report())
```

### PUT URL 不能作為公開 GET URL

在簽名有效期間，Console 執行：

```javascript
copy(voteProofB2.getPutUrl())
```

在 PowerShell 執行下列命令，URL 由 clipboard 透過 stdin 傳入，不印出也不存入檔案：

```powershell
Get-Clipboard | node --input-type=module -e 'let u=""; for await (const c of process.stdin) u+=c; const url=new URL(u.trim()); const signed=await fetch(url,{headers:{"Content-Type":"image/png"}}); url.search=""; const anonymous=await fetch(url); console.log({signedPutUsedAsGet:signed.status,anonymousGet:anonymous.status}); if(signed.status!==403 || anonymous.status!==403) process.exitCode=1;'
Set-Clipboard -Value ''
```

預期兩個 GET 都是 403。直接跨來源 fetch 在瀏覽器可能被 CORS 阻擋，不能單靠該錯誤宣稱 bucket private。

## D：實際不允許 MIME 與混合批次刪除

```powershell
node scripts/production-r2-validation.mjs
```

需本機 Wrangler 已登入且有該 bucket object 權限。此腳本透過現有 Wrangler 管理權限建立新的 UUID staging 測試物件，包含實際超限及 `image/svg+xml` metadata；它刻意從管理端造出異常物件以測 HEAD／delete，沒有停用 Turnstile，也不代表正常 presigned upload 成功。
正常已存在物件應 200；超限／不允許 MIME 應 400 `UPLOAD_VALIDATION_FAILED`；刪除後再次 complete 應 400 `UPLOAD_INCOMPLETE`；混合批次不能回 success。
結束時只清除該次生成的測試 keys，預期 cleanup 全 PASS，不操作其他物件或 bucket 設定。

## E：設定、logs 與瀏覽器測試物件清理

- Dashboard → R2 → voteproof-proofs：確認 public access／Public Development URL 未啟用，沒有公開 custom domain；CORS origin 只允許 Production origin。
- Dashboard → Worker → Logs：執行驗收期間檢查 app logs，應無 secret、token 或 signed URL。本次原始碼沒有新增 console logs；Dashboard 的收集設定與歷史 logs 仍需另行確認，勿將包含憑證的原文貼入聊天。
- Browser Console 執行 `copy(JSON.stringify(voteProofB2.getCleanupKeys()))`，在 PowerShell 清除**本次測試**的 staging keys：

```powershell
$vpKeys = Get-Clipboard | ConvertFrom-Json
foreach ($vpKey in $vpKeys) {
  if ($vpKey -notmatch '^proofs/staging/\d{4}/\d{2}/\d{2}/[0-9a-f-]{36}/[0-9a-f-]{36}\.png$') { throw 'Unexpected test key' }
  npx.cmd wrangler r2 object delete "voteproof-proofs/$vpKey" --remote
}
Set-Clipboard -Value ''
```

只使用當次 console script 產生的 keys，不使用其他人的 object key。所有上傳都在 `proofs/staging/`，不提供 public URL。

安全限制：標準 SigV4 URL 中 `X-Amz-Credential` 包含 Access Key ID（已獲使用者同意），不包含 Secret Access Key。API schema／source review 與拒絕測試可檢查洩漏風險，不能用未知 Secret 的黑箱掃描保證所有平台 logs 從未包含憑證。

官方參考：[Turnstile widget](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/)、[R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)。
