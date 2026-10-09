# B5D Member Tier（本機 checkpoint）

只做 backend/schema/API，本機驗收與 commit；不 push/deploy/remote migration、不改 Production、B4.x auth另見會員文件、不做 UI 或正式徽章、不進 B6。
沒有新增 Secret/Variable、auth provider、點數倍率、RBAC 規則或 leaderboard 排序規則。

## 固定 identities / migration

新增 `0007_member_tiers.sql`，0001..0006 不改。
`member_tiers`：tier_id PK、name、rank_order UNIQUE、min_points nullable UNIQUE、icon_key、active/disabled、timestamps/nullable actor FKs/version/private mutation marker。

| tier_id / icon_key | name | rank_order | migration min_points / status | 概念視覺（未製作 asset） |
| --- | --- | --- | --- | --- |
| normal | 普通 | 1 | 0 / active | 灰色簡潔圓徽 |
| bronze | 青銅 | 2 | null / disabled | 青銅盾牌 |
| silver | 白銀 | 3 | null / disabled | 銀色幾何盾徽 |
| gold | 黃金 | 4 | null / disabled | 金色盾徽 |
| platinum | 白金 | 5 | null / disabled | 冰藍白金晶體 |
| emerald | 翡翠 | 6 | null / disabled | 綠色翡翠晶體 |
| diamond | 鑽石 | 7 | null / disabled | 藍色鑽石晶體 |
| stellar | 星耀 | 8 | null / disabled | 紫金星芒最高級徽章 |

Migration 只 seed 已批准的 identity 和普通0，不替其餘七階決定正式 threshold。
SQL NULL 表示未設定，不是0或unlimited。SQLite UNIQUE 允許多個NULL，但不允許重複已設定門檻。
名字/rank/icon/id 全部是固定 identity，DB CHECK + trigger 不允許改動、刪除/REPLACE 或第九級。
普通永遠 active、0；active 必須有 min_points；threshold 必須 integer0..1,000,000,000（技術輸入上限，不是正式門檻）。
跨 row triggers 強制所有已設定 threshold 按 rank_order 嚴格增加，**包含 disabled tiers**，防止之後 re-enable 才暴露倒序。
Nullable actor 只用於 migration identity seed，正常 update actor 來自 verified session。
固定8列不需要額外全域index；PK/rank_order/min_points UNIQUE 索引足夠。

0007 以複製原 audit rows 的方式擴充 `member_tier_update` / `member_tier` enum，再重建原 indexes/append-only 保護；既有 audit/run/ledger 不改、不清除。
本機升級測試保留既有 B5C published pointer/run/audit；新 seed 外沒有假會員、Campaign 或業務資料。

## Configuration readiness / disabled policy

Ready = 精確8個固定identity、普通active/0、所有8階都有合法已設定 threshold、全體門檻嚴格增加。
其他階可以 disabled，仍須先設定其門檻才能把整套標為 ready。
本機／未來 Production 剛套0007時 ready=false。

Admin list 提供 `configuration_ready`；Member/admin points 提供 `tier_configuration_ready`。
設定未完成（含部分門檻已設定）時：安全回普通、next_tier=null、points_to_next_tier=0、tier_progress=0、ready=false，保留真實 ledger total_points。
Caller 必須看 readiness，不能把 pending 的 next=null 當成已到最高等級。
完整設定後只在 active tiers 之間升級；disabled 是暫停資格，不是 archived，門檻保留且可重新啟用。
普通不可 disabled；沒有 archived/delete tier API。
API 不允許把已設定門檻改回null；沒有任意新增 tier/手動指定 member tier 的 API。

Missing/不完整 definitions 在 central resolver 亦回普通/ready=false，不因無資格tier產生500。
真正 DB 失敗或 migration 未存在回既有 sanitized503/no-store，不把儲存故障假裝正常configured。Production 發布前仍須先完成正式 migration 與明確配置。

## Source / dynamic resolution / progress

唯一來源：`SUM(point_transactions.points)` + current member_tiers definitions。
沒有 members.tier_id/total_points source、tier cache、lifetime XP、tier XP、promotion transaction 或 tier history。
`memberPointTier` 用單一 prepared SELECT 同時讀 ledger aggregate 和8列definitions，讓 points/config 来自同一 DB query snapshot，不做每級/每會員 N+1 query。
`resolveMemberTier(totalPoints, rows)` 是共用、可注入測試的純policy：

1. 檢查 safe integer total 和 configuration readiness。
2. tier selection 使用 effective_points=max(total_points,0)，在active tiers中取最高符合 min_points 的rank。
3. next取下一個active rank，disabled直接跳過。

Tier不是admin role、leaderboard rank或Campaign。星耀沒有管理權，普通admin照常管理；tier不改投票獎勵。
正 adjustment/award 可能升級；negative adjustment/revoke 可能降級。Completed無新交易，因此不影響tier。
Threshold調整即時按新定義重新resolve；不回改ledger，不保證保留「曾達最高級」。

