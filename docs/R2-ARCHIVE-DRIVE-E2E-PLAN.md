# 真 Google Drive 隔離 E2E：PENDING，未登入／未安裝／未配置

這一份是下一輪另外授權的人工步驟，不能用新mock收據、本機Code.gs VM或舊空body結果代替。

1. 指定非正式、非正式會員的測試 Google 帳號。建立獨立私有測試 root／campaign／day folder，只放本App建立的1／3／5 MiB合成PNG；記錄已知SHA／大小／MIME／case與proof來源。不得指向正式root。
2. 獨立 Script 使用已審查 Code.gs 的 archive_verify 邏輯與新 Canary；Operator 親自完成最小必要OAuth／Drive API啟用、測試 Properties、Secret、測試 Web App 安裝。先列明實際 scopes；不需要Gmail權限、不設定Mail、不安裝Trigger。若需要超出drive.file讀取的權限，停止並另行說明，不自行擴權。
3. 隔離Worker、D1、R2與正式完全分離；這個真Drive測試不能沿用mock-only bundle，需用未注入mock的候選Worker router及真測試relayURL。測試部署需單獨核准；本輪沒有做。
4. A 必須真實重新讀Drive原bytes，校驗原始SHA256、大小、MIME、檔名、case/proof、folder/day/campaign/root、私有權限；回Worker只含短收據、nonce、timestamp、HMAC，不回圖片bytes。
5. A返回verification_ready而R2仍存在；B另一次HTTP用A的handoff，核對版本與占用後只刪合成R2；Drive檔案仍存在且備份紀錄confirmed，案件／積分／審核保留，audit不可變。
6. 反向驗收逐項單次：內容變更、相同大小不同bytes、錯MIME、錯身分／檔名、錯資料夾／root、公開權限、Drive unavailable、HMAC／timestamp／nonce不符、A證據過期、R2 version變更、匯出／reservation衝突。每項證明不刪除；不可由一次成功推定全部防護有效。
7. lost A ACK與lost B ACK各一次：保留持久Journal／D1 pin，不自動重試、不清claim、不改 audit。核對Drive仍在、R2實況、cold狀態與單一terminal audit，再提出恢復方案交Operator。
8. 舊maintenance caller及所有安裝者的Triggers清單需逐帳號提供證據。Script Journal不能替代這份清單；真Drive測試不代表全系統已能停機。
9. 完成後圖片API應410、UI顯示「已封存至 Google Drive」，ZIP含cold範圍應拒絕。**不測／不開發 Drive冷讀API、自動還原或cold ZIP支援**。
10. 保留去識別化receipt驗證／HTTP／D1狀態／R2操作／真Google執行證據；不輸出OAuth token、Secret、私人圖片內容或正式key。清理僅限這次授權建立的測試資源，另核對名稱／ID；正式一律不碰。

需要下輪具體授權：獨立測試帳號與Script／folder建立、最小OAuth、測試Web App部署、真Drive API讀寫合成檔、測試Worker與測試Secrets、有限合成R2刪除、故障注入與結束清理。這不是正式auto-cleanup授權，也不包含正式Trigger。
