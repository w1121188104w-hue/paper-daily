# 搜索发现测试：2026-09-24

## 真实 API 测试尚未完成

手动隔离任务：35945650331，六刊 RP / JAR / QJE / MS / TAR / JM。
该排队运行的旧版本原本允许 SerpAPI 兜底，尚未执行。后续用户已批准收紧测试：最多 6 次智谱 Pro，不提供 SerpAPI 密钥、不调用 SerpAPI、不自动重试，遵守现有远端调用账本及智谱每月 2000 上限。不改论文库、不翻译、不发布。

提交后的检查显示 queued，jobs 为空。因此没有 API 搜索结果，也不能据此给出命中率。这个状态不是测试成功。

## 官网对照

本次直接读取 Wiley JAR 最新目录，显示 Volume 64 Issue 4（September 2026），上一期链接是 `/toc/1475679x/2026/64/3`。QJE 当前目录显示 141(3), August 2026；MS 显示 72(9), September 2026。

用户 2026-09-21 导出的目录作为历史基线，不冒充今天的实测。它还记录了 RP 55(10)、JAR Early View 和 TAR Early Access 等页面。

## 当前规则复现的问题（本地回放，不是智谱返回结果）

1. 输入 JAR 64(3) 官方旧卷期链接，仍产生 pending 卷期提醒。程序未把卷期与已采集基线比较，不能证明是新一期。
2. 输入 JAR `/toc/1475679x/0/0`，产生 collection=issue 的提醒。相同域名/路径前缀被第一个卷期适配器抢先匹配，在线目录分类错误。
3. 输入符合 Springer 官方路由的 `/journal/41267/volumes-and-issues/57-8` 测试链接，三层回放均不产生提醒。具体卷期检测只识别 vol/issue/toc，遗漏 volumes-and-issues；这条是路由构造用例，不证明该卷期实际存在。

结论：当时搜索提醒规则未通过验收，不能直接作为是否启动插件的唯一依据。

## 本次修正及安全恢复检查

本地修正：按目录所属表面识别 Wiley 在线目录，但只有目录链接本身不证明新增；支持 Springer 卷期路由；卷期必须比已处理目录/论文目录归属中的已知卷期新。没有基线时记录 `issue_baseline_missing`，不把旧期误报为新期。18 项相关离线测试通过。这不是付费搜索实测成功，仍需要历史目录基线和真实查询验收。

已确认 GitHub 六个自动控制变量为 false，八个采集/搜索/翻译工作流为 disabled_manually，只保留发布和只读检查工作流 active。仓库 Actions 总开关仍为 false。

安全阻断：35945650331 仍显示 queued 且零 jobs；cancel 和 force-cancel 均返回 409（Cannot cancel a workflow run that has not been queued yet），删除返回 403（Could not delete the workflow run）。没有成功删除任何运行。由于该旧版本允许 SerpAPI 兜底，未冒险恢复总开关，也未调度新测试。正式论文库与网站未变更。

## 本机备用测试

### 最新恢复进展

用户明确授权权限调整后，Actions 已恢复为 `enabled=true, allowed_actions=local_only`。八个旧付费/发现工作流仍 disabled_manually，六个自动控制仍 false。异常旧运行仍 queued，取消409/删除403，未删除。允许列表接口返回409，因此没有放开外部 Actions，网站发布也尚未恢复运行。

准备了 `discovery-search-probe-v2.yml` 独立手动入口和并发组：只用 shell 按 GITHUB_SHA 获取公开仓库，不用 Git 凭据或外部 Actions；新密钥只用于六次以内 Pro 查询，结果通过已检查不含凭据的运行报告输出，不使用 SerpAPI。旧工作流新版 job 固定 false。旧排队运行仍受 local_only 阻止其 checkout。

本地相关39项测试通过；全套583项首次因临时 checkout 版本与部署模板不一致失败1项，已还原两处部署版本，部署相关测试通过。Git 暂存/提交被本机 Git 元数据权限拒绝，远端 push 被工具安全审批拒绝，未提交或推送这些新修改。需明确授权提交并推送本次文件到 master，再手动启动一次 v2。尚未真实调用搜索。

用户已在智谱撤销旧 Key，并在 GitHub 新建 `ZHIPU_DISCOVERY_API_KEY`。新版测试仅绑定此 Secret，缺少新密钥时直接拒绝，绝不回退旧 `ZHIPU_API_KEY`；本机备用入口也使用新变量。19 项本地测试通过（含密钥隔离）。当前修改尚未推送或执行付费测试。

尝试以 `enabled=true, allowed_actions=local_only` 安全恢复仓库时，被工具安全审批拒绝，命令未执行。该方案会暂时阻止包括 GitHub 官方 checkout 在内的外部 Actions，同时影响发布；需要用户明确同意这项具体权限调整。未改为其他方式绕过审批，总开关未恢复。

若 GitHub 持续排队，可运行 `test-search-local.cmd`，在本机隐藏输入框输入智谱 Key；不发到聊天，不落盘保存。只测 6 次 Pro，不调用 SerpAPI。沿用 GitHub 调用账本，账本不可读/不可写或额度不允许时不发送付费请求。

报告位于 `%LOCALAPPDATA%/PaperDailySearchProbe/report.json`。本机备用入口已做脚本检查，尚未输入真实 Key 执行；不可称为实测成功。
