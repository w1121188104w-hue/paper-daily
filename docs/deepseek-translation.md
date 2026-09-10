# DeepSeek翻译：自动流程与历史试译

2026-09-10更新：用户已明确授权全库和每日自动翻译，并取消逐篇校对。当前操作请看[自动翻译说明](translation-automation.md)。下文保留最初手动试译的历史操作，不是当前自动流程要求；不要使用旧试译入口重复请求已处理论文。缺失摘要不补写，已有完成中文不重译。

## 已配置的入口

仓库的 Settings → Secrets and variables → Actions → Secrets 中保存 `DEEPSEEK_API_KEY`。密钥不能放 Variables、代码、网页或聊天。只有翻译步骤能读取此 Secret；本机不需要取出它。

模型使用 `deepseek-flash`，关闭思考模式，仅返回JSON译文；请求只发往 DeepSeek 官方 HTTPS 接口，不跟随重定向。每篇仅一次请求、最多10篇，单篇输入最多20,000字节、整批最多100,000字节，每次输出最多4,096 tokens；超限直接停止，不截断英文。失败不自动重试，以免不确定是否已计费的请求被重复扣费。

采用[官方模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)和[Chat API说明](https://api-docs.deepseek.com/api/create-chat-completion/)。2026-09-10查得Flash高峰无缓存输入2元/百万tokens、输出8元/百万tokens，用于保守估算已知用量；它不是平台强制金额上限，实际费用以DeepSeek账单为准。后续扩大规模前重新检查价格、译文质量与用量。

## 为什么试译文件要加密

本仓库公开，Actions附件也不能当作私人空间。因此上传的附件只含加密内容，不能直接读取未审核译文。使用Node内置RSA-OAEP-SHA256与AES-256-GCM；解密私钥只生成、保存在本机已被Git忽略的 `data/journal-store/translations/review-keys/`，不会进入GitHub。这里的公钥只用于加密草稿，不是另一把API密钥。

## 维护者的操作顺序

1. `node scripts/deepseek-translate.js --plan` 只读查看规模，不收费、不写文件。
2. `node scripts/deepseek-translate.js --prepare-review` 生成本机解密文件。妥善保留文件与返回的 `key_id`；只复制 `public_key` 到工作流输入框。
3. GitHub Actions → **DeepSeek translation pilot (max 10, encrypted review only)** → Run workflow，选择默认分支，填写公钥并明确勾选10篇付费试译确认。不要把API密钥填入输入框。
4. 一次只运行一批。工作流禁止点击Re-run重做付费步骤；如果再次新建Run workflow，那是另一轮显式付费请求，不能当作免费重试。本机同一批次的 `started.json` 也阻止重复调用。
5. 下载 `deepseek-encrypted-review-运行编号` 附件到本机被Git忽略的工作目录。只打开编号最大的 `review-XX.json`，其中包含累计结果。附件7天后过期；任务中断前已完成的检查点仍可检查，不能据此盲目重跑。
6. `node scripts/deepseek-translate.js --open-review "密文文件完整路径" --key-id "本机指纹"` 解密到本机工作目录，不改正式论文。解密失败不要改文件或尝试跳过校验。
7. 逐篇对照英文审查中文；程序的数字、中文、长度检查不能判断语义准确。未通过的字段不导入，缺失摘要保持缺失。
8. 使用既有 `node scripts/translations.js --import "response.json完整路径"` 先预检；审阅通过后再加 `--save`。原文指纹不一致的旧译文不得硬塞回当前论文。
9. 校验正式库、用正式历史白名单暂存、提交并手动发布。翻译流程自身没有仓库写权限，不会自动导入或改网站。

错误码 `AUTH_ERROR` / `ACCESS_DENIED` 表示密钥或权限需要检查；`INSUFFICIENT_BALANCE` 表示余额不足；`TIMEOUT` / `NETWORK_ERROR` 表示结果和费用可能不确定。先查看结果与账单，不要连续重新运行。日志只含计数、固定错误码和已知用量，不输出原始错误正文、密钥、推理内容或译文草稿。

### 中断后的人工续接

这不是自动重试。维护者必须先下载并解密上一段最后一个检查点，核实累计请求数和批次指纹。只有确认前N篇已实际请求、其余尚未请求时，才可用同批次的 `skip_first=N` 与 `expected_batch=原批次指纹` 人工续接剩余条目。已请求的失败论文也必须跳过，不能重新计入本轮预算。原文或队列变化导致指纹不同则停止；不靠猜测跳过条目。同一次10篇试验，各段的请求数相加不得超过10。

不合格的模型正文仅保留在加密审阅附件的 `review_rejections`，不进入可导入译文，不打印在公开日志；首次试运行之前的版本未保存这部分正文，因此不能还原当时的具体错误格式。各检查点在本机分开保存，不覆盖旧审阅文件。

对于已经完整收到、用量可核实但JSON格式不合格的单篇译文，新版会隔离这篇并继续尚未请求的论文，不重发失败条目；网络、账号、模型或输出截断问题仍停止整段。这不是放宽正式导入标准。

实机核对发现模型有时返回 `title` / `abstract`，而不是提示中指定的 `title_zh` / `abstract_zh`。现只兼容这两套**完整且无歧义**的键名组合，仍拒绝混用、多余字段、外层包装和模型自行提供的论文ID。转换只重命名键，不改变英文指纹、不增写摘要；后续仍执行原有中文、数字、长度和正式导入校验。逐条记录实际返回的模型名和时间，便于审阅异常结果。
