# 核准會員等級 artwork

本機 artwork gate，基準 commit：`e71fdbd944121018f5388f1885f53b4e299e5a75`。原基準尚未含本圖，會員等級使用簡化標記；本次只整合核准圖片與前端呈現，不修改 backend/schema/權限或投稿設定。

## 唯一圖片來源與裁切

Operator 提供的 `codex-clipboard-fcaa2e90-d0a1-40e7-ad1a-c06484f92b79.jpg`，1122×1402 RGB。

來源 SHA256：`c3c6ec436438f9bca022e043cacc682e6751ce141b8f64bafafa51c61ff7a996`。

直接從 decoded 原圖裁切，無重繪、AI 替換、背景移除、色彩調整、resampling 或放大。輸出無損 WebP；八張重新 decode 後與相應原圖裁切逐 pixel 完全一致。保留徽章、光暈與裝飾，避開圖片內中文名稱，讓 HTML 呈現實際 API 名稱。

裁切座標以原圖左上為原點，右／下界不含端點。

| Backend ID | 名稱 | Asset | 原圖 crop (left, top, right, bottom) | 像素 |
| --- | --- | --- | --- | --- |
| normal | 普通 | public/assets/tiers/normal.webp | 64,14,526,255 | 462×241 |
| bronze | 青銅 | public/assets/tiers/bronze.webp | 610,14,1072,255 | 462×241 |
| silver | 白銀 | public/assets/tiers/silver.webp | 64,342,526,596 | 462×254 |
| gold | 黃金 | public/assets/tiers/gold.webp | 610,342,1072,596 | 462×254 |
| platinum | 白金 | public/assets/tiers/platinum.webp | 64,678,526,942 | 462×264 |
| emerald | 翡翠 | public/assets/tiers/emerald.webp | 610,678,1072,942 | 462×264 |
| diamond | 鑽石 | public/assets/tiers/diamond.webp | 64,1010,526,1310 | 462×300 |
| stellar | 星耀 | public/assets/tiers/stellar.webp | 610,1010,1072,1310 | 462×300 |

八張共 935,496 bytes。只加入分離 assets，未部署來源 composite 或本機截圖。

## 呈現與安全

唯一 production mapping：`public/js/tier-artwork.js`。`tier_id` 對應核准 art；不依 points、名稱、外部 URL 或 client role 推算。未知 ID 不顯示圖片，不替換成普通或其他徽章。圖片載入失敗移除 broken image，保留實際等級文字。

會員中心：`/api/me/points` 的真實 `tier.tier_id` 與 `tier.name`，顯示「目前等級：…」。管理等級：既有 admin API 的八個 rows；disabled 仍保留原圖與「未啟用」，沒有新增或預填門檻。

既有 leaderboard snapshot contract 只有排名、會員編號、暱稱、points、proof_count、reached_at，沒有 tier_id。排行榜本次不加徽章、不推算、不額外請求 identity/tier。

圖片直接相鄰等級文字時使用 `alt=""` 與 `aria-hidden="true"`，避免重複朗讀；可重用 helper 的 standalone 模式使用「普通等級」到「星耀等級」描述。width/height 為原始像素，CSS 維持 height:auto，會員圖最大 260px、管理圖最大 220px，不拉伸。

同站 asset 在既有 `img-src 'self'` 下使用；沒有 CSP 放寬、inline script/style 或新的外部圖片來源。

WebKit 會對既有原生 select 的內部樣式回報 `style-src-attr`（以單獨建立原生 select 重現）；不是徽章圖片或新增 inline style。測試先完成既有管理頁初始化，再檢查 artwork 畫面沒有新增 CSP 事件；既有 script CSP 與 DOM 無 inline style 的檢查繼續保留。

## 本機驗收

驗證八個 identifier 與 immutable backend schema 一致、無損 WebP 尺寸、未知 identifier fail gracefully；browser 驗證實際 decode、會員各等級、八張 admin 圖及 disabled/null threshold、broken-image fallback、可及性、desktop/320/390/430px、深淺色、不溢出與 CSP。

已通過：755 個 unit tests（含 55 個 frontend unit tests）、429 個完整 browser tests（含 36 個 artwork tests）、Member/Admin 真實 Worker 本機 smoke、八張原圖 crop pixels 比對、Wrangler dry-run、public assets 與 sensitive scan（195 個 reviewable Git files，0 findings）。最終 commit 見本次完成回報。

Production、新會員權限、tier thresholds 及 submissions_enabled 均未操作。前端部署仍須另行授權，之後再做實機 smoke；本次手機尺寸檢查是瀏覽器測試，不宣稱新增實機驗收。
