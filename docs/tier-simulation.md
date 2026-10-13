# Tier 決策預覽

這是本機 CLI 預覽，不連資料庫、不呼叫 API，也不套用 threshold。

```powershell
node scripts/simulate-tiers.mjs --proposal=balanced --score=10
node scripts/simulate-tiers.mjs --input=.wrangler/tier-decision/proposal-balanced.json --output=.wrangler/tier-decision/preview.json
```

JSON input 包含 points_per_approval、campaign_days、完整八個 tiers 與 cohorts。
每個 cohort 提供 population_percent（總和 100），及 approvals_per_user，或
approvals_per_active_day／active_day_fraction。工具輸出升級所需 approved proofs、
各 cohort 當前／下一 Tier／進度，以及達到各門檻的假設人口比例。
後者只是明示假設的敏感度分析，不是目前三位會員推估的參與預測。

現有 schema／API 已阻止負值、非整數、相同 threshold、反向排序、變動普通 baseline、
改動固定身份／icon，以及未授權更新；disabled tier 的非 NULL threshold 仍參與排序。
全部八 Tier 未設定完整前，member calculation 保守回傳普通與 configuration_ready=false。
CLI 沿用相同 readiness／progress 函式；不另創 Production 計算規則。
完整 proposal 選定後仍需透過既有 MFA／CSRF／version／audit 保護的 explicit save 更新，
本工具沒有 apply 功能。若批次變更既有完整配置，須先規劃符合逐筆排序限制的儲存次序。

**TIER THRESHOLD APPLICATION: WAITING FOR OPERATOR DECISION**。
