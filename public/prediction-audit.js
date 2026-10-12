const names = { A: "原模型", B: "近期状态", C: "历史交锋", D: "状态＋交锋", Dcontrol: "同训练池对照", E: "加入 TypeSafe" };
const markets = { spf: "胜平负", hhad: "让球胜平负", goals: "总进球" };
const escape = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const pct = value => value == null ? "—" : `${(value * 100).toFixed(1)}%`;
const difference = value => value === 0 ? "持平" : `${value > 0 ? "多中" : "少中"} ${Math.abs(value)} 场`;

export function auditCohortLabel(g) {
  const version = g.protocol.replace(/^context-pilot-/, "冻结 ").replace(/^context-typesafe-e-/, "E ");
  return `${markets[g.market]} · ${g.kind === "typesafe" ? "含 E 组" : "A/B/C/D"} · ${version} · ${g.windows.all.samples}场（${g.id.slice(0, 6)}）`;
}

export function renderAuditTable(group, windowName) {
  if (!group) return '<div class="audit-empty">暂无可比较的冻结预测。更新比赛信息后会按条件冻结，不会为已有赛果补做预测。</div>';
  const window = group.windows[windowName] || group.windows.all;
  const counts = `<div class="audit-sample-count"><strong>${window.samples}</strong><span>场共同比赛${windowName === "latest" ? ` · 本批 ${window.pending || 0} 项待结算` : ` · 此分组 ${group.pending} 项待结算`}</span></div>
    <details class="audit-version"><summary>核对版本与最近批次</summary><p>${escape(group.protocol)}</p><p>${escape(group.algorithmVersion)}</p><p>${escape(group.windows.latest.batch || "暂无批次")}</p><p>最近一批指最晚新增有效冻结的批次；重复冻结不会形成新的评估样本。</p></details>`;
  if (!window.samples) return `${counts}<div class="audit-empty">当前范围没有已结算的共同比赛。待结算不计为失败，也不显示 0% 命中率。</div>`;
  return `${counts}<div class="audit-table-scroll"><table class="audit-table"><caption>${markets[group.market]} · 各组严格使用同一批 ${window.samples} 场比赛</caption>
    <thead><tr><th scope="col">方法</th><th scope="col">单选命中</th><th scope="col">较 A</th>${group.market === "goals" ? '<th scope="col">双选命中</th><th scope="col">双选较 A</th>' : ""}<th scope="col">LogLoss ↓</th><th scope="col">Brier ↓</th></tr></thead>
    <tbody>${group.arms.map(arm => {
      const m = window.metrics[arm];
      return `<tr class="${arm === "A" ? "audit-baseline" : ""}"><th scope="row"><b>${arm}</b><span>${escape(names[arm])}</span></th>
        <td><strong>${pct(m.accuracy)}</strong><small>${m.hits} / ${m.samples} 场</small></td><td>${arm === "A" ? "比较基准" : difference(m.hitDelta)}</td>
        ${group.market === "goals" ? `<td><strong>${pct(m.pairAccuracy)}</strong><small>${m.pairHits} / ${m.samples} 场</small></td><td>${arm === "A" ? "比较基准" : difference(m.pairHitDelta)}</td>` : ""}
        <td>${m.logLoss.toFixed(3)}</td><td>${m.brier.toFixed(3)}</td></tr>`;
    }).join("")}</tbody></table></div>
    <p class="audit-caution">这里的多中或少中只是本批样本差异，不代表稳定提升。LogLoss、Brier 越低，概率误差越小；不据此自动上线模型。</p>`;
}

export function renderAuditIssues(issues, attempts = []) {
  const counts = new Map();
  for (const item of issues) {
    const key = `${item.status}|${item.reason}`;
    const value = counts.get(key) || { ...item, count: 0 };
    value.count++; counts.set(key, value);
  }
  const rows = [...counts.values()].map(item => `<li><span>${escape(item.reason)}</span><b>${item.count} 项</b></li>`).join("");
  return `<p>以下为全部冻结档案的核查信息，不受上方分组或时间范围筛选；按玩法计项，不同协议可涉及同一比赛。</p>
    <ul class="audit-issues">${rows || "<li>暂无缺失或排除记录。</li>"}</ul>
    <details><summary>查看逐项记录（${issues.length} 项）</summary><div class="audit-issue-details">${issues.map(i => `<p>${escape(i.fixture || i.matchId || "文件检查")} · ${escape(markets[i.market] || i.market || "")} · ${escape(i.reason)}<small>${escape(i.batch || "")}</small></p>`).join("")}</div></details>
    ${attempts.length ? `<h3>最近未完成的更新任务</h3><p>任务日志独立于比赛命中率，不计为预测失败。</p><ul class="audit-issues">${attempts.map(a => `<li><span>${escape(a.recordedAt)} · ${escape(a.stage)} · ${escape(a.reason)}</span></li>`).join("")}</ul>` : ""}`;
}
