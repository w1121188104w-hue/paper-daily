# 当前 GitHub 部署流程

仅维护三个工作流：

| 工作流 | 用途 | 付费调用 |
| --- | --- | --- |
| collection-discovery.yml | 独立三源发现，保存新增元数据与目录提醒，构建发布 | 无 |
| deploy-pages.yml | 手动发布已保存论文与网站代码 | 无 |
| site-smoke.yml | 手动核验实际上线内容 | 无 |

三源计划北京时间 08:17、12:17，滚动 60 天。只有 `JOURNAL_DISCOVERY_ENABLED` 与 `JOURNAL_PAGES_ENABLED` 启用；旧搜索、自动摘要修复、自动翻译变量继续关闭。已删除的旧工作流不能作为新版入口恢复。

DeepSeek 核对和翻译通过本机插件正式闭环，在用户启动/确认时执行，不属于每日线上定时任务。

`deploy-pages.yml.example` 是唯一保留的发布模板。所有发布只上传经过校验的静态目录，不能上传完整 data、密钥或个人配置。不使用强推，数据与代码冲突时停止。

维护工具 `scripts/release-indexed-workflow.ps1` 可审计、发布和启动新版三源；每次操作检查 master 提交、旧任务开关和遗留运行。只放行新版使用的固定官方 Action，旧卡住探针所用 checkout 版本继续禁止。不要改成“允许所有 Actions”。

运行统计和异常以 Actions 与网站当前结果为准。早期日期化验收文档不是当前启用说明。