Progress：`(effective_points-current.min_points)/(next.min_points-current.min_points)*100`，四捨五入至2位小數，再clamp0..100。
門檻嚴格遞增使分母>0。已達最高active tier（含星耀）next=null、distance=0、progress=100。
Next deficit=`max(next.min_points-total_points,0)`；負點數仍需先賺回差額，只有tier selection/progress以0為底，不清空負balance。
極端負safe integer下，顯示deficit最多Number.MAX_SAFE_INTEGER，避免JSON輸出不精確整數；正常範圍為精確差距。
Pending configuration的progress=0，與terminal100不同。

## Member / admin API contract

擴充既有兩條GET：

- `/api/me/points`：active authenticated owner。
- `/api/admin/members/:memberId/points`：admin/super_admin，指定既有會員。

保留 `total_points`，增加：

```json
{
  "ok": true,
  "data": {
    "total_points": 300,
    "tier": { "tier_id": "bronze", "name": "青銅", "icon_key": "bronze", "rank_order": 2, "min_points": 100 },
    "next_tier": { "tier_id": "silver", "name": "白銀", "icon_key": "silver", "rank_order": 3, "min_points": 500 },
    "points_to_next_tier": 200,
    "tier_progress": 50,
    "tier_configuration_ready": true
  }
}
```

**以上100/500是明確的本機範例門檻，不是正式設定。** Fixtures只存在 scripts/lib/local-tier-fixture.mjs/tests。
不另開/api/me/tier，不讓points與tier不同來源。所有member/admin response no-store，不回email/player_id/auth/session/admin role/internal member id/marker。

`GET /api/admin/member-tiers` → `{tiers,configuration_ready}`，admin/super_admin only；回完整config metadata，private marker除外。
`POST /api/admin/member-tiers/:tierId/update` → 更新row，200；body：

```json
{ "min_points": 100, "status": "active", "expected_version": 0, "reason": "明確批准的門檻調整原因" }
```

Body欄位固定，只允許min_points/status/version/reason，名字/icon/rank/id不可改。Reason必填trim後1..500且不含控制字元。
Reviewer/member/Guest不可管理；verifiedsession＋RBAC、exact Origin/CSRF、16KiB JSON上限、prepared statements。
Unknown tier 404 TIER_NOT_FOUND；invalid body 400 INVALID_TIER_REQUEST；stale/global ordering/普通限制409 TIER_CONFIG_CONFLICT。

Update前讀全套已設定門檻；在同一D1batch內重新驗 actor/session/member/role、row version、normal/8列、全體ordering；成功UPDATE version+1，再appendaudit、回結果。
不同row的交叉競爭以transaction內conditional UPDATE＋DBtriggers保證不倒序；同row CAS只有一個winner。
Audit action member_tier_update，记录actor/tier_id/old/newmin/status/version/reason，不包含authcredentials。
Audit失敗整批回滾；storagefailure sanitized503 TIER_SERVICE_UNAVAILABLE，不logexception或env。Ack遺失只按本次randommarker查已提交結果。
Member自然升降級不另寫AdminAudit；原點數操作仍沿用B5B既有audit。

## Leaderboard / visual boundary

B5D **不擴充**public leaderboard rows。B5C既有fields、ranking/snapshot內容与cache完全保持。
本次tier config update前後，同一leaderboard response byte-equivalent測試通過；沒有badgeN+1 query。
未來前端需要badge時優先採方案A：batch讀各會員目前全ledger net/currenttiers，再加optionalfields；不能用scoped snapshot points推算全會員tier。
不把tier當ranking tie-break，也不讓新threshold回寫歷史run。本次不開始frontend接線。
icon_key只回固定安全token，沒有假的SVG、emojiasset、路徑輸入或正式圖檔；附圖只作概念參考。

## Verification / files / rollout TODO

本機验收包含 npm test、B1～B5D八套smoke、空DB0001..0007、FK/quick_check/schema/31triggers、敏感值scan與Wranglerdry-run。
結果：486/486 tests（既有434＋新增52），八套smoke通過；Wranglerdry-run137.30KiB/gzip32.56KiB；92個repository檔案敏感值scan無發現。
新identity seed已明確批准，但七個正式threshold仍未定義；schemachecker分別回報8 identities、7 nullthresholds、ready=false與0業務fixture。
首頁、wrangler.jsonc、lockfile、0001..0006、當時auth、B5Cquery/ranking/store保持原樣。

修改8檔：README.md、package.json、scripts/check-admin-schema.mjs、scripts/smoke-points.mjs、src/api/admin-validation.js、src/api/points.js、src/api/router.js、test/campaign-points.test.js。
新增7檔：docs/b5d-member-tiers.md、migrations/0007_member_tiers.sql、scripts/lib/local-tier-fixture.mjs、scripts/smoke-tiers.mjs、src/api/member-tiers.js、src/lib/member-tier.js、test/member-tiers.test.js。

TODO：由你決定七個正式threshold，再於日後已批准的Productionrollout透過verifiedadmin/backend或明確bootstrap配置、確認ready=true。
目前沒有Productionadminbootstrap/remoteapply/UI；B4.x auth尚需正式rollout驗收。
後續badgebatchintegration、正式assets、highest-ever/history/honorarytiers另開規格；本次不做，亦不進B6。
