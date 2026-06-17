# PaperRadar

一个面向 arXiv 的每日论文雷达：按订阅条件抓取候选论文、自动打分排序，并提供按日期浏览、PDF 阅读、AI 解读和论文问答。

## 仓库名建议

- `paper-radar`（推荐）
- 备选：`arxiv-radar-daily`、`arxiv-paper-radar`

## 功能概览

- 日期视图：
  - 首页 `/`：论文日历
  - 详情页 `/day.html?date=YYYY-MM-DD`：查看当日推荐列表
  - 阅读页 `/paper.html?date=...&paperId=...`：PDF + 论文信息 + AI 解读 + Chat
- 推荐逻辑：
  - 支持自然语言查询（`queries`）
  - 支持关注作者（`people`）与主题论文（`papers`）
  - 支持作者追踪（`authorTracks`）：按作者增量检查新论文，并检查订阅日是否有更新
  - 每次按目标日期当天检索，并支持最低分阈值（`minScore`）
  - 有 arXiv 限流（429）时会自动退避重试并给出提示
- AI 能力：
  - 流式论文摘要
  - 基于用户关注方向生成“研究启发”
  - 基于论文内容（含 PDF 文本抽取）的流式问答
  - 每日刷新后使用已配置的 LLM API 润色 Markdown 日报；未配置或失败时回退模板日报

## 快速开始

```bash
npm install
cp .env.example .env
npm run dev
```

默认访问：`http://localhost:3000`

## 配置说明

本项目默认不会把本地配置上传到 git。`.env` 和 `data/` 都已被忽略：

- `.env`：适合放部署环境变量，例如 `LLM_API_KEY`、`JINA_API_KEY`
- `data/`：运行时本地状态，包括订阅、刷新历史、日报、收藏、AI 缓存和网页设置页保存的 LLM 配置

公开部署或提交代码前，不要把真实 API key 写进源码、README 或样例文件。

在设置页可配置：

- 订阅配置（`/api/subscriptions`）
  - `queries`: 每行一条自然语言查询
  - `minScore`: 推荐分阈值（0-40）
  - `people`: 关注作者列表
  - `papers`: 关注主题/论文关键词
  - `authorTracks`: 作者追踪列表，支持以下字段
    - `name` (必填): 作者展示名
    - `subscribedDate`: 订阅起始日（`YYYY-MM-DD`）
    - `scholarId` / `scholarUrl` (可选): Google Scholar ID 或主页链接；系统会优先通过 Jina Reader 读取 Scholar 主页，必要时回退到直接读取 Scholar HTML，并用已配置的 LLM API 抽取论文列表。未填写 `query=` 时会禁用 arXiv 裸姓名检索，避免同名误报。
    - `orcid` (可选): ORCID
    - `arxivAuthorQuery` (可选): 覆盖默认作者查询（例如 `au:Andrew Ng`）
  - `insightInterests`: 论文“研究启发”模块关注方向列表，每行一个
    - `我关心这篇论文对 RAG 系统设计有什么可迁移启发`
    - `我想知道哪些实验或指标值得在我的项目里复现`
  - 设置面板输入示例（每行一位作者）
    - `Yuzheng Cai | from=2026-03-01 | scholar=https://scholar.google.com/citations?user=xxxx`
    - `Yoshua Bengio | from=2026-03-10 | query=Yoshua Bengio`
- LLM 配置（`/api/llm/settings`）
  - `baseUrl`（默认 `https://api.openai.com/v1`）
  - `apiKey`
  - `model`、`temperature`、`maxTokens`
  - `summaryPrompt`
  - 也可以通过环境变量配置：`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`、`LLM_TEMPERATURE`、`LLM_MAX_TOKENS`

## 常用命令

- `npm run dev`：开发模式启动（watch）
- `npm start`：普通启动
- `npm run refresh`：执行一次当日推荐抓取并退出

长期后台运行可参考：[部署说明](docs/deployment.md)。

## 定时刷新

服务端启动后会自动做两件事：

- 默认每天 `08:10` 自动刷新当天推荐，并写入 `data/digests.json`
- 启动时如果当天还没有缓存，会在后台自动刷新一次

因此日常使用时建议让服务保持运行：

```bash
npm start
```

可通过环境变量调整：

```bash
REFRESH_CRON="30 7 * * *" REFRESH_TIMEZONE="Asia/Shanghai" npm start
```

- `REFRESH_CRON`：cron 表达式，默认 `10 8 * * *`
- `REFRESH_CATCHUP_CRON`：补刷检查 cron 表达式，默认 `0 13 * * *`
- `REFRESH_TIMEZONE`：定时刷新使用的时区，默认读取系统时区
- `REFRESH_RETRY_MINUTES`：失败/部分失败后的重试间隔，默认 `30`
- `REFRESH_RETRY_LIMIT`：单轮刷新最多自动重试次数，默认 `3`
- `REFRESH_ON_STARTUP=false`：关闭启动时自动补刷当天推荐
- `ENABLE_DESKTOP_NOTIFICATIONS=false`：关闭 macOS 桌面通知
- `CATCHUP_LOOKBACK_DAYS`：补刷最近缺失日期窗口，默认 `7`
- `CATCHUP_FAILED_LOOKBACK_DAYS`：补刷失败/部分失败/中断历史窗口，默认 `30`

如果不想长期运行 Node 服务，也可以用系统定时任务每天执行：

```bash
npm run refresh
```

## 主要接口

- `POST /api/digest/refresh`：刷新指定日期推荐（body 可传 `date`）
- `POST /api/digest/fetch/:date`：抓取并保存某日推荐
- `GET /api/digest/dates`：获取已有推荐日期列表
- `GET /api/digest/:date`：读取某日推荐
- `GET /api/author-tracks/status?date=YYYY-MM-DD`：读取/计算某日作者追踪状态
- `POST /api/author-tracks/check`：主动执行作者追踪检查（body 可传 `date`）
- `GET /api/paper?date=...&paperId=...`：读取单篇论文
- `GET /api/paper/ai?date=...&paperId=...`：读取本地保存的论文解读/研究启发
- `PUT /api/paper/ai`：保存本地论文解读/研究启发
- `GET /api/marks/summary`：查看各日期收藏计数
- `GET /api/marks/:date`：读取某日收藏
- `PUT /api/marks/:date`：覆盖某日收藏
- `POST /api/marks/:date/toggle`：切换单篇收藏
- `POST /api/llm/summarize`：非流式论文解读
- `POST /api/llm/summarize/stream`：流式论文解读
- `POST /api/llm/insight/stream`：根据用户关注方向流式生成研究启发
- `POST /api/llm/chat/stream`：流式论文问答

## 数据文件

项目运行时会在 `data/` 下维护：

- `subscriptions.json`
- `llm-settings.json`
- `digests.json`
- `marks.json`
- `author-track-state.json`
- `paper-ai-cache.json`
