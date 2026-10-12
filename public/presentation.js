import { LEDGER_TIME_ZONE } from "./ledger-date.js";

export function createLatestRequestGate() {
  let revision = 0;
  return {
    invalidate() { revision += 1; },
    begin() {
      const own = ++revision;
      return { isCurrent: () => own === revision };
    },
  };
}

export function ledgerEmptyState(context, section) {
  const noun = section === "parlay" ? "串关记录" : "单场快照";
  if (context?.all === 0) return {
    kind: "empty", title: `还没有${noun}`,
    message: section === "parlay"
      ? "生成组合后，点击“记录此组合”留档；留档不代表实际投注。"
      : "默认规则的赛前预测会自动留档，尚未产生快照时不会显示记录。",
  };
  if (context?.selectedPolicy === 0 && context.all > 0) return {
    kind: "version", title: "当前版本范围内没有记录",
    message: `账本仍保留 ${context.all} 条记录，其中 ${context.unknown || 0} 条版本未知。可查看全部版本核对；不会自动混入当前模型统计。`,
  };
  return {
    kind: "filtered", title: "没有符合当前筛选的记录",
    message: "记录可能被状态、日期、玩法或搜索条件排除。清除筛选只恢复当前版本范围，不会删除记录。",
  };
}

const timeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: LEDGER_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function sourceTime(value) {
  const raw = String(value || "").trim();
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(raw)) return `${raw}（日期未知）`;
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw)) return "未知";
  // Upstream wall-clock odds timestamps use Beijing time. Never use the browser zone.
  const normalized = raw.replace(" ", "T");
  const date = new Date(/(Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}+08:00`);
  return Number.isFinite(date.getTime()) ? timeFormat.format(date) : "未知";
}
