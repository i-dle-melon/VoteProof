// Shared Production/Pages renderer. Snapshots only; Google credentials never enter the browser.
export function renderStorage(container, data, { node, button, mutate, reload }) {
  const section = node("section", "", "storage-panel");
  section.setAttribute("aria-label", "儲存容量保護");
  container.append(section);
  section.append(node("h3", "儲存容量保護"));
  if (!data) {
    section.append(node("p", "容量未知 · 新圖片上傳安全封鎖", "notice warn"));
    return;
  }
  const gb = (n) => (Number.isFinite(n) ? (n / 1000000000).toFixed(2) + " GB" : "未知");
  const time = (n) => (n ? new Date(n * 1000).toLocaleString("zh-TW") : "尚無資料");
  section.append(
    node("p", "R2 管理預算 " + gb(data.budget?.budget) + "（十進位，非 R2 硬容量上限）"),
  );
  section.append(
    node(
      "p",
      "已用 " +
        gb(data.used_bytes) +
        " · 預留 " +
        gb(data.reserved_bytes) +
        " · 資料時間 " +
        time(data.observed_at),
    ),
  );
  section.append(
    node(
      "p",
      data.blocked
        ? "目前儲存空間不足，暫時停止圖片上傳，請稍後再試。"
        : "容量閘門正常；投稿開關仍獨立控制。",
      data.blocked ? "notice warn" : "notice",
    ),
  );
  if (data.anomaly) section.append(node("p", "容量異常：" + data.anomaly, "notice warn"));
  section.append(
    node("p", "90% 啟動清理檢查 · 95% 停止新圖片 · 低於 90% 且重新盤點後解除容量封鎖。", "tiny"),
  );
  section.append(node("p", "清理僅 dry-run；30 天為待批准提案，不會實際刪圖。", "notice warn"));
  section.append(
    button("更新 R2 盤點（每次最多 200 個物件）", async () => {
      const r = await mutate("storage/inventory", {});
      await reload();
      return r;
    }),
  );
  section.append(
    button("檢查歷史圖片（dry-run）", async () => {
      const r = await mutate("storage/dry-run", {});
      section.append(
        node(
          "p",
          "本次檢查 " +
            r.items.length +
            " 張 · 可清理 " +
            r.items.filter((i) => i.would_delete).length +
            " 張 · 實際刪除 0 張",
        ),
      );
    }),
  );
  const q = data.drive_quota ?? { state: "unknown" };
  section.append(node("h3", "Google Drive 剩餘容量"));
  section.append(
    node(
      "p",
      "總額 " +
        gb(q.total_bytes) +
        " · 已用 " +
        gb(q.used_bytes) +
        " · 剩餘 " +
        (Number.isFinite(q.remaining_percent) ? q.remaining_percent.toFixed(1) + "%" : "未知"),
    ),
  );
  section.append(
    node(
      "p",
      "資料時間 " +
        time(q.observed_at) +
        " · " +
        ({
          known: "已取得快照",
          unlimited: "未提供容量上限",
          unknown: "容量未知",
          error: "讀取失敗",
        }[q.state] ?? "容量未知") +
        (q.stale ? " · 快照已過期" : ""),
      q.state !== "known" || q.stale ? "notice warn" : "tiny",
    ),
  );
  const details = node("details");
  details.append(node("summary", "容量歷史統計"));
  for (const h of data.history ?? [])
    details.append(
      node(
        "p",
        time(h.created_at) +
          " · " +
          gb(h.bytes) +
          " · " +
          h.object_count +
          " 個物件 · staging " +
          gb(h.staging_bytes) +
          " · 其他 " +
          gb(h.other_bytes),
      ),
    );
  section.append(details);
}
