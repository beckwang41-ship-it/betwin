# 查询优化快速检查

正常更新历史数据库时，索引会由导入脚本自动维护，不需要每次单独优化。

旧数据库或需要查看当前查询计划时运行：

```bash
npm run db:optimize
```

然后验证和启动：

```bash
npm test
npm start
```

访问：`http://localhost:8765/`

如果出现 `EADDRINUSE :8765`，表示已有服务正在使用端口。先定位具体进程：

```bash
lsof -nP -iTCP:8765 -sTCP:LISTEN
```

如果页面能正常打开，直接使用现有服务即可；只有确认该 PID 是本项目旧服务时才结束它，再重新运行 `npm start`。

当前未启用赔率查询缓存。数据库更新后无需处理缓存失效问题。
