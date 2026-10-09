[English](README.md) | **中文**

# GitHub Product Ideas

一份面向产品创造者的 GitHub 项目周报。它会定期发现值得关注的开源项目，解释这些
项目为什么亮眼，并从技术和产品信号中提炼可以落地的产品 Ideas。

在项目完成正式改名之前，Skill 的内部技术标识暂时保留为 `follow-builders`，以免破坏
现有的安装和调用方式。

## 你会得到什么

每期周报可以包含：

- 项目是什么、适合谁使用
- 项目值得关注的证据，而不只是宣传语
- 从每个项目延伸出的差异化产品 Idea
- 值得进一步调查的风险或限制
- 编程语言、许可证、Star、Fork 和原始仓库链接
- 有足够证据时，对多个项目进行跨项目趋势总结
- 英文、简体中文或中英双语输出

中央 Feed 每期最多发布 20 个项目。用户可以选择关注的分类，并设置每期接收 1 至
20 个项目，默认是 10 个。

可以查看[周报格式示例](examples/sample-digest.md)。示例中的仓库名和指标均明确标注为
虚构数据，不代表当前的真实推荐。

## 项目分类

默认包含 5 个发现方向：

- **AI 产品**：AI 应用、助手、Agent 和 LLM 产品
- **开发者工具**：编程工具、开发基础设施和代码生成
- **效率与自动化**：个人效率和工作流自动化
- **开源产品**：可自托管应用和开源 SaaS 产品
- **数据与基础设施**：数据库、数据平台和 AI 基础设施

关键词和 GitHub Topics 配置在
[`config/default-sources.json`](config/default-sources.json) 中。

## 工作原理

整个系统分为两个相互独立的层次。

### 1. 中央 Feed 生成

GitHub Actions 每周执行一次以下流程：

1. 为新创建项目和近期活跃项目生成搜索条件。
2. 过滤 Fork、私有仓库、镜像、模板、归档项目、被忽略的作者和仓库，以及缺少有效
   描述的项目。
3. 根据仓库 ID 去重，并保存短期 Star 和 Fork 快照。
4. 根据活跃度、项目年龄、Star、Fork、可观测增长、Topics、许可证、主页和分类覆盖
   进行评分。
5. 均衡选出最多 40 个仓库读取 README。
6. 清洗 README，并评估文档是否包含安装、用法、示例和 Demo 等信息。
7. 最终选出最多 20 个项目，发布到 `feed-github.json`。
8. 将已发布项目记录到 `state-feed.json`，减少重复推荐。

GitHub Actions 使用仓库自动提供的 Token。普通周报用户不需要创建或提供
`GITHUB_TOKEN`。

### 2. 个人周报生成

用户自己的 AI 运行环境会：

1. 下载中央 GitHub Feed 和提示词。
2. 根据用户选择的分类过滤项目。
3. 应用每期项目数量限制。
4. 总结每个项目并提炼产品 Idea。
5. 组装、翻译并按需推送最终周报。

AI 会把仓库元数据和 README 摘要视为不可信外部数据，不执行仓库内容中的指令，也
不能虚构没有证据支持的产品能力。

## 快速开始

### OpenClaw

```bash
git clone https://github.com/jyx0919/github-product-ideas.git ~/skills/github-product-ideas
```

### Claude Code 或其他兼容 Skill 的 Agent

```bash
git clone https://github.com/jyx0919/github-product-ideas.git ~/.claude/skills/github-product-ideas
```

在 Agent 的运行环境中配置中央内容地址：

```bash
export FOLLOW_BUILDERS_CONTENT_BASE_URL="https://raw.githubusercontent.com/jyx0919/github-product-ideas/main"
```

然后让 Agent 配置 `follow-builders` Skill，或者直接请求一份 GitHub 产品 Ideas 周报。
首次配置会询问：

- 想关注的项目分类
- 每期项目数量
- 英文、中文或双语输出
- 每周推送日期、时间和时区
- 在对话中显示，或者通过 Telegram、邮件推送

生成第一份真实周报前，中央仓库必须先发布 `feed-github.json`。如果仓库是私有的，
匿名用户无法读取 Raw 地址；这时需要通过公开仓库或其他可访问的内容服务发布 Feed。

## 用户配置

用户设置保存在本机的 `~/.follow-builders/config.json`：

