export const HISTORY_TIMELINE_VERSION = "database-import-batches-v1";

export function batchBoundary(rows, index) {
  const batch = rows[index]?.historyBatchId;
  while (index > 0 && batch > 0 && rows[index - 1]?.historyBatchId === batch) index--;
  return index;
}

// 旧累加来源没有可靠的跨文件时间关系，分别回测；它们均早于每日增量批次。
// 新批次整批评估后才进入训练集，文件行号只用于展示追溯。
export function historyTimelines(rows) {
  const legacy = new Map(), batches = new Map();
  for (const row of rows) {
    const batch = Number(row.historyBatchId || 0);
    const groups = batch > 0 ? batches : legacy;
    const key = batch > 0 ? batch : row.sourceFile || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const timelines = [...legacy].map(([sourceFile, group]) => ({
    sourceFile, seed: [],
    batches: [...group].sort((a, b) => a.sourceRow - b.sourceRow).map(row => [row]),
  }));
  if (batches.size) timelines.push({
    sourceFile: "database-import-batches",
    seed: [...legacy.values()].flat(),
    batches: [...batches].sort(([a], [b]) => a - b).map(([, group]) =>
      [...group].sort((a, b) => (a.historyId || 0) - (b.historyId || 0))),
  });
  return timelines;
}

export function* historySteps(rows) {
  for (const timeline of historyTimelines(rows)) {
    const history = [...timeline.seed];
    const sourceLength = timeline.batches.reduce((sum, batch) => sum + batch.length, 0);
    let index = 0;
    for (const batch of timeline.batches) {
      for (const target of batch) yield {
        target, history, index: index++, sourceLength, timeline: timeline.sourceFile,
      };
      history.push(...batch);
    }
  }
}
