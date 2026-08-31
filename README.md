# Betwin Odds Radar

Betwin 是一个本地运行的中国竞彩历史赔率分析网站。正式预测以相似历史比赛的真实赛果分布为核心；尚未通过时间顺序验证、独立门禁和人工批准的高级模型只用于离线研究。

## 环境

- Node.js 22 或更新版本
- Python 3.12 或兼容版本
- Python 依赖见 `requirements.txt`
- 默认 SQLite 数据库：仓库根目录 `betwin.db`

安装 Python 依赖：

```bash
python3 -m pip install -r requirements.txt
```

项目没有第三方 Node 依赖，也没有前端构建步骤。

## 启动

```bash
npm start
```

默认地址为 `http://127.0.0.1:8765/`。可使用 `PORT` 修改端口，使用 `BETWIN_DATABASE_PATH` 指定其他数据库。

## 数据更新

只更新当天 JSON：

```bash
npm run db:update-matches
```

少量更新历史 Excel，并按需重验正式可靠性规则：

```bash
npm run db:update-history
```

完整导入、离线报告、生产锁验证和测试：

```bash
npm run db:refresh
```

完整刷新耗时较长，不应作为每天少量数据更新的默认命令。

## 验证

```bash
npm test
git diff --check
```

`npm test` 会运行 Node 测试和 Python `unittest`。数据库可额外执行：

```bash
sqlite3 -readonly betwin.db "PRAGMA integrity_check; PRAGMA foreign_key_check;"
```

## 生产安全边界

- 正式 SPF/HHAD 阈值固定为 `±7%`，总进球使用独立生产匹配口径。
- 固定防零层使用总先验质量 `m=1.5`。
- `data/*-config.json` 是候选或研究产物，不能自行启用生产功能。
- 高级模块必须通过概率、ROI、版本与参数一致性门禁，并由对应 `data/*-production.json` 明确批准。
- 当前批准文件默认保持 `runtimeEnabled: false`。

更完整的当前水位、数据量、已知限制和后续任务见 `HANDOFF.md`。
