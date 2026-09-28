# Paper Daily · 目标期刊论文采集

当前正式流程（2026-09-28）：

**三源发现 → 网站提醒 → 插件定向采集 → DeepSeek 原文核对 → 导入、翻译、发布**

- Crossref、OpenAlex、Semantic Scholar 独立发现，回查最近 60 天。
- 平时只处理网站提醒的期刊目录；每周或半个月手动运行“全刊巡检”（最新一期＋在线发表，不回溯所有旧卷期）。
- 网站区分“发现更新”和“到期巡检”。没有提醒不代表没有新论文。
- 只保存真实原始摘要；原文没有摘要就留空，不生成或猜测。DeepSeek 仅核对原文、翻译已有内容。
- 外部付费搜索已经退出：旧智谱/SerpAPI 工作流、试跑入口、HTTP 适配器和搜索配置已删除。历史论文、来源证据及调用账本保留。

## 使用

1. 运行本机正式仓库的 `start-workflow.cmd`（复用已配置的 Key）。
2. 在浏览器扩展进入“正式流程”，同步提醒，选择“日常增量采集”；需要兜底时选“全刊巡检”。
3. 插件自动打开页面、采集并核对；遇验证暂停，人工完成后继续。
4. 完成后明确点击“导入、翻译并发布”，等待网站回执核验。

[网站](https://w1121188104w-hue.github.io/paper-daily/) · [完整流程](docs/collection-workflow.md) · [目录基线与巡检](docs/catalog-baseline-reminders.md) · [部署说明](deploy/github/README.md)

## 维护

Node.js 24，安装锁定依赖：`npm ci --ignore-scripts`。

```powershell
npm test
npm start
node scripts/journal-library.js --validate
node scripts/build-journal-site.js
```

`npm start` 只启动本地只读预览，不采集、不翻译。线上只有三源发现、静态发布与网站核验三个工作流；旧定时采集和自动付费翻译入口已移除。三源计划北京时间 08:17、12:17，GitHub 调度不保证准时。

不要提交整个 `data/`、本机配置或密钥。正式论文版本由校验后的清单暂存，原始浏览器结果保存在本机。论文历史与调用账本没有删除；已删除代码可从 Git 历史恢复。较早的日期化文档仅是历史验收记录，不是当前运行指南。

## 来源与历史

界面基于 [paper-daily](https://github.com/limafang/paper-daily)，采集归档思路参考 [AI-academia-bot](https://github.com/coujasmine/AI-academia-bot)。保留原仓库历史和许可信息；项目持有人保存复用授权依据。旧 arXiv 实验页面不属于当前正式期刊流程，默认启动入口不再运行它。
