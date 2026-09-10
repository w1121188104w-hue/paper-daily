# GitHub 流程：公开网站已上线，每日自动采集已启用

两份`.yml.example`文件是模板，不会自行运行。`.github/workflows/`对应版本已上传，并于2026-09-09完成一次手动采集试运行：测试、保存与打包通过，两条无标题来源记录导致整体如实报告部分失败。见[试运行核对](../../docs/github-trial-2026-09-09.md)。2026-09-10经用户确认后，已上线[公开网站](https://w1121188104w-hue.github.io/paper-daily/)，随后用户明确要求开启自动采集，现启用北京时间08:17和13:17日程。独立发布仍只接受手动入口，两份流程均无`push`触发。

日程已在远端核对生效，并立即手动验证同一流程：采集保存和自动网页部署通过，493条数据已上线，3条缺标题来源记录继续报告部分失败。不是已观测到定时触发；下一计划时段是2026-09-11北京时间08:17。详见[启用与验证记录](../../docs/automation-enabled-2026-09-10.md)。

2026-09-09最新公开范围：用户明确选择公开仓库＋公开网站，正式论文库与来源原始记录不需保密，因此已移除私有仓库检查；不再准备团队登录或私有数据分离方案。密钥和个人账号配置仍不公开，翻译草稿不混入正式数据提交。见 [公开阅读方案](../../docs/public-reading-scope.md)。

模板用 JSON 格式表达 YAML（JSON 是 YAML 的子集），以便不增加依赖就能做结构测试。启用时文件扩展名仍应是 `.yml`；这不是让普通用户手写代码，后续可由助手在确认授权后处理。

## 当前流程

用户于2026-09-10授权取消逐篇校对，接入全库与每日自动翻译。`daily-collect.yml`在采集保存后增加独立翻译步骤；`translate-library.yml`可手动处理已有待翻译研究论文。两者通过`JOURNAL_TRANSLATION_ENABLED`独立开关控制，只在翻译步骤读取`DEEPSEEK_API_KEY`，保存合格机器译文后自动发布。详见[自动翻译说明](../../docs/translation-automation.md)。以下旧采集模板说明中的“无AI”仅指采集步骤本身。

- `daily-collect.yml.example`：测试 → 校验已有论文库 → 19刊双源采集 → 校验保存结果 → 仅暂存完整正式历史 → 普通提交/推送 → 构建网页 → 可选发布。对应的实际工作流已启用北京时间08:17和13:17日程，并保留手动入口。两次均使用`--only-if-needed`：当天19刊双源完整成功且范围覆盖才跳过；否则13:17重新查询全19刊，不只重试异常期刊。次日重新采集，含当天回查60天。
- `deploy-pages.yml.example`：只手动发布已保存的数据，不采集、不翻译、不修改论文。适合导入中文后更新网站，或修正网页后重新发布。

两个流程共用`journal-production`并发组，排队而不取消正在运行的采集；仅允许默认分支，采集和发布仍各有默认关闭的启用开关。数据推送如果与新提交冲突会停止，不强推、不重置或自动合并用户改动。应先核查并重新运行。

采集步骤允许来源失败后继续校验、保存可用论文和失败日志；最后会单独将来源失败报告为工作流失败，不把部分失败涂成绿色。旧库校验失败、历史缺失、暂存异常、推送失败或网页构建失败会阻断后续发布。

## 启用开关与权限

模板需要仓库变量 `JOURNAL_AUTOMATION_ENABLED` 和 `JOURNAL_PAGES_ENABLED`，只有字符串 `true` 才分别允许采集和发布。这些是开关，不是密钥；目前两者都已设置为true，Pages采用GitHub Actions工作流构建方式，公开访问并强制HTTPS。手动和定时采集均在校验保存后更新网站；关闭本机电脑不影响服务器日程。

若需要暂停采集，将`JOURNAL_AUTOMATION_ENABLED`改为`false`即可阻止后续采集任务；网站仍保留最近发布版本。若只暂停网页更新，则将`JOURNAL_PAGES_ENABLED`改为`false`。开关不取消已经开始的任务，需先查看正在运行的工作流；不要删除正式数据或直接关闭已发布网站。恢复时改回`true`，并确认工作流未因长期无活动被GitHub停用。

采集及翻译任务使用 `contents: write` 将**正式论文库和翻译请求登记**提交到同一仓库的默认分支。发布任务仅申请 `pages: write` 和 `id-token: write`，通过 `github-pages` 环境。保存使用GitHub自动提供的运行令牌；仅翻译步骤另外读取DeepSeek密钥，网页包不包含密钥或请求登记。

**网页包不含来源原始页，但公开仓库中的正式历史会包含来源原始记录。** 此范围已获用户同意。首次提交前仍核查目标仓库和明确文件清单，不上传整个工作目录、密钥或个人阅读数据，也不绕过分支保护规则。

继续采用同仓库保存正式数据、GitHub Pages发布精简网页的方案，不需要为私有Pages升级套餐或引入另一家托管服务。实际启用仍取决于账户和仓库权限核验。参见 [GitHub Pages创建条件](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)。

手动发布流程默认不监听 `push`。导入翻译并提交后，需再手动运行发布；要自动随推送发布，应在后续获得授权后增加事件。采集工作流自身串联发布，因此不依赖机器人提交再次触发另一个工作流。

## 固定的官方组件

本模板固定到已核对的完整提交，而非会移动的主版本标签；这不代表对组件依赖做了全面安全审计。启用前应再次核对支持状态：

- [checkout v6 系列提交](https://github.com/actions/checkout/commit/d23441a48e516b6c34aea4fa41551a30e30af803)
- [setup-node v6.5.0](https://github.com/actions/setup-node/commit/249970729cb0ef3589644e2896645e5dc5ba9c38)
- [configure-pages v5](https://github.com/actions/configure-pages/commit/983d7736d9b0ae728b81ab479565c72886d7745b)
- [upload-pages-artifact v5.0.0](https://github.com/actions/upload-pages-artifact/commit/fc324d3547104276b827a68afc52ff2a11cc49c9)
- [deploy-pages v4](https://github.com/actions/deploy-pages/commit/d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e)

发布所需的任务依赖、环境及权限参考 [GitHub Pages 官方工作流说明](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。GitHub 定时执行可能延迟，公开仓库长期无活动还可能停用日程，因此不能承诺每天精确到分钟送达；见 [定时事件说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。

本地测试只验证代码和模板结构。账号权限、分支保护、服务器测试、采集及推送已实机核对；2026-09-10独立发布流程的Pages配置检查、8文件网页包上传及部署也已通过，真实网站免登录访问、中文搜索和日期详情已复核。采集来源质量警告与网站部署结果分别记录，不混为同一种失败。

2026-09-09核对官方上传组件后更新为v5.0.0固定提交。显式开启`include-hidden-files`以保留`.nojekyll`，但目录仍限定为已校验的8文件网页包，不指向仓库根目录或正式论文库。[官方发布记录](https://github.com/actions/upload-pages-artifact/releases/tag/v5.0.0)；[参数定义](https://raw.githubusercontent.com/actions/upload-pages-artifact/v5.0.0/action.yml)。全套186项测试通过；此上传组件已在2026-09-10正式发布流程中成功执行。