```json
{
  "platform": "other",
  "language": "zh",
  "timezone": "Asia/Shanghai",
  "frequency": "weekly",
  "deliveryTime": "08:00",
  "weeklyDay": "monday",
  "delivery": {
    "method": "stdout"
  },
  "githubPreferences": {
    "enabledGroups": [
      "ai-products",
      "developer-tools",
      "productivity-automation",
      "open-source-products",
      "data-infrastructure"
    ],
    "lookbackDays": 7,
    "maxProjectsPerDigest": 10,
    "allowPreviouslyFeatured": false
  },
  "onboardingComplete": true
}
```

实际发现时间范围和全局推荐历史由中央 Feed 控制。当前版本还没有为每个用户维护独立
的推荐历史，本地 `lookbackDays` 也不能扩大中央 Feed 已发布的时间范围。

## 自定义周报

所有提示词都是普通 Markdown 文件：

- [`prompts/summarize-github.md`](prompts/summarize-github.md)：项目评估和产品 Idea 生成
- [`prompts/digest-intro.md`](prompts/digest-intro.md)：整期周报的结构和语气
- [`prompts/translate.md`](prompts/translate.md)：中文和双语翻译规则

用户自己的提示词可以存放在 `~/.follow-builders/prompts/`。程序按以下优先级加载：

1. 用户自定义提示词
2. 配置的内容源地址中的最新提示词
3. Skill 自带的本地默认提示词

## 维护者命令

以下命令从仓库根目录运行，需要 Node.js 20.12 或更高版本。脚本只使用 Node.js
内置 API，不需要执行 `npm install`。

只查看 GitHub 搜索条件，不调用 GitHub：

```bash
node scripts/generate-feed.js --print-github-queries
```

执行离线验证：

```bash
node scripts/generate-feed.js --validate-state
node scripts/generate-feed.js --validate-github-enrichment
node scripts/prepare-digest.js --validate-github-preparation
```

预览真实 GitHub 抓取结果，但不写入 Feed 和状态文件：

```bash
GITHUB_TOKEN=your_token node scripts/generate-feed.js --github-feed-dry-run
```

在本地正式生成 `feed-github.json` 并更新 `state-feed.json`：

```bash
GITHUB_TOKEN=your_token node scripts/generate-feed.js --github-only
```

仓库中的 GitHub Actions 工作流会在每周一北京时间 08:17 自动执行正式生成命令，并
提交发生变化的 Feed 和状态文件。

## 推送方式

- **对话或终端输出**：不需要推送 API Key。
- **Telegram**：需要用户自己的 `TELEGRAM_BOT_TOKEN` 和 Chat ID。
- **邮件**：需要用户自己的 `RESEND_API_KEY` 和收件地址。
- **定时生成 AI 周报**：需要 OpenClaw 等能够持续运行的 AI 环境。

不要把 `prepare-digest.js` 产生的 JSON 直接传给 `deliver.js`。准备结果必须先由 AI 按照
提示词生成可读周报，然后才能推送。

## 费用

当前版本已经从默认流程中移除了 X API 和播客转写服务。普通周报用户不需要 GitHub
API Token。

是否产生费用取决于你主动选择的服务：

- 使用的 AI 模型或 Agent 运行环境
- 你的 GitHub 仓库和账户方案下的 GitHub Actions 用量
- Telegram 相关基础设施（如果有）
- Resend 等邮件服务

仓库不会自动开通任何付费服务。启用外部推送或高频自动化前，请自行查看各服务当前
的计费方式和使用限制。

## 安全与隐私

- 中央发现流程读取公开 GitHub 仓库的元数据和 README。
- README 被标记并作为不可信外部输入处理。
- 用户偏好保存在 `~/.follow-builders/config.json`。
- Telegram 和邮件密钥保存在 `~/.follow-builders/.env`。
- 推送密钥只会发送给用户主动选择的推送服务商。
- 周报内容由用户选择的 AI 运行环境处理，其隐私政策同样适用。
- JSON 原子写入可以降低 Feed 或状态文件只写入一部分的风险。

不要把个人配置、推送密钥或本地创建的 `.env` 文件提交到仓库。

## 当前限制

- 中央 Feed 必须存在于配置的内容源地址中。
- 去重由中央生成器全局维护，目前不是每个用户独立维护。
- 个人的回溯天数不能扩大中央 Feed 的发现时间范围。
- 非持久化 Agent 支持按需生成，但没有外部持久运行环境时，不能独立定时生成 AI 周报。
- 项目能力来自公开元数据和 README 摘要，不代表已经完成独立产品审计。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。许可证保留原项目作者署名，同时记录当前仓库的
改造贡献。

## 项目仓库

- 源代码：[github.com/jyx0919/github-product-ideas](https://github.com/jyx0919/github-product-ideas)
- 中央内容地址：`https://raw.githubusercontent.com/jyx0919/github-product-ideas/main`
