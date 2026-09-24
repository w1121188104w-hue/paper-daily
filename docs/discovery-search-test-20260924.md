# 搜索发现测试：2026-09-24

## 真实 API 测试尚未完成

手动隔离任务：35945650331，六刊 RP / JAR / QJE / MS / TAR / JM。
最多 6 次智谱 Pro，必要时每刊 Scholar / Google 各一次，遵守现有远端调用账本、智谱每月 2000 和 SerpAPI 免费 250 上限。不改论文库，不翻译，不发布。

提交后的检查显示 queued，jobs 为空。因此没有 API 搜索结果，也不能据此给出命中率。这个状态不是测试成功。

## 官网对照

本次直接读取 Wiley JAR 最新目录，显示 Volume 64 Issue 4（September 2026），上一期链接是 `/toc/1475679x/2026/64/3`。QJE 当前目录显示 141(3), August 2026；MS 显示 72(9), September 2026。

用户 2026-09-21 导出的目录作为历史基线，不冒充今天的实测。它还记录了 RP 55(10)、JAR Early View 和 TAR Early Access 等页面。

## 当前规则复现的问题（本地回放，不是智谱返回结果）

1. 输入 JAR 64(3) 官方旧卷期链接，仍产生 pending 卷期提醒。程序未把卷期与已采集基线比较，不能证明是新一期。
2. 输入 JAR `/toc/1475679x/0/0`，产生 collection=issue 的提醒。相同域名/路径前缀被第一个卷期适配器抢先匹配，在线目录分类错误。
3. 输入符合 Springer 官方路由的 `/journal/41267/volumes-and-issues/57-8` 测试链接，三层回放均不产生提醒。具体卷期检测只识别 vol/issue/toc，遗漏 volumes-and-issues；这条是路由构造用例，不证明该卷期实际存在。

结论：当前搜索提醒规则未通过验收，不能直接作为是否启动插件的唯一依据。生产规则未在本次测试中修改，定时开关继续关闭。

## 本机备用测试

若 GitHub 持续排队，可运行 `test-search-local.cmd`，在本机隐藏输入框输入智谱 Key；不发到聊天，不落盘保存。只测 6 次 Pro，不调用 SerpAPI。沿用 GitHub 调用账本，账本不可读/不可写或额度不允许时不发送付费请求。

报告位于 `%LOCALAPPDATA%/PaperDailySearchProbe/report.json`。本机备用入口已做脚本检查，尚未输入真实 Key 执行；不可称为实测成功。
