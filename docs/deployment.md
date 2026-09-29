# 部署入口

当前目标期刊项目采用 GitHub Pages 和 GitHub Actions。请使用 [GitHub 部署说明](../deploy/github/README.md) 与 [正式采集流程](collection-workflow.md)。

旧 arXiv 服务、macOS launchd、VPS systemd 示例不属于当前正式流程，旧启动指令已从此文档移除，避免启动另一套采集任务。需要追溯时可查看 Git 历史。

本机只需 `start-workflow.cmd` 启动原文核对和上传协调服务；翻译统一在 GitHub，不在本机执行。
