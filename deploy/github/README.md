# GitHub 正式部署

| 工作流 | 作用 | 付费调用 |
| --- | --- | --- |
| collection-discovery.yml | 三源发现、官网 HTML/RSS 直读、保存提醒、调用共享云端翻译队列、发布 | 仅 DeepSeek 翻译 |
| collection-publish.yml | 已上传批次的统一翻译及发布；按小时有界续跑 | 仅 DeepSeek 翻译 |
| deploy-pages.yml | 手动部署已保存资料与网站代码 | 无 |
| site-smoke.yml | 上线内容核验 | 无 |

新版使用 `JOURNAL_DISCOVERY_ENABLED=true`、`JOURNAL_CLOUD_PUBLICATION_ENABLED=true`、`JOURNAL_PAGES_ENABLED=true`。旧 JOURNAL_AUTOMATION_ENABLED、JOURNAL_ENRICHMENT_ENABLED、JOURNAL_SEARCH_ENABLED、JOURNAL_TRANSLATION_ENABLED、JOURNAL_DISCOVERY_SEARCH_ENABLED 均保持 false。

翻译仅从仓库 Secret `DEEPSEEK_API_KEY` 读取。搜索密钥不注入任何新版步骤。所有写库工作流共用 journal-production 串行锁。收费前持久登记，已有结果与未知计费预占不重置。

发现计划北京时间 08:17、12:17；续跑队列每小时第 43 分钟检查，调度不保证准点。只有明确队列才请求翻译，手动重复发布不会重译成功字段。任务失败保留资料与计费账本。

Action 使用固定审核 SHA 白名单，禁止恢复旧可疑 checkout 或切换允许所有 Actions。维护脚本 `scripts/release-indexed-workflow.ps1` 用于核验旧开关、遗留运行、默认分支和部署。新云端开关单独控制，不能开启旧翻译工作流。

发布只上传校验后的静态投影，不上传完整数据目录、本机浏览器导出或密钥。不强推，冲突停止并保留资料。
