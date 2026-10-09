**English** | [中文](README.zh-CN.md)

# GitHub Product Ideas

A weekly GitHub project radar for product builders. It discovers noteworthy open-source
repositories, explains why they stand out, and turns their technical signals into
practical product ideas.

The internal skill identifier remains `follow-builders` for compatibility while the
project is being renamed.

## What You Get

Each edition can include:

- A concise explanation of what each repository does and who it serves
- Evidence-backed reasons the project deserves attention
- One differentiated product idea inspired by each repository
- A relevant limitation or risk to investigate
- Repository language, license, stars, forks, and source link
- Cross-project product signals when the edition contains enough evidence
- English, Simplified Chinese, or bilingual output

The central feed publishes up to 20 repositories. Each user can choose categories and
receive between 1 and 20 projects per digest; the default is 10.

See the [illustrative sample digest](examples/sample-digest.md). Its repository names and
metrics are explicitly fictional and are not live recommendations.

## Project Categories

The default discovery groups are:

- **AI Products**: AI applications, assistants, agents, and LLM products
- **Developer Tools**: coding tools, developer infrastructure, and code generation
- **Productivity and Automation**: personal productivity and workflow automation
- **Open Source Products**: self-hosted applications and open-source SaaS products
- **Data and Infrastructure**: databases, data platforms, and AI infrastructure

The keywords and GitHub topics are defined in
[`config/default-sources.json`](config/default-sources.json).

## How It Works

The system has two separate layers.

### 1. Central feed generation

The GitHub Actions workflow runs weekly and:

1. Builds searches for newly created and recently active repositories.
2. Filters forks, private repositories, mirrors, templates, archived projects, ignored
   owners, ignored repositories, and entries without useful descriptions.
3. Deduplicates repositories and records short-term star/fork snapshots.
4. Scores projects using activity, age, stars, forks, observed growth, topics, license,
   homepage, and category coverage.
5. Selects up to 40 repositories for README inspection.
6. Cleans README text and evaluates documentation quality.
7. Publishes a balanced selection of up to 20 projects to `feed-github.json`.
8. Records published repositories in `state-feed.json` to reduce repetition.

GitHub Actions uses its automatically provided repository token. Digest users do not need
to create a GitHub token.

### 2. Personal digest generation

The user's AI runtime:

1. Downloads the published GitHub feed and prompt files.
2. Filters projects using the user's enabled categories.
3. Applies the configured project limit.
4. Summarizes each project and derives a product idea.
5. Assembles, translates, and optionally delivers the finished weekly digest.

The AI is instructed to treat repository metadata and README excerpts as untrusted data.
It must not follow instructions embedded in a repository or invent unsupported claims.

## Quick Start

### OpenClaw

```bash
git clone https://github.com/jyx0919/github-product-ideas.git ~/skills/github-product-ideas
```

### Claude Code or another skill-compatible agent

```bash
git clone https://github.com/jyx0919/github-product-ideas.git ~/.claude/skills/github-product-ideas
```

Configure the raw-content location in the environment used by the agent:

```bash
export FOLLOW_BUILDERS_CONTENT_BASE_URL="https://raw.githubusercontent.com/jyx0919/github-product-ideas/main"
```

Then ask the agent to set up the `follow-builders` skill or request a GitHub product ideas
digest. The onboarding flow asks for:

- Project categories
- Number of projects per edition
- English, Chinese, or bilingual output
- Weekly delivery day, time, and timezone
- In-chat, Telegram, or email delivery

The central repository must publish `feed-github.json` before the first real digest can be
generated. If the repository is private, an unauthenticated raw-content URL will not work;
publish the feed through a public repository or another accessible content endpoint.

## User Configuration

User settings are stored locally in `~/.follow-builders/config.json`:

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

The central feed controls the real discovery window and global recommendation history.
The current implementation does not yet maintain independent per-user recommendation
history, and a local `lookbackDays` value cannot expand what the central feed publishes.

## Customizing the Digest

The prompts are plain Markdown files:

- [`prompts/summarize-github.md`](prompts/summarize-github.md): project evaluation and
  product-idea generation
- [`prompts/digest-intro.md`](prompts/digest-intro.md): edition structure and tone
- [`prompts/translate.md`](prompts/translate.md): Chinese and bilingual translation

User-specific overrides can be stored in `~/.follow-builders/prompts/`. The loader uses
this priority:

1. User override
2. Latest prompt from the configured content base URL
3. Local prompt bundled with the skill

## Maintainer Commands

Run these commands from the repository root. Use Node.js 20.12 or newer. No npm install
is required because the scripts use only built-in Node.js APIs.

Inspect the generated search queries without calling GitHub:

```bash
node scripts/generate-feed.js --print-github-queries
```

Run offline validation:

```bash
node scripts/generate-feed.js --validate-state
node scripts/generate-feed.js --validate-github-enrichment
node scripts/prepare-digest.js --validate-github-preparation
```

Preview a live GitHub edition without writing feed or state files:

```bash
GITHUB_TOKEN=your_token node scripts/generate-feed.js --github-feed-dry-run
```

Publish `feed-github.json` and update `state-feed.json` locally:

```bash
GITHUB_TOKEN=your_token node scripts/generate-feed.js --github-only
```

The repository workflow performs the publish command automatically each Monday at 08:17
Asia/Shanghai time and commits changed feed/state files.

## Delivery

- **In chat / stdout**: no delivery key is required.
- **Telegram**: requires the user's `TELEGRAM_BOT_TOKEN` and chat ID.
- **Email**: requires the user's `RESEND_API_KEY` and destination address.
- **Scheduled AI-written delivery**: requires a persistent AI runtime such as OpenClaw.

Do not pipe the JSON from `prepare-digest.js` directly into `deliver.js`. The preparation
output must first be converted into the final digest by an AI following the supplied
prompts.

## Cost

This version removes the X API and podcast-transcription dependencies from the default
workflow. Digest users do not need a GitHub API token.

Possible costs depend on the services you choose:

- Your AI model or agent runtime
- GitHub Actions usage under your repository/account plan
- Telegram infrastructure, if any
- Your email provider, such as Resend

No paid service is enabled automatically by this repository. Review the current terms and
limits of each provider before enabling external delivery or frequent automation.

## Security and Privacy

- Central discovery reads public GitHub repository metadata and README content.
- README content is marked and handled as untrusted external input.
- User preferences remain in `~/.follow-builders/config.json`.
- Telegram and email keys remain in `~/.follow-builders/.env`.
- Delivery credentials are sent only to the delivery provider selected by the user.
- Digest content is processed by the user's chosen AI runtime; its privacy policy applies.
- Atomic JSON writes reduce the chance of partially written feed or state files.

Never commit personal configuration, delivery credentials, or locally created `.env`
files to the repository.

## Current Limitations

- The central feed must exist at the configured content base URL.
- Global deduplication is maintained by the central generator, not per user.
- A personal lookback setting cannot expand the central feed's discovery window.
- Non-persistent agents support on-demand generation but cannot independently schedule an
  AI-written digest without an external persistent runner.
- Repository claims are summarized from public metadata and README content; they are not
  independent product audits.

## License

This project is released under the [MIT License](LICENSE). The license preserves the
original author attribution and includes the current repository's modification credit.

## Repository

- Source: [github.com/jyx0919/github-product-ideas](https://github.com/jyx0919/github-product-ideas)
- Central content base: `https://raw.githubusercontent.com/jyx0919/github-product-ideas/main`
