export const LEDGER_TIME_ZONE = "Asia/Shanghai";

const calendar = new Intl.DateTimeFormat("en-CA", {
  timeZone: LEDGER_TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
});

export function ledgerCalendarDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = Object.fromEntries(calendar.formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
