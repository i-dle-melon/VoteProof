# 核准會員等級 artwork

目前使用 operator 提供的八張獨立 PNG（1.png～8.png），取代原本從合成圖裁切的徽章。本次只替換本機 assets 與圖片尺寸，不修改 backend/schema/權限、等級門檻或投稿設定。

## 圖片來源與對應

保留完整圖片、邊框、光暈與裝飾，無裁切、重繪、背景移除、色彩調整、resampling 或放大。原 PNG 以原始尺寸轉為無損 WebP；八張重新 decode 後與各自 PNG 逐 pixel 完全一致。HTML 繼續呈現實際 API 等級名稱。

| Backend ID | 名稱 | Asset | 原圖 | 原始像素 |
| --- | --- | --- | --- | --- |
| normal | 普通 | public/assets/tiers/normal.webp | 1.png | 1576×998 |
| bronze | 青銅 | public/assets/tiers/bronze.webp | 2.png | 1536×1024 |
| silver | 白銀 | public/assets/tiers/silver.webp | 3.png | 1536×1024 |
| gold | 黃金 | public/assets/tiers/gold.webp | 4.png | 1536×1024 |
| platinum | 白金 | public/assets/tiers/platinum.webp | 5.png | 1536×1024 |
| emerald | 翡翠 | public/assets/tiers/emerald.webp | 6.png | 1536×1024 |
| diamond | 鑽石 | public/assets/tiers/diamond.webp | 7.png | 1536×1024 |
| stellar | 星耀 | public/assets/tiers/stellar.webp | 8.png | 1536×1024 |

八張共 11,240,170 bytes。僅網站使用的 WebP 放入 public，不加入原圖所在資料夾的其他檔案。

## 呈現與安全

唯一 production mapping：`public/js/tier-artwork.js`。`tier_id` 對應核准 art；不依 points、名稱、外部 URL 或 client role 推算。未知 ID 不顯示圖片，不替換成普通或其他徽章。圖片載入失敗移除 broken image，保留實際等級文字。

會員中心：`/api/me/points` 的真實 `tier.tier_id` 與 `tier.name`，顯示「目前等級：…」。管理等級：既有 admin API 的八個 rows；disabled 仍保留原圖與「未啟用」，沒有新增或預填門檻。

既有 leaderboard snapshot contract 只有排名、會員編號、暱稱、points、proof_count、reached_at，沒有 tier_id。排行榜本次不加徽章、不推算、不額外請求 identity/tier。

圖片直接相鄰等級文字時使用 `alt=""` 與 `aria-hidden="true"`，避免重複朗讀；可重用 helper 的 standalone 模式使用「普通等級」到「星耀等級」描述。width/height 為原始像素，CSS 維持 height:auto，會員圖最大 260px、管理圖最大 220px，不拉伸。

同站 asset 在既有 `img-src 'self'` 下使用；沒有 CSP 放寬、inline script/style 或新的外部圖片來源。

WebKit 會對既有原生 select 的內部樣式回報 `style-src-attr`（以單獨建立原生 select 重現）；不是徽章圖片或新增 inline style。測試先完成既有管理頁初始化，再檢查 artwork 畫面沒有新增 CSP 事件；既有 script CSP 與 DOM 無 inline style 的檢查繼續保留。

## 本機驗收

驗證八個 identifier 與 immutable backend schema 一致、無損 WebP 尺寸、未知 identifier fail gracefully；browser 驗證實際 decode、會員各等級、八張 admin 圖及 disabled/null threshold、broken-image fallback、可及性、desktop/320/390/430px、深淺色、不溢出與 CSP。

本次原 PNG 與 WebP 逐 pixel 比對為 8/8 PASS。其餘測試結果見本次完成回報，不沿用先前部署測試數量當成本次結果。

本次僅本機修改；未 commit、push 或部署。Production、新會員權限、tier thresholds 及 submissions_enabled 均未操作；本次手機尺寸檢查是瀏覽器測試，不宣稱新增實機驗收。
