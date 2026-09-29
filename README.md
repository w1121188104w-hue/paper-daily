# Paper Daily · 目标期刊论文采集

正式流程（1.0）：

**三源发现＋官网直读 → 仅将未完成目录交给插件 → 原文核对 → 自动去重上传 → GitHub 统一翻译并发布**

- 官网先读公开目录、RSS 和文章页。RSS 是部分线索，不能冒充完整目录；访问受限不算空目录。
- Crossref、OpenAlex、Semantic Scholar 独立发现，回查最近 60 天。
- 日常只处理提醒的目录；每周或半月可启动全刊巡检，只检查最新一期和在线发表。
- 插件只需启动一次、必要时人工处理验证码。目录核对、详情采集、核对、提交和发布均自动衔接。
- 原文不存在就留空；不生成摘要。作者单位保留现有能力，JPE 图片/Just Accepted 采集停用。
- 翻译统一在 GitHub，使用 DEEPSEEK_API_KEY Secret；本机 Key 只用于 DeepSeek 原文核对。
- 旧智谱/SerpAPI 付费搜索不再运行。历史论文、来源证据、核对缓存及调用账本保留。

## 使用

1. 运行本机正式仓库的 `start-workflow.cmd`，复用已保存的原文核对配置。
2. 扩展点击“开始增量采集”；需要定期补漏时点“全刊巡检”。
3. 遇验证码时在论文标签页人工处理，插件每 15 秒检查是否已恢复；不自动操作验证码。
4. 后续自动上传、GitHub 翻译、发布和核验。采集时保持面板打开；提交完成后可以关闭。

[网站](https://w1121188104w-hue.github.io/paper-daily/) · [完整流程](docs/collection-workflow.md) · [部署说明](deploy/github/README.md)

## 维护

Node.js 24，依赖安装：`npm ci --ignore-scripts`。

```powershell
npm test
npm start
node scripts/journal-library.js --validate
node scripts/build-journal-site.js
node scripts/check-official-catalogs.js --run --journal AER --details
```

只读官网诊断不写库、不调用 AI。发现计划北京时间 08:17、12:17；GitHub 调度不保证准时。云端翻译队列按指纹复用结果，未知计费不盲目重试。

不要提交整个 data、本机配置或密钥。正式数据按校验清单暂存；原始浏览器导出只留本机。日期化文档是历史记录，不是当前运行指南。

## 来源与历史

界面基于 [paper-daily](https://github.com/limafang/paper-daily)，采集归档思路参考 [AI-academia-bot](https://github.com/coujasmine/AI-academia-bot)。保留原仓库历史和许可信息；项目持有人保存复用授权依据。
