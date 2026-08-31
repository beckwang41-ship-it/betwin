# scripts/test_*.mjs 是一次性诊断脚本，不是测试

`npm test` 只运行 `tests/*.test.mjs`。`scripts/` 下这些 `test_` 前缀的文件
是排查特定问题时写的一次性实验，**不参与 CI，也不是回归保障**。

保留它们是为了留下推理痕迹（当初为什么这样判断），不是为了继续当证据用。

## 已停用（需显式开关）

以下脚本使用**单市场独立匹配**，与当前生产的联合匹配、让球同盘口口径不符，
继续引用其数字会得出错误结论。运行时会直接退出并给出替代命令：

- `test_adaptive_roi.mjs`
- `test_movement_residual.mjs`

如仅需复现旧实验，显式设置 `BETWIN_ALLOW_LEGACY_DIAGNOSTIC=1`。

## 仍可参考（口径与当前生产一致）

- `test_zero_cells.mjs` — 零格实测：模型报 0% 的格子真实发生率
- `test_jeffreys_argmax.mjs` — 穷举验证防零层的保序性
- `test_prior_floor.mjs` — 对比裸占比 / Jeffreys / 生产平滑 / 总质量固定
- `test_floor_vs_gate.mjs` — 平滑「改善」中防零层的归因占比
- `test_gate_margin.mjs` / `test_gate_stability.mjs` — 非劣性门禁的 margin 取值扫描
- `test_calibration.mjs` / `test_calibration_split.mjs` — 校准误差（ECE/MCE）
- `test_smoothing_decompose.mjs` / `test_tolerance_ladder.mjs` / `test_logloss_clamp.mjs`
- `test_floor_attribution.mjs` / `test_gate_leverage.mjs`

## 长期只读报告（已注册到 package.json）

这些才是应该长期使用的入口：

| 命令 | 用途 |
| --- | --- |
| `npm run report:strategy-gates` | 各调参模块的投注 ROI 门禁结论 |
| `npm run report:reliability-roi` | 「重点参考」筛选的 ROI 与 bootstrap 区间 |
| `npm run report:value-bands` | 按赔率区间统计命中率 / 保本线 / ROI |
| `npm run report:parlay-ledger` | 串关账本按回报指数分档的实际战绩 |
| `npm run report:parlay-math` | 串关的水钱复合、选择偏差、误差放大三项量化 |
| `npm run verify:production-lock` | 验证候选配置无法绕过门禁上线（已并入 `db:refresh`） |
