// Shared Production/Pages renderer. Snapshots only; Google credentials never enter the browser.
import { pagedListDialog } from './paginated-dialog.js';
export function renderStorage(container, data, { node, button, mutate, reload, request, message, dialogActive, onDialog, onDialogClosed }) {
  const section = node("section", "", "storage-panel");
  section.setAttribute("aria-label", "儲存容量保護");
  container.append(section);
  section.append(node("h3", "儲存容量保護"));
  if (!data) {
    section.append(node("p", "目前無法取得容量保護狀態。", "notice warn"));
    return;
  }
  const gb = (n) => (Number.isFinite(n) ? (n / 1000000000).toFixed(2) + " GB" : "未知");
  // Google labels binary quota units as GB; R2's management budget remains decimal.
  const driveGb = (n) => (Number.isFinite(n) ? (n / 1024 ** 3).toFixed(2) + " GB" : "未知");
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
        " · 上次盤點 " +
        time(data.observed_at),
    ),
  );
  const observing = data.upload_policy === "observe";
  let status = observing ? "容量保護採觀察模式，投稿開關獨立控制。" : "容量閘門正常，投稿開關獨立控制。";
  if (data.blocked) {
    if (data.anomaly) status = "容量帳本異常，暫時停止圖片上傳。";
    else if (data.snapshot_stale) status = "R2 盤點快照已過期，暫時停止圖片上傳。";
    else status = "目前儲存空間不足，暫時停止圖片上傳，請稍後再試。";
  }
  section.append(node("p", status, data.blocked ? "notice warn" : "notice"));
  const safety = data.safety_inventory;
  if (safety) {
    section.append(node("h4", "自動安全盤點"));
    if (safety.latest) {
      const latest = safety.latest;
      section.append(node("p", "最近完成 " + time(latest.observed_at) + " · R2 物件用量約 " +
        gb(latest.bytes) + " · " + latest.objects.toLocaleString("zh-TW") + " 個物件"));
      section.append(node("p", "計入既有預留後約 " + gb(latest.accounted_upper_bytes) +
        " · " + latest.pending_operations + " 筆歷史寫入待核對", "tiny"));
    }
    if (safety.state === "scanning") section.append(node("p", "正在進行本輪盤點。", "tiny"));
    else if (safety.state === "waiting") section.append(node("p",
      safety.latest ? "等待下輪盤點。" : "等待首次盤點。", "tiny"));
  }
  if (data.inventory_invalidated || data.snapshot_stale) {
    const snapshotStatus = data.inventory_invalidated ? "R2 盤點已失效。" : "R2 盤點快照已過期。";
    section.append(node("p", snapshotStatus + "目前顯示帳本用量。", observing && !data.blocked ? "tiny" : "notice warn"));
  }
  if (data.anomaly) section.append(node("p", "容量異常：" + data.anomaly, "notice warn"));
  section.append(
    node("p", "容量限制開啟時：90% 啟動清理檢查 · 95% 停止新圖片 · 低於 90% 且重新盤點後解除容量封鎖。", "tiny"),
  );
  section.append(node("p",data.cleanup_mode==="live"?"結案滿 7 天且 Drive 驗證成功的舊圖片，達 90% 自動清理至 85%。":"自動清理目前僅試算（dry-run），試算保留期為結案後 7 天。",data.cleanup_mode==="live"?"notice":"notice warn"));
  const usageStatus = node("p", "", "tiny");
  usageStatus.setAttribute("role", "status");
  const usageButton = node("button", "查詢 R2 實際用量", "btn btn-white");
  usageButton.type = "button";
  usageButton.addEventListener("click", async () => {
    if (usageButton.getAttribute("aria-disabled") === "true") return;
    usageButton.setAttribute("aria-disabled", "true");
    let bytes = 0, objects = 0, cursor = null;
    const seen = new Set();
    usageStatus.textContent = "正在讀取 R2 物件用量…";
    try {
      for (let pages = 0; pages < 100; pages++) {
        const page = await request("storage/r2-usage" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""));
        if (!Number.isSafeInteger(page?.bytes) || page.bytes < 0 ||
            !Number.isSafeInteger(page.objects) || page.objects < 0 || page.objects > 200 ||
            !Number.isSafeInteger(bytes + page.bytes) ||
            (page.next_cursor !== null && (typeof page.next_cursor !== "string" || !page.next_cursor || seen.has(page.next_cursor))))
          break;
        bytes += page.bytes;
        objects += page.objects;
        if (page.next_cursor === null) {
          usageStatus.textContent = "本次查詢 " + time(Math.floor(Date.now() / 1000)) +
            " · R2 物件用量約 " + gb(bytes) + " · " + objects.toLocaleString("zh-TW") + " 個物件";
          return;
        }
        cursor = page.next_cursor;
        seen.add(cursor);
      }
      usageStatus.textContent = "R2 用量未讀取完整。可至 Cloudflare 查看儲存指標。";
    } catch {
      usageStatus.textContent = "R2 用量查詢未完成。";
    } finally {
      usageButton.removeAttribute("aria-disabled");
    }
  });
  if (request) section.append(usageButton, usageStatus);
  const inventoryButton = button("更新 R2 盤點（每次最多 200 個物件）", async () => {
    const r = await mutate("storage/inventory", {});
    await reload();
    return r;
  });
  inventoryButton.disabled = data.inventory_invalidated === true;
  section.append(inventoryButton);
  section.append(
    button("檢查歷史圖片（dry-run）", async () => {
      const r = await mutate("storage/dry-run", {});
      section.append(
        node(
          "p",
          "本次檢查 " +
            (r.state==="dry_run"?1:0) +
            " 張 · 可清理 " +
            (r.state==="dry_run"?1:0) +
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
        driveGb(q.total_bytes) +
        " · 已用 " +
        driveGb(q.used_bytes) +
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
  const details = node('details');
  details.append(node('summary','容量歷史統計'));
  const showHistory=node('button','查看容量歷史清單','btn btn-white');showHistory.type='button';
  showHistory.addEventListener('click',()=>{
    if(!request||dialogActive?.())return;
    let dialog;
    dialog=pagedListDialog({
      title:'容量歷史統計',opener:showHistory,itemsKey:'history',
      fetchPage:page=>request('storage/history?page='+page),
      emptyText:'目前沒有容量歷史紀錄。',message,
      renderRow:h=>{const card=node('article','','member-case');card.append(
        node('p','資料時間：'+time(h.created_at)),
        node('p','容量：'+gb(h.bytes)+' · 物件：'+h.object_count),
        node('p','staging：'+gb(h.staging_bytes)+' · 其他：'+gb(h.other_bytes)));return card;},
      onClose:()=>onDialogClosed?.(dialog)
    });onDialog?.(dialog);
  });
  details.append(showHistory);
  section.append(details);
}
