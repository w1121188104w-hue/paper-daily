# 按出版社验证 Search + Reader

## 范围与结果

2026-09-18，覆盖全部19本目标期刊所属的9个出版社/学会分组，抽样17篇：8篇缺摘要、9篇已有摘要对照；不是逐篇测试全部19刊或所有论文。最多每组2篇缺摘要+1篇对照。第一轮38次，定点复查4次，合计42次智谱请求（Reader 26、Web Search 16），无SerpAPI、DeepSeek调用。账本25次succeeded、17次unknown；不能由此认定真实收费次数或金额。

| 出版单位 | 样本 | 结论 |
| --- | ---: | --- |
| Elsevier | 3 | ScienceDirect Reader样本均访问受限；直接通道robots无法读取，不代表已检查页面不存在摘要 |
| Wiley | 3 | Reader样本访问受限；Search部分结果指向同站其他论文，不能采纳 |
| Springer Nature | 3 | RAS缺摘要样本取得完整原文；两个JIBS样本返回内容未含Abstract，不能用Introduction补写 |
| Oxford University Press | 1 | Reader访问受限；搜索混入其他学科论文，未采纳 |
| American Accounting Association | 1 | Reader返回HTTP 500/1234；Search取得与库内原文一致的对照摘要 |
| American Economic Association | 1 | 免费直接读取已成功；Reader规范化URL后读到摘要，旧提取器漏识别Downloads结束标题 |
| University of Chicago Press | 3 | Reader样本均访问受限 |
| INFORMS | 1 | 目标论文Reader访问受限；另一篇搜索结果可读，但不是目标论文，不算成功 |
| SAGE | 1 | Reader正文包含库内对照摘要原文；摘要后直接进入无Introduction标题的正文，旧边界规则未提取 |

## 必须纠正的自动统计

首轮脚本把Springer一段7837字符的“摘要+订阅提示+注释”标成成功，复核后撤销该原始成功判定。通过四页定点检查取得原始Markdown边界：`## Abstract`到`## Access this article`，离线修正得到831字符的完整原文。测试夹具保留真实片段和原始Reader正文哈希，回归测试核对逐字一致；没有人工写摘要、没有AI生成。

因此最终可以说：8篇缺摘要样本中定位到1篇完整原始摘要，可供后续正式导入；本轮正式补入为0。SAGE、AEA、AAA是已有摘要的对照，不计入新增。此小样本不能外推出版社整体成功率。

第一轮额外读取了5个同出版社但身份无关的搜索结果。未有任何误写，开发测试现已在付费读取前增加DOI/标题候选过滤，并排除PDF阅读路径。Search返回标题/内容/DOI需一致，不能用站点正确代替论文正确。

## 建议

采用出版社分流：Springer、SAGE推进专用读取/边界适配；AEA保留免费直读优先；AAA保留可核验的Search原文；受限站点缓存失败、降低重试频率，优先其他真实来源。Reader并非通用绕过访问限制工具。计费应分Reader和Search统计，以每篇真实新增摘要的成本衡量，不用HTTP成功率替代。

## 运行与隔离

- 全组测试：https://github.com/w1121188104w-hue/paper-daily/actions/runs/35319570075
- 四页复查：https://github.com/w1121188104w-hue/paper-daily/actions/runs/35320481563
- 结构化审计：同目录publisher-reader-comparison-2026-09-18.json。其中原始reported字段保留初始算法结果，结论须按review_corrections解释。
- 正式分支在两次测试前后均为63939a141baa6e6aedfac50564f73dc6768dc57a；未改论文、未翻译、未部署。仅复用已有手动验证任务、密钥权限和持久化调用账本。
- 原文边界修正仅位于开发分支，没有发布到每日流程。
