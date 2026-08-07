const DEFAULT_GOAL_LABELS = ["0", "1", "2", "3", "4", "5", "6", "7+"];

export function exactGoalMultipleRelations(
  odds,
  labels = DEFAULT_GOAL_LABELS,
) {
  if (!Array.isArray(odds) || odds.length < 2) return [];
  const zeroCents = Math.round(Number(odds[0]) * 100);
  if (!Number.isFinite(zeroCents) || zeroCents <= 0) return [];

  return odds.slice(1).flatMap((value, offset) => {
    const cents = Math.round(Number(value) * 100);
    if (!Number.isFinite(cents) || cents <= 0 || zeroCents % cents !== 0) {
      return [];
    }
    const multiple = zeroCents / cents;
    if (!Number.isInteger(multiple) || multiple < 2) return [];
    const index = offset + 1;
    return [{ index, label: labels[index] ?? String(index), multiple }];
  });
}
