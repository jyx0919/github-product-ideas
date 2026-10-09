#!/usr/bin/env node

// ============================================================================
// GitHub Product Ideas — Central Feed Generator
// ============================================================================
// The primary GitHub Actions workflow runs weekly to discover noteworthy public
// repositories and publish feed-github.json.
//
// Repository snapshots and previously featured projects are tracked in
// state-feed.json for trend scoring and global deduplication.
//
// Primary usage:
//   node generate-feed.js --github-feed-dry-run
//   node generate-feed.js --github-only
//   node generate-feed.js --validate-github-enrichment
//
// GITHUB_TOKEN is required for reliable live GitHub generation. Legacy X,
// podcast, and blog modes remain available as compatibility-only entry points;
// they use X_BEARER_TOKEN and POD2TXT_API_KEY when selected.
// ============================================================================

import { readFile, writeFile, rename } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

// -- Constants ---------------------------------------------------------------

const POD2TXT_BASE = "https://pod2txt.vercel.app/api";
const X_API_BASE = "https://api.x.com/2";
const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
// Some RSS hosts (notably Substack) block non-browser user agents from cloud IPs.
// Using a real Chrome UA avoids 403 errors in GitHub Actions.
const RSS_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TWEET_LOOKBACK_HOURS = 24;
const PODCAST_LOOKBACK_HOURS = 336; // 14 days — podcasts publish weekly/biweekly, not daily
const BLOG_LOOKBACK_HOURS = 72;
const MAX_TWEETS_PER_USER = 3;
const MAX_ARTICLES_PER_BLOG = 3;
const X_USER_LOOKUP_BATCH_SIZE = 5;
const X_RETRY_STATUSES = new Set([500, 502, 503, 504]);
const X_RETRY_ATTEMPTS = 3;
const GITHUB_SEARCH_RESULTS_PER_QUERY = 20;
const GITHUB_RETRY_STATUSES = new Set([500, 502, 503, 504]);
const GITHUB_RETRY_ATTEMPTS = 3;
const GITHUB_DEFAULT_LOOKBACK_DAYS = 7;
const GITHUB_ENRICHMENT_LIMIT = 40;
const GITHUB_ENRICHMENT_LIMIT_PER_GROUP = 8;
const GITHUB_FEED_LIMIT = 20;
const GITHUB_FEED_LIMIT_PER_GROUP = 4;
const GITHUB_README_MIN_CHARACTERS = 300;
const GITHUB_README_MAX_CHARACTERS = 12000;
const STATE_VERSION = 2;
const REPOSITORY_SNAPSHOT_RETENTION_DAYS = 30;

// State file lives in the repo root so it gets committed by GitHub Actions
const SCRIPT_DIR = decodeURIComponent(new URL(".", import.meta.url).pathname);
const STATE_PATH =
  process.env.FOLLOW_BUILDERS_STATE_PATH ||
  join(SCRIPT_DIR, "..", "state-feed.json");
const GITHUB_FEED_PATH =
  process.env.FOLLOW_BUILDERS_GITHUB_FEED_PATH ||
  join(SCRIPT_DIR, "..", "feed-github.json");

// -- State Management --------------------------------------------------------

// Keeps legacy deduplication data while the feed migrates to GitHub projects.
// Repository snapshots are short-lived trend data; featured repositories are
// retained separately so previously recommended projects stay deduplicated.

function createEmptyState() {
  return {
    version: STATE_VERSION,
    seenTweets: {},
    seenVideos: {},
    seenArticles: {},
    repositorySnapshots: {},
    featuredRepositories: {},
    lastSuccessfulRun: null,
  };
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function normalizeState(state) {
  const emptyState = createEmptyState();
  const source = asRecord(state);

  return {
    ...emptyState,
    ...source,
    version: STATE_VERSION,
    seenTweets: asRecord(source.seenTweets),
    seenVideos: asRecord(source.seenVideos),
    seenArticles: asRecord(source.seenArticles),
    repositorySnapshots: asRecord(source.repositorySnapshots),
    featuredRepositories: asRecord(source.featuredRepositories),
  };
}

async function writeJSONAtomic(path, value) {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2));
  await rename(temporaryPath, path);
}

async function loadState() {
  if (!existsSync(STATE_PATH)) {
    return createEmptyState();
  }
  try {
    const state = JSON.parse(await readFile(STATE_PATH, "utf-8"));
    return normalizeState(state);
  } catch (err) {
    throw new Error(`Failed to load state file: ${err.message}`);
  }
}

async function saveState(state) {
  const normalized = normalizeState(state);

  // Keep the legacy feeds working during migration.
  const legacyCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const key of ["seenTweets", "seenVideos", "seenArticles"]) {
    for (const [id, timestamp] of Object.entries(normalized[key])) {
      if (timestamp < legacyCutoff) delete normalized[key][id];
    }
  }

  // Retain enough history to calculate daily and weekly repository growth.
  const snapshotCutoff =
    Date.now() -
    REPOSITORY_SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  for (const [repositoryId, repository] of Object.entries(
    normalized.repositorySnapshots,
  )) {
    const snapshots = Array.isArray(repository?.snapshots)
      ? repository.snapshots
      : [];

    repository.snapshots = snapshots.filter(
      (snapshot) =>
        new Date(snapshot?.capturedAt).getTime() >= snapshotCutoff,
    );

    if (repository.snapshots.length === 0) {
      delete normalized.repositorySnapshots[repositoryId];
    }
  }

  // Write atomically so an interrupted job cannot leave partial JSON behind.
  await writeJSONAtomic(STATE_PATH, normalized);
}

// -- Load Sources ------------------------------------------------------------

async function loadSources() {
  const sourcesPath = join(SCRIPT_DIR, "..", "config", "default-sources.json");
  return JSON.parse(await readFile(sourcesPath, "utf-8"));
}

// -- GitHub Repository Discovery --------------------------------------------

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function quoteGitHubSearchTerm(value) {
  const term = String(value || "")
    .replace(/"/g, "")
    .trim();
  if (!term) return null;
  return term.includes(" ") ? `"${term}"` : term;
}

function buildGitHubSearchQueries(githubConfig, now = new Date()) {
  const lookbackDays = clampInteger(
    githubConfig?.lookbackDays,
    GITHUB_DEFAULT_LOOKBACK_DAYS,
    1,
    30,
  );
  const cutoff = new Date(
    now.getTime() - lookbackDays * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);
  const groups = Array.isArray(githubConfig?.discoveryGroups)
    ? githubConfig.discoveryGroups.filter((group) => group?.enabled !== false)
    : [];
  const dayNumber = Math.floor(now.getTime() / (24 * 60 * 60 * 1000));
  const queries = [];

  for (const group of groups) {
    if (!group?.id) continue;

    const keywordTerms = (Array.isArray(group.keywords) ? group.keywords : [])
      .map(quoteGitHubSearchTerm)
      .filter(Boolean);
    const topicTerms = (Array.isArray(group.topics) ? group.topics : [])
      .map((topic) => String(topic || "").trim())
      .filter(Boolean);
    const selectedKeyword =
      keywordTerms.length > 0
        ? keywordTerms[dayNumber % keywordTerms.length]
        : null;
    const selectedTopic =
      topicTerms.length > 0 ? topicTerms[dayNumber % topicTerms.length] : null;
    if (!selectedKeyword && !selectedTopic) continue;

    // GitHub's repository search can return empty results when free-text terms
    // and topic qualifiers are combined with OR. Rotate one keyword and one
    // topic per day instead. The seven-day lookback covers every configured
    // term while keeping the request count safely below the search rate limit.
    const commonFilters = "archived:false mirror:false template:false is:public";

    queries.push({
      groupId: group.id,
      groupLabel: group.label || group.id,
      mode: "new",
      q: selectedTopic
        ? `topic:${selectedTopic} created:>=${cutoff} ${commonFilters}`
        : `${selectedKeyword} in:name,description,topics created:>=${cutoff} ${commonFilters}`,
      sort: "stars",
      order: "desc",
    });
    queries.push({
      groupId: group.id,
      groupLabel: group.label || group.id,
      mode: "active",
      q: selectedKeyword
        ? `${selectedKeyword} in:name,description,topics pushed:>=${cutoff} ${commonFilters}`
        : `topic:${selectedTopic} pushed:>=${cutoff} ${commonFilters}`,
      sort: "updated",
      order: "desc",
    });
  }

  return queries;
}

function buildGitHubHeaders(
  token,
  accept = "application/vnd.github+json",
) {
  const headers = {
    Accept: accept,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "follow-builders",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function githubFetch(url, token, accept) {
  let lastError;

  for (let attempt = 1; attempt <= GITHUB_RETRY_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        headers: buildGitHubHeaders(token, accept),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      lastError = err;
      if (attempt < GITHUB_RETRY_ATTEMPTS) {
        await sleep(1000 * attempt);
        continue;
      }
      throw err;
    }

    if (response.ok) return response;

    const message = await response.text().catch(() => "");
    const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
    const rateLimitReset = response.headers.get("x-ratelimit-reset");
    const retryAfter = response.headers.get("retry-after");

    if (response.status === 403 || response.status === 429) {
      const details = retryAfter
        ? `retry after ${retryAfter}s`
        : rateLimitRemaining === "0" && rateLimitReset
          ? `reset at ${new Date(Number(rateLimitReset) * 1000).toISOString()}`
          : "request was rate limited";
      throw new Error(`GitHub API rate limit: ${details}`);
    }

    lastError = new Error(
      `GitHub API HTTP ${response.status}: ${message.slice(0, 300)}`,
    );
    lastError.status = response.status;
    if (
      !GITHUB_RETRY_STATUSES.has(response.status) ||
      attempt === GITHUB_RETRY_ATTEMPTS
    ) {
      throw lastError;
    }
    await sleep(1000 * attempt);
  }

  throw lastError || new Error("GitHub API request failed");
}

async function githubFetchJSON(url, token) {
  const response = await githubFetch(url, token);
  return response.json();
}

async function githubFetchText(url, token, accept) {
  const response = await githubFetch(url, token, accept);
  return response.text();
}

function normalizeGitHubRepository(repository, groupId, mode) {
  return {
    source: "github",
    id: repository.id,
    fullName: repository.full_name,
    name: repository.name,
    owner: repository.owner?.login || "",
    description: repository.description?.trim() || "",
    url: repository.html_url,
    homepage: repository.homepage || null,
    stars: repository.stargazers_count || 0,
    forks: repository.forks_count || 0,
    openIssues: repository.open_issues_count || 0,
    language: repository.language || null,
    topics: Array.isArray(repository.topics) ? repository.topics : [],
    license: repository.license?.spdx_id || null,
    createdAt: repository.created_at,
    updatedAt: repository.updated_at,
    pushedAt: repository.pushed_at,
    matchedGroups: [groupId],
    discoveryModes: [mode],
  };
}

function shouldIncludeGitHubRepository(
  repository,
  ignoredRepositories,
  ignoredOwners,
) {
  if (!repository?.id || !repository.full_name || !repository.html_url) {
    return false;
  }
  if (
    repository.private ||
    repository.fork ||
    repository.archived ||
    repository.disabled ||
    repository.is_template ||
    repository.mirror_url
  ) {
    return false;
  }
  if (!repository.description?.trim()) return false;
  if (ignoredRepositories.has(repository.full_name.toLowerCase())) return false;
  if (ignoredOwners.has(repository.owner?.login?.toLowerCase())) return false;
  return true;
}

function updateRepositorySnapshot(state, repository, capturedAt = new Date()) {
  const repositoryId = String(repository.id);
  const capturedAtIso = capturedAt.toISOString();
  const capturedDate = capturedAtIso.slice(0, 10);
  const existing = state.repositorySnapshots[repositoryId] || {
    fullName: repository.fullName,
    firstSeenAt: capturedAtIso,
    lastSeenAt: capturedAtIso,
    snapshots: [],
  };
  const snapshots = Array.isArray(existing.snapshots) ? existing.snapshots : [];
  const withoutToday = snapshots.filter(
    (snapshot) => String(snapshot?.capturedAt || "").slice(0, 10) !== capturedDate,
  );

  state.repositorySnapshots[repositoryId] = {
    ...existing,
    fullName: repository.fullName,
    lastSeenAt: capturedAtIso,
    snapshots: [
      ...withoutToday,
      {
        capturedAt: capturedAtIso,
        stars: repository.stars,
        forks: repository.forks,
        openIssues: repository.openIssues,
      },
    ],
  };
}

async function fetchGitHubCandidates(githubConfig, token, state, errors) {
  const queries = buildGitHubSearchQueries(githubConfig);
  const ignoredRepositories = new Set(
    (githubConfig?.ignoredRepositories || []).map((name) =>
      String(name).toLowerCase(),
    ),
  );
  const ignoredOwners = new Set(
    (githubConfig?.ignoredOwners || []).map((name) =>
      String(name).toLowerCase(),
    ),
  );
  const candidatesById = new Map();
  let successfulSearches = 0;

  for (const query of queries) {
    const params = new URLSearchParams({
      q: query.q,
      sort: query.sort,
      order: query.order,
      per_page: String(GITHUB_SEARCH_RESULTS_PER_QUERY),
    });

    try {
      const data = await githubFetchJSON(
        `${GITHUB_API_BASE}/search/repositories?${params}`,
        token,
      );
      successfulSearches++;

      if (data.incomplete_results) {
        errors.push(
          `GitHub: Incomplete results for ${query.groupId}/${query.mode}`,
        );
      }

      for (const repository of data.items || []) {
        if (
          !shouldIncludeGitHubRepository(
            repository,
            ignoredRepositories,
            ignoredOwners,
          )
        ) {
          continue;
        }

        const candidate = normalizeGitHubRepository(
          repository,
          query.groupId,
          query.mode,
        );
        const existing = candidatesById.get(String(candidate.id));

        if (existing) {
          existing.matchedGroups = [
            ...new Set([...existing.matchedGroups, query.groupId]),
          ];
          existing.discoveryModes = [
            ...new Set([...existing.discoveryModes, query.mode]),
          ];
        } else {
          candidatesById.set(String(candidate.id), candidate);
        }
      }
    } catch (err) {
      errors.push(`GitHub: ${query.groupId}/${query.mode}: ${err.message}`);
    }
  }

  if (queries.length > 0 && successfulSearches === 0) {
    throw new Error("GitHub discovery failed: all repository searches failed");
  }

  const candidates = [...candidatesById.values()];
  for (const candidate of candidates) {
    updateRepositorySnapshot(state, candidate);
  }
  return { candidates, queries, successfulSearches };
}

function daysSince(value, now) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 3650;
  return Math.max(0, (now.getTime() - timestamp) / (24 * 60 * 60 * 1000));
}

function calculatePreliminaryScore(repository, state, now = new Date()) {
  const repositoryAgeDays = daysSince(repository.createdAt, now);
  const lastPushDays = daysSince(repository.pushedAt, now);
  const snapshots =
    state.repositorySnapshots[String(repository.id)]?.snapshots || [];
  const orderedSnapshots = [...snapshots].sort(
    (a, b) => new Date(a.capturedAt) - new Date(b.capturedAt),
  );
  const baselineStars = orderedSnapshots[0]?.stars ?? repository.stars;
  const starGrowth = Math.max(0, repository.stars - baselineStars);

  let score = 0;
  score += Math.min(20, Math.log2(repository.stars + 1) * 2);
  score += Math.min(8, Math.log2(repository.forks + 1));
  score += Math.max(0, 14 - repositoryAgeDays);
  score += Math.max(0, 7 - lastPushDays);
  score += Math.min(30, Math.log2(starGrowth + 1) * 5);
  score += repository.homepage ? 2 : 0;
  score += repository.license ? 2 : 0;
  score += Math.min(3, repository.topics.length);
  score += Math.min(4, repository.matchedGroups.length * 2);
  score += repository.discoveryModes.includes("new") ? 3 : 0;

  return {
    score: Number(score.toFixed(2)),
    signals: {
      repositoryAgeDays: Number(repositoryAgeDays.toFixed(1)),
      lastPushDays: Number(lastPushDays.toFixed(1)),
      starGrowth,
    },
  };
}

function selectCandidatesForEnrichment(
  candidates,
  githubConfig,
  state,
  now = new Date(),
) {
  const allowPreviouslyFeatured =
    githubConfig?.allowPreviouslyFeatured === true;
  const scored = candidates
    .filter(
      (repository) =>
        allowPreviouslyFeatured ||
        !state.featuredRepositories[String(repository.id)],
    )
    .map((repository) => {
      const preliminary = calculatePreliminaryScore(repository, state, now);
      return {
        ...repository,
        preliminaryScore: preliminary.score,
        scoreSignals: preliminary.signals,
      };
    })
    .sort((a, b) => b.preliminaryScore - a.preliminaryScore);
  const groupIds = (githubConfig?.discoveryGroups || [])
    .filter((group) => group?.enabled !== false && group?.id)
    .map((group) => group.id);
  const selectedById = new Map();

  for (const groupId of groupIds) {
    let selectedForGroup = 0;
    for (const repository of scored) {
      if (!repository.matchedGroups.includes(groupId)) continue;
      if (selectedById.has(String(repository.id))) continue;

      selectedById.set(String(repository.id), repository);
      selectedForGroup++;
      if (selectedForGroup >= GITHUB_ENRICHMENT_LIMIT_PER_GROUP) break;
      if (selectedById.size >= GITHUB_ENRICHMENT_LIMIT) break;
    }
    if (selectedById.size >= GITHUB_ENRICHMENT_LIMIT) break;
  }

  for (const repository of scored) {
    if (selectedById.size >= GITHUB_ENRICHMENT_LIMIT) break;
    if (!selectedById.has(String(repository.id))) {
      selectedById.set(String(repository.id), repository);
    }
  }

  return [...selectedById.values()].sort(
    (a, b) => b.preliminaryScore - a.preliminaryScore,
  );
}

function cleanGitHubReadme(readme) {
  const raw = String(readme || "").replace(/\r\n?/g, "\n");
  const withoutUnsafeHtml = raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
  const cleaned = withoutUnsafeHtml
    .split("\n")
    .filter((line) => !/(?:shields\.io|badge\.svg|img\.shields)/i.test(line))
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const truncated = cleaned.slice(0, GITHUB_README_MAX_CHARACTERS);
  const meaningfulCharacters = truncated.replace(/[\s#*_`~>\-]/g, "").length;

  return {
    content: truncated,
    rawCharacters: raw.length,
    cleanCharacters: truncated.length,
    meaningfulCharacters,
    truncated: cleaned.length > GITHUB_README_MAX_CHARACTERS,
    accepted: meaningfulCharacters >= GITHUB_README_MIN_CHARACTERS,
  };
}

async function fetchGitHubReadme(fullName, token) {
  const parts = String(fullName || "").split("/");
  if (
    parts.length !== 2 ||
    !parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))
  ) {
    throw new Error(`Invalid GitHub repository name: ${fullName}`);
  }

  const [owner, repository] = parts.map(encodeURIComponent);
  try {
    return await githubFetchText(
      `${GITHUB_API_BASE}/repos/${owner}/${repository}/readme`,
      token,
      "application/vnd.github.raw+json",
    );
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function enrichGitHubCandidates(candidates, token, errors) {
  const enriched = [];

  for (const repository of candidates) {
    try {
      const readme = await fetchGitHubReadme(repository.fullName, token);
      if (readme === null) continue;

      const cleaned = cleanGitHubReadme(readme);
      if (!cleaned.accepted) continue;

      enriched.push({
        ...repository,
        readme: cleaned.content,
        readmeCharacters: cleaned.cleanCharacters,
        readmeTruncated: cleaned.truncated,
        readmeIsUntrustedContent: true,
      });
    } catch (err) {
      errors.push(`GitHub README: ${repository.fullName}: ${err.message}`);
      if (String(err.message).startsWith("GitHub API rate limit:")) break;
    }
  }

  return enriched;
}

function calculateReadmeQuality(readme) {
  const content = String(readme || "");
  const signals = {
    hasInstallation: /\b(install|installation|setup|getting started|quickstart)\b|安装|开始使用/i.test(
      content,
    ),
    hasUsage: /\b(usage|example|examples|how to use)\b|使用方法|示例/i.test(
      content,
    ),
    hasDemo: /\b(demo|playground|live preview|try it)\b|在线体验|演示/i.test(
      content,
    ),
    hasDocumentation: /\b(documentation|docs|reference)\b|文档/i.test(content),
    hasCodeExamples: /```[\s\S]*?```/.test(content),
  };
  let score = Math.min(5, content.length / 2000);
  score += signals.hasInstallation ? 4 : 0;
  score += signals.hasUsage ? 4 : 0;
  score += signals.hasDemo ? 3 : 0;
  score += signals.hasDocumentation ? 2 : 0;
  score += signals.hasCodeExamples ? 2 : 0;

  return { score: Number(score.toFixed(2)), signals };
}

function selectRepositoriesForFeed(enriched, githubConfig) {
  const scored = enriched
    .map((repository) => {
      const readmeQuality = calculateReadmeQuality(repository.readme);
      return {
        ...repository,
        readmeQualityScore: readmeQuality.score,
        readmeSignals: readmeQuality.signals,
        finalScore: Number(
          (repository.preliminaryScore + readmeQuality.score).toFixed(2),
        ),
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
  const groupIds = (githubConfig?.discoveryGroups || [])
    .filter((group) => group?.enabled !== false && group?.id)
    .map((group) => group.id);
  const selectedById = new Map();

  for (const groupId of groupIds) {
    let selectedForGroup = 0;
    for (const repository of scored) {
      if (!repository.matchedGroups.includes(groupId)) continue;
      if (selectedById.has(String(repository.id))) continue;

      selectedById.set(String(repository.id), repository);
      selectedForGroup++;
      if (selectedForGroup >= GITHUB_FEED_LIMIT_PER_GROUP) break;
      if (selectedById.size >= GITHUB_FEED_LIMIT) break;
    }
    if (selectedById.size >= GITHUB_FEED_LIMIT) break;
  }

  for (const repository of scored) {
    if (selectedById.size >= GITHUB_FEED_LIMIT) break;
    if (!selectedById.has(String(repository.id))) {
      selectedById.set(String(repository.id), repository);
    }
  }

  return [...selectedById.values()].sort((a, b) => b.finalScore - a.finalScore);
}

function createGitHubFeedDocument({
  repositories,
  queryCount,
  successfulSearches,
  discoveredCandidates,
  selectedForReadme,
  acceptedReadmes,
  lookbackDays,
  errors,
  generatedAt = new Date(),
}) {
  return {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    lookbackDays,
    repositories: repositories.map(({ readme, ...repository }) => ({
      ...repository,
      readmeExcerpt: readme,
    })),
    stats: {
      queryCount,
      successfulSearches,
      discoveredCandidates,
      selectedForReadme,
      acceptedReadmes,
      publishedRepositories: repositories.length,
    },
    errors: errors.length > 0 ? errors : undefined,
  };
}

function markFeaturedRepositories(state, repositories, featuredAt = new Date()) {
  const timestamp = featuredAt.toISOString();
  for (const repository of repositories) {
    state.featuredRepositories[String(repository.id)] = {
      fullName: repository.fullName,
      featuredAt: timestamp,
    };
  }
}

async function buildGitHubFeed(githubConfig, token, state, errors) {
  const discovery = await fetchGitHubCandidates(
    githubConfig,
    token,
    state,
    errors,
  );
  const selectedForReadme = selectCandidatesForEnrichment(
    discovery.candidates,
    githubConfig,
    state,
  );
  const enriched = await enrichGitHubCandidates(
    selectedForReadme,
    token,
    errors,
  );
  const repositories = selectRepositoriesForFeed(enriched, githubConfig);
  const lookbackDays = clampInteger(
    githubConfig?.lookbackDays,
    GITHUB_DEFAULT_LOOKBACK_DAYS,
    1,
    30,
  );
  const feed = createGitHubFeedDocument({
    repositories,
    queryCount: discovery.queries.length,
    successfulSearches: discovery.successfulSearches,
    discoveredCandidates: discovery.candidates.length,
    selectedForReadme: selectedForReadme.length,
    acceptedReadmes: enriched.length,
    lookbackDays,
    errors,
  });

  return { feed, repositories };
}

// -- Podcast Fetching (RSS + pod2txt) ----------------------------------------

// Parses an RSS feed XML string and returns episode objects with
// title, publishedAt, guid, and link. RSS feeds list newest first.
function parseRssFeed(xml) {
  const episodes = [];
  // Match each <item> block in the RSS feed
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[1];

    // Extract title (inside CDATA or plain text)
    const titleMatch =
      block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
      block.match(/<title>([\s\S]*?)<\/title>/);
    const title = titleMatch ? titleMatch[1].trim() : "Untitled";

    // Extract GUID (unique episode identifier), stripping CDATA wrapper if present
    const guidMatch =
      block.match(/<guid[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/guid>/) ||
      block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
    const guid = guidMatch ? guidMatch[1].trim() : null;

    // Extract publish date
    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const publishedAt = pubDateMatch
      ? new Date(pubDateMatch[1].trim()).toISOString()
      : null;

    // Extract episode link (for the feed output URL)
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const link = linkMatch ? linkMatch[1].trim() : null;

    if (guid) {
      episodes.push({ title, guid, publishedAt, link });
    }
  }
  return episodes;
}

// -- YouTube Episode URL Lookup ----------------------------------------------
// Podcast RSS feeds don't know about YouTube, so to get the exact YouTube
// video URL for an episode we look up the channel's recent videos and match
// by title. Free, no API key required. Tries Atom RSS first (stable but
// returns 500 for some channels), falls back to scraping the /videos page.

// Derives a YouTube Atom feed URL from a channel or playlist URL.
// Handles three URL shapes: /@handle, /channel/UCxxx, /playlist?list=PLxxx.
async function getYouTubeFeedUrl(channelUrl) {
  if (!channelUrl || !channelUrl.includes("youtube.com")) return null;

  const playlistMatch = channelUrl.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if (playlistMatch) {
    return `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistMatch[1]}`;
  }

  const channelIdMatch = channelUrl.match(/\/channel\/(UC[A-Za-z0-9_-]+)/);
  if (channelIdMatch) {
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelIdMatch[1]}`;
  }

  // /@handle URLs need a round-trip: fetch the channel page and pull the
  // channelId out of its HTML. YouTube embeds it in several places; the
  // "channelId":"UC..." pattern in the JSON blob is the most reliable.
  if (channelUrl.match(/\/@[A-Za-z0-9_.-]+/)) {
    try {
      const res = await fetch(channelUrl, {
        headers: {
          "User-Agent": RSS_USER_AGENT,
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return null;
      const html = await res.text();
      const idMatch =
        html.match(/"channelId":"(UC[A-Za-z0-9_-]{20,})"/) ||
        html.match(
          /<meta\s+itemprop="(?:identifier|channelId)"\s+content="(UC[A-Za-z0-9_-]{20,})"/,
        );
      if (idMatch) {
        return `https://www.youtube.com/feeds/videos.xml?channel_id=${idMatch[1]}`;
      }
    } catch {
      return null;
    }
  }
  return null;
}

// Scrapes recent videos from a YouTube channel's /videos page by parsing
// the ytInitialData JSON embedded in the HTML. Used as a fallback when the
// Atom RSS endpoint is unavailable. YouTube's internal data shapes change
// occasionally, so we defensively navigate both the rich-grid (channel page)
// and playlist-video-list (playlist page) structures.
function parseYouTubePageData(html) {
  const videos = [];
  const m = html.match(/var\s+ytInitialData\s*=\s*({[\s\S]*?});\s*<\/script>/);
  if (!m) return videos;

  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return videos;
  }

  const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  for (const tab of tabs) {
    const gridItems =
      tab?.tabRenderer?.content?.richGridRenderer?.contents || [];
    for (const it of gridItems) {
      const v = it?.richItemRenderer?.content?.videoRenderer;
      if (v?.videoId) {
        const title = v.title?.runs?.[0]?.text || v.title?.simpleText || "";
        if (title) {
          videos.push({
            title,
            url: `https://www.youtube.com/watch?v=${v.videoId}`,
          });
        }
      }
    }
    if (videos.length > 0) break;

    const playlistItems =
      tab?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
        ?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer
        ?.contents || [];
    for (const it of playlistItems) {
      const v = it?.playlistVideoRenderer;
      if (v?.videoId) {
        const title = v.title?.runs?.[0]?.text || v.title?.simpleText || "";
        if (title) {
          videos.push({
            title,
            url: `https://www.youtube.com/watch?v=${v.videoId}`,
          });
        }
      }
    }
    if (videos.length > 0) break;
  }
  return videos;
}

// Fetches recent videos for a YouTube channel/playlist URL. Tries the Atom
// feed first, then scrapes the /videos page if the feed is unavailable.
async function fetchYouTubeVideos(channelUrl) {
  const feedUrl = await getYouTubeFeedUrl(channelUrl);
  if (feedUrl) {
    try {
      const res = await fetch(feedUrl, {
        headers: { "User-Agent": RSS_USER_AGENT },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const videos = parseYouTubeFeed(await res.text());
        if (videos.length > 0) return videos;
      }
    } catch {
      // fall through to scraping
    }
  }

  if (!channelUrl || !channelUrl.includes("youtube.com")) return [];
  // Playlist URLs should not be mutated; channel URLs need /videos appended
  // so we hit the uploads grid rather than the channel home/shorts page.
  const videosPageUrl = channelUrl.includes("/playlist?")
    ? channelUrl
    : channelUrl.replace(/\/$/, "") + "/videos";
  try {
    const res = await fetch(videosPageUrl, {
      headers: {
        "User-Agent": RSS_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    return parseYouTubePageData(await res.text());
  } catch {
    return [];
  }
}

// Parses a YouTube Atom feed and returns { title, url } for each entry.
function parseYouTubeFeed(xml) {
  const videos = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let entryMatch;
  while ((entryMatch = entryRegex.exec(xml)) !== null) {
    const block = entryMatch[1];
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const videoIdMatch = block.match(/<yt:videoId>([\s\S]*?)<\/yt:videoId>/);
    if (titleMatch && videoIdMatch) {
      videos.push({
        title: titleMatch[1].trim(),
        url: `https://www.youtube.com/watch?v=${videoIdMatch[1].trim()}`,
      });
    }
  }
  return videos;
}

// Lowercase, strip punctuation, collapse whitespace — so minor title
// differences between a podcast feed and its YouTube upload don't block a match.
function normalizeTitle(t) {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Finds the YouTube video whose title best matches the podcast episode title.
// Uses substring match first, then token overlap (>=50% of episode's content
// words must appear in the video title). Returns null if no confident match.
async function findYouTubeEpisodeUrl(channelUrl, episodeTitle) {
  const videos = await fetchYouTubeVideos(channelUrl);
  if (videos.length === 0) return null;

  const needle = normalizeTitle(episodeTitle);
  const needleTokens = new Set(needle.split(" ").filter((w) => w.length > 2));
  if (needleTokens.size === 0) return null;

  let bestUrl = null;
  let bestScore = 0;
  for (const v of videos) {
    const hay = normalizeTitle(v.title);
    if (hay && (hay.includes(needle) || needle.includes(hay))) {
      return v.url;
    }
    const hayTokens = new Set(hay.split(" ").filter((w) => w.length > 2));
    let overlap = 0;
    for (const tok of needleTokens) if (hayTokens.has(tok)) overlap++;
    const score = overlap / needleTokens.size;
    if (score > bestScore) {
      bestScore = score;
      bestUrl = v.url;
    }
  }
  return bestScore >= 0.5 ? bestUrl : null;
}

// Fetches a transcript from pod2txt. The API is async: first request may
// return "processing", so we poll until "ready" (up to 5 attempts, ~2.5 min).
async function fetchPod2txtTranscript(rssUrl, guid, apiKey) {
  const maxAttempts = 5;
  const pollInterval = 30000; // 30 seconds between polls

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`${POD2TXT_BASE}/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedurl: rssUrl, guid, apikey: apiKey }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { error: `HTTP ${res.status}: ${text}` };
    }

    const data = await res.json();

    if (data.status === "ready" && data.url) {
      // Transcript is ready — fetch the text from the provided URL
      const txtRes = await fetch(data.url);
      if (!txtRes.ok)
        return {
          error: `Failed to fetch transcript text: HTTP ${txtRes.status}`,
        };
      const transcript = await txtRes.text();
      return { transcript };
    }

    if (data.status === "processing") {
      console.error(
        `      pod2txt: processing (attempt ${attempt}/${maxAttempts}), waiting ${pollInterval / 1000}s...`,
      );
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, pollInterval));
      }
      continue;
    }

    // Unexpected status or error from the API
    return { error: data.message || `Unexpected status: ${data.status}` };
  }

  return { error: "Timed out waiting for transcript processing" };
}

// Main podcast fetching function. For each podcast:
// 1. Fetches the RSS feed to discover episodes
// 2. Filters by lookback window and dedup
// 3. Fetches transcript via pod2txt for the newest unseen episode
async function fetchPodcastContent(podcasts, apiKey, state, errors) {
  const cutoff = new Date(Date.now() - PODCAST_LOOKBACK_HOURS * 60 * 60 * 1000);
  const allCandidates = [];

  // Step 1: Discover episodes from each podcast's RSS feed
  for (const podcast of podcasts) {
    if (!podcast.rssUrl) {
      errors.push(`Podcast: No rssUrl configured for ${podcast.name}`);
      continue;
    }

    try {
      console.error(`  Fetching RSS for ${podcast.name}...`);
      const rssRes = await fetch(podcast.rssUrl, {
        headers: {
          "User-Agent": RSS_USER_AGENT,
          Accept: "application/rss+xml, application/xml, text/xml, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
        signal: AbortSignal.timeout(30000), // 30 second timeout for large feeds
      });

      if (!rssRes.ok) {
        console.error(
          `  ${podcast.name}: RSS fetch failed — HTTP ${rssRes.status}`,
        );
        errors.push(
          `Podcast: Failed to fetch RSS for ${podcast.name}: HTTP ${rssRes.status}`,
        );
        continue;
      }

      const rssXml = await rssRes.text();
      const episodes = parseRssFeed(rssXml);
      console.error(
        `  ${podcast.name}: found ${episodes.length} episodes in RSS feed`,
      );

      // Check the 3 most recent episodes, skip already-seen ones
      for (const episode of episodes.slice(0, 3)) {
        if (state.seenVideos[episode.guid]) {
          console.error(`    Skipping "${episode.title}" (already seen)`);
          continue;
        }

        console.error(
          `    Candidate: "${episode.title}" published=${episode.publishedAt || "unknown"}`,
        );
        allCandidates.push({ podcast, ...episode });
      }
    } catch (err) {
      errors.push(`Podcast: Error processing ${podcast.name}: ${err.message}`);
    }
  }

  console.error(
    `  Total candidates: ${allCandidates.length}, cutoff: ${cutoff.toISOString()}`,
  );

  // Step 2: Filter by lookback window, sort newest first
  const withinWindow = allCandidates
    .filter((v) => !v.publishedAt || new Date(v.publishedAt) >= cutoff)
    .sort((a, b) => {
      // Newest first; dateless ones go to the end
      if (a.publishedAt && b.publishedAt)
        return new Date(b.publishedAt) - new Date(a.publishedAt);
      if (a.publishedAt) return -1;
      if (b.publishedAt) return 1;
      return 0;
    });

  console.error(`  Within window: ${withinWindow.length} episode(s)`);
  for (const v of withinWindow) {
    console.error(`    - "${v.title}" published=${v.publishedAt || "unknown"}`);
  }

  // Step 3: Try each candidate until we get a transcript from pod2txt
  for (const selected of withinWindow) {
    console.error(`    Fetching transcript for "${selected.title}"...`);

    const result = await fetchPod2txtTranscript(
      selected.podcast.rssUrl,
      selected.guid,
      apiKey,
    );

    // Mark as seen regardless so we don't retry failed episodes daily
    state.seenVideos[selected.guid] = Date.now();

    if (result.error) {
      console.error(
        `    Transcript error: ${result.error} — skipping to next candidate`,
      );
      errors.push(
        `Podcast: Transcript error for "${selected.title}": ${result.error}`,
      );
      continue;
    }

    if (!result.transcript) {
      console.error(
        `    Empty transcript for "${selected.title}" — skipping to next candidate`,
      );
      continue;
    }

    console.error(
      `    Selected: "${selected.title}" (transcript: ${result.transcript.length} chars)`,
    );

    // Try to resolve the exact YouTube video URL for this episode. If the
    // lookup fails (no YouTube channel configured, no title match, network
    // error), fall back to the channel URL so the feed still works.
    const youtubeUrl = await findYouTubeEpisodeUrl(
      selected.podcast.url,
      selected.title,
    );
    if (youtubeUrl) {
      console.error(`    Matched YouTube episode URL: ${youtubeUrl}`);
    } else {
      console.error(
        `    No YouTube episode match found — falling back to channel URL`,
      );
    }

    return [
      {
        source: "podcast",
        name: selected.podcast.name,
        title: selected.title,
        guid: selected.guid,
        url: youtubeUrl || selected.podcast.url,
        publishedAt: selected.publishedAt,
        transcript: result.transcript,
      },
    ];
  }

  console.error(`    No candidates had transcripts available`);
  return [];
}

// -- X/Twitter Fetching (Official API v2) ------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchXWithRetry(url, options) {
  let lastResponse;
  for (let attempt = 1; attempt <= X_RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, options);
      lastResponse = res;
      if (!X_RETRY_STATUSES.has(res.status) || attempt === X_RETRY_ATTEMPTS) {
        return res;
      }
    } catch (err) {
      if (attempt === X_RETRY_ATTEMPTS) throw err;
    }
    await sleep(1000 * attempt);
  }
  return lastResponse;
}

async function fetchXContent(xAccounts, bearerToken, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);

  // Batch lookup user IDs. Smaller batches make one flaky X response less likely
  // to wipe out the whole feed.
  const handles = xAccounts.map((a) => a.handle);
  let userMap = {};

  for (let i = 0; i < handles.length; i += X_USER_LOOKUP_BATCH_SIZE) {
    const batch = handles.slice(i, i + X_USER_LOOKUP_BATCH_SIZE);
    try {
      const res = await fetchXWithRetry(
        `${X_API_BASE}/users/by?usernames=${batch.join(",")}&user.fields=name,description`,
        { headers: { Authorization: `Bearer ${bearerToken}` } },
      );

      if (!res.ok) {
        errors.push(
          `X API: User lookup failed for ${batch.join(",")}: HTTP ${res.status}`,
        );
        continue;
      }

      const data = await res.json();
      for (const user of data.data || []) {
        userMap[user.username.toLowerCase()] = {
          id: user.id,
          name: user.name,
          description: user.description || "",
        };
      }
      if (data.errors) {
        for (const err of data.errors) {
          errors.push(`X API: User not found: ${err.value || err.detail}`);
        }
      }
    } catch (err) {
      errors.push(`X API: User lookup error: ${err.message}`);
    }
  }

  // Fetch recent tweets per user (max 3, exclude retweets/replies)
  for (const account of xAccounts) {
    const userData = userMap[account.handle.toLowerCase()];
    if (!userData) continue;

    try {
      const res = await fetchXWithRetry(
        `${X_API_BASE}/users/${userData.id}/tweets?` +
          `max_results=5` + // fetch 5, then filter to 3 new ones
          `&tweet.fields=created_at,public_metrics,referenced_tweets,note_tweet` +
          `&exclude=retweets,replies` +
          `&start_time=${cutoff.toISOString()}`,
        { headers: { Authorization: `Bearer ${bearerToken}` } },
      );

      if (!res.ok) {
        if (res.status === 429) {
          errors.push(`X API: Rate limited, skipping remaining accounts`);
          break;
        }
        errors.push(
          `X API: Failed to fetch tweets for @${account.handle}: HTTP ${res.status}`,
        );
        continue;
      }

      const data = await res.json();
      const allTweets = data.data || [];

      // Filter out already-seen tweets, cap at 3
      const newTweets = [];
      for (const t of allTweets) {
        if (state.seenTweets[t.id]) continue; // dedup
        if (newTweets.length >= MAX_TWEETS_PER_USER) break;

        newTweets.push({
          id: t.id,
          // note_tweet.text has the full untruncated text for long tweets (>280 chars)
          text: t.note_tweet?.text || t.text,
          createdAt: t.created_at,
          url: `https://x.com/${account.handle}/status/${t.id}`,
          likes: t.public_metrics?.like_count || 0,
          retweets: t.public_metrics?.retweet_count || 0,
          replies: t.public_metrics?.reply_count || 0,
          isQuote:
            t.referenced_tweets?.some((r) => r.type === "quoted") || false,
          quotedTweetId:
            t.referenced_tweets?.find((r) => r.type === "quoted")?.id || null,
        });

        // Mark as seen
        state.seenTweets[t.id] = Date.now();
      }

      if (newTweets.length === 0) continue;

      results.push({
        source: "x",
        name: account.name,
        handle: account.handle,
        bio: userData.description,
        tweets: newTweets,
      });

      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      errors.push(`X API: Error fetching @${account.handle}: ${err.message}`);
    }
  }

  return results;
}

// -- Blog Fetching (HTML scraping) -------------------------------------------

// Scrapes the Anthropic Engineering blog index page.
// The page is a Next.js app that embeds article data as JSON in <script> tags.
// We parse that JSON to extract article metadata (title, slug, date, summary).
// Falls back to regex-based HTML parsing if the JSON approach fails.
function parseAnthropicEngineeringIndex(html) {
  const articles = [];

  // Strategy 1: Look for article data in Next.js __NEXT_DATA__ script tag
  const nextDataMatch = html.match(
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      // Navigate the Next.js page props to find article entries
      const pageProps = data?.props?.pageProps;
      const posts =
        pageProps?.posts || pageProps?.articles || pageProps?.entries || [];
      for (const post of posts) {
        const slug = post.slug?.current || post.slug || "";
        articles.push({
          title: post.title || "Untitled",
          url: `https://www.anthropic.com/engineering/${slug}`,
          publishedAt:
            post.publishedOn || post.publishedAt || post.date || null,
          description: post.summary || post.description || "",
        });
      }
      if (articles.length > 0) return articles;
    } catch {
      // JSON parsing failed, fall through to regex approach
    }
  }

  // Strategy 2: Regex-based extraction from the rendered HTML.
  // Anthropic engineering articles follow the pattern /engineering/<slug>
  const linkRegex = /href="\/engineering\/([a-z0-9-]+)"/gi;
  const seenSlugs = new Set();
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const slug = linkMatch[1];
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    articles.push({
      title: "", // Will be filled when we fetch the article page
      url: `https://www.anthropic.com/engineering/${slug}`,
      publishedAt: null,
      description: "",
    });
  }
  return articles;
}

// Scrapes the Claude Blog index page (claude.com/blog).
// This is a Webflow site. We extract article links, titles, and dates
// from the HTML structure.
function parseClaudeBlogIndex(html) {
  const articles = [];
  const seenSlugs = new Set();

  // Match blog post links — they follow the pattern /blog/<slug>
  // We capture surrounding context to extract titles and dates
  const linkRegex = /href="\/blog\/([a-z0-9-]+)"/gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const slug = linkMatch[1];
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    articles.push({
      title: "", // Will be filled when we fetch the article page
      url: `https://claude.com/blog/${slug}`,
      publishedAt: null,
      description: "",
    });
  }
  return articles;
}

// Extracts the main text content from an Anthropic Engineering article page.
// Tries the embedded JSON first (Next.js SSR data), then falls back to
// stripping HTML tags from the article body.
function extractAnthropicArticleContent(html) {
  let title = "";
  let author = "";
  let publishedAt = null;
  let content = "";

  // Try to get structured data from Next.js __NEXT_DATA__
  const nextDataMatch = html.match(
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const pageProps = data?.props?.pageProps;
      const post =
        pageProps?.post || pageProps?.article || pageProps?.entry || pageProps;
      title = post?.title || "";
      author = post?.author?.name || post?.authors?.[0]?.name || "";
      publishedAt =
        post?.publishedOn || post?.publishedAt || post?.date || null;

      // Extract text from the body blocks (Sanity CMS portable text format)
      const body = post?.body || post?.content || [];
      if (Array.isArray(body)) {
        const textParts = [];
        for (const block of body) {
          if (block._type === "block" && block.children) {
            const text = block.children.map((c) => c.text || "").join("");
            if (text.trim()) textParts.push(text.trim());
          }
        }
        content = textParts.join("\n\n");
      }
      if (content) return { title, author, publishedAt, content };
    } catch {
      // Fall through to HTML stripping
    }
  }

  // Fallback: extract title from <h1> and body from <article> or main content
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) title = h1Match[1].replace(/<[^>]+>/g, "").trim();

  // Try to find the article body and strip HTML tags
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const bodyHtml = articleMatch ? articleMatch[1] : html;

  // Strip script/style tags first, then all remaining HTML tags
  content = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { title, author, publishedAt, content };
}

// Extracts the main text content from a Claude Blog article page.
// Uses JSON-LD schema data if present, then falls back to the rich text body.
function extractClaudeBlogArticleContent(html) {
  let title = "";
  let author = "";
  let publishedAt = null;
  let content = "";

  // Try JSON-LD structured data first (most reliable for metadata)
  const jsonLdRegex =
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdMatch;
  while ((jsonLdMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      if (ld["@type"] === "BlogPosting" || ld["@type"] === "Article") {
        title = ld.headline || ld.name || "";
        author = ld.author?.name || "";
        publishedAt = ld.datePublished || null;
        break;
      }
    } catch {
      // Not valid JSON-LD, skip
    }
  }

  // Extract body text from the Webflow rich text container
  const richTextMatch =
    html.match(
      /<div[^>]*class="[^"]*u-rich-text-blog[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
    ) ||
    html.match(/<div[^>]*class="[^"]*w-richtext[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (richTextMatch) {
    content = richTextMatch[1]
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // If rich text extraction failed, try a broader approach
  if (!content) {
    // Get title from <h1> if not already found
    if (!title) {
      const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      if (h1Match) title = h1Match[1].replace(/<[^>]+>/g, "").trim();
    }

    // Strip the whole page down to text as a last resort
    content = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return { title, author, publishedAt, content };
}

// Main blog fetching orchestrator.
// For each blog source in the config, discovers new articles, deduplicates
// against previously seen URLs, fetches full article content, and returns
// the results for feed-blogs.json.
async function fetchBlogContent(blogs, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - BLOG_LOOKBACK_HOURS * 60 * 60 * 1000);

  for (const blog of blogs) {
    console.error(`  Processing blog: ${blog.name}...`);
    let candidates = [];

    try {
      // Step 1: Discover articles from the blog index page
      const indexRes = await fetch(blog.indexUrl, {
        headers: { "User-Agent": "FollowBuilders/1.0 (feed aggregator)" },
      });
      if (!indexRes.ok) {
        errors.push(
          `Blog: Failed to fetch index for ${blog.name}: HTTP ${indexRes.status}`,
        );
        continue;
      }
      const indexHtml = await indexRes.text();

      // Use the right parser based on which blog this is
      if (blog.indexUrl.includes("anthropic.com")) {
        candidates = parseAnthropicEngineeringIndex(indexHtml);
      } else if (blog.indexUrl.includes("claude.com")) {
        candidates = parseClaudeBlogIndex(indexHtml);
      }

      // Step 2: Filter to unseen articles, cap at MAX_ARTICLES_PER_BLOG.
      // Blog index pages list articles newest-first. We only consider the
      // first few entries (MAX_INDEX_SCAN) to avoid crawling the entire
      // backlog on first run. Articles with a known date must fall within
      // the lookback window; articles without dates are accepted if they
      // appear near the top of the listing (likely recent).
      const MAX_INDEX_SCAN = MAX_ARTICLES_PER_BLOG; // only look at the N most recent entries
      const newArticles = [];
      for (const article of candidates.slice(0, MAX_INDEX_SCAN)) {
        if (state.seenArticles[article.url]) continue; // already seen
        // If we have a date, check it's within the lookback window
        if (article.publishedAt && new Date(article.publishedAt) < cutoff)
          continue;
        newArticles.push(article);
        if (newArticles.length >= MAX_ARTICLES_PER_BLOG) break;
      }

      if (newArticles.length === 0) {
        console.error(`    No new articles found`);
        continue;
      }

      console.error(
        `    Found ${newArticles.length} new article(s), fetching content...`,
      );

      // Step 3: Fetch full article content for each new article
      for (const article of newArticles) {
        try {
          // Fetch the full article page
          const articleRes = await fetch(article.url, {
            headers: { "User-Agent": "FollowBuilders/1.0 (feed aggregator)" },
          });
          if (!articleRes.ok) {
            errors.push(
              `Blog: Failed to fetch article ${article.url}: HTTP ${articleRes.status}`,
            );
            continue;
          }
          const articleHtml = await articleRes.text();

          // Use the right content extractor based on the blog
          let extracted;
          if (article.url.includes("anthropic.com/engineering")) {
            extracted = extractAnthropicArticleContent(articleHtml);
          } else if (article.url.includes("claude.com/blog")) {
            extracted = extractClaudeBlogArticleContent(articleHtml);
          }

          if (!extracted || !extracted.content) {
            errors.push(`Blog: No content extracted from ${article.url}`);
            continue;
          }

          // Merge extracted data with what we already have from the index
          results.push({
            source: "blog",
            name: blog.name,
            title: extracted.title || article.title || "Untitled",
            url: article.url,
            publishedAt: extracted.publishedAt || article.publishedAt || null,
            author: extracted.author || "",
            description: article.description || "",
            content: extracted.content,
          });

          // Mark as seen
          state.seenArticles[article.url] = Date.now();

          // Small delay between article fetches to be polite
          await new Promise((r) => setTimeout(r, 500));
        } catch (err) {
          errors.push(
            `Blog: Error fetching article ${article.url}: ${err.message}`,
          );
        }
      }
    } catch (err) {
      errors.push(`Blog: Error processing ${blog.name}: ${err.message}`);
    }
  }

  return results;
}

// -- Main --------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  // Validate state handling without fetching or overwriting any feed.
  // FOLLOW_BUILDERS_STATE_PATH can point this command at a temporary file.
  if (args.includes("--validate-state")) {
    const state = await loadState();
    await saveState(state);
    console.log(
      JSON.stringify({
        status: "ok",
        version: state.version,
        repositorySnapshots: Object.keys(state.repositorySnapshots).length,
        featuredRepositories: Object.keys(state.featuredRepositories).length,
      }),
    );
    return;
  }

  if (args.includes("--print-github-queries")) {
    const sources = await loadSources();
    const queries = buildGitHubSearchQueries(sources.github);
    console.log(JSON.stringify({ count: queries.length, queries }, null, 2));
    return;
  }

  if (args.includes("--validate-github-enrichment")) {
    const sources = await loadSources();
    const state = createEmptyState();
    const now = new Date();
    const candidates = sources.github.discoveryGroups.flatMap((group, groupIndex) =>
      Array.from({ length: 10 }, (_, itemIndex) => ({
        source: "github",
        id: groupIndex * 100 + itemIndex + 1,
        fullName: `example-${groupIndex}/project-${itemIndex}`,
        name: `project-${itemIndex}`,
        owner: `example-${groupIndex}`,
        description: "A project with a meaningful description",
        url: `https://github.com/example-${groupIndex}/project-${itemIndex}`,
        homepage: itemIndex % 2 === 0 ? "https://example.com" : null,
        stars: 100 - itemIndex,
        forks: 10,
        openIssues: 2,
        language: "TypeScript",
        topics: [group.id],
        license: "MIT",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        pushedAt: now.toISOString(),
        matchedGroups: [group.id],
        discoveryModes: ["new"],
      })),
    );
    for (const candidate of candidates) {
      updateRepositorySnapshot(state, candidate, now);
    }
    const selected = selectCandidatesForEnrichment(
      candidates,
      sources.github,
      state,
      now,
    );
    const longReadme = cleanGitHubReadme(
      `![badge](https://img.shields.io/test)\n<h1>Product</h1>\n${"Useful content ".repeat(1200)}`,
    );
    const shortReadme = cleanGitHubReadme("# Demo\nShort text");
    const enriched = selected.map((candidate, index) => ({
      ...candidate,
      readme: [
        "# Product",
        "## Installation",
        "Run `npm install` to install the project.",
        "## Usage",
        "```js",
        `console.log(\"example-${index}\");`,
        "```",
        "See the documentation and live demo for more examples.",
        "Useful product details. ".repeat(30),
      ].join("\n"),
      readmeCharacters: 1000,
      readmeTruncated: false,
      readmeIsUntrustedContent: true,
    }));
    const published = selectRepositoriesForFeed(enriched, sources.github);
    const feed = createGitHubFeedDocument({
      repositories: published,
      queryCount: 10,
      successfulSearches: 10,
      discoveredCandidates: candidates.length,
      selectedForReadme: selected.length,
      acceptedReadmes: enriched.length,
      lookbackDays: GITHUB_DEFAULT_LOOKBACK_DAYS,
      errors: [],
      generatedAt: now,
    });
    markFeaturedRepositories(state, published, now);
    const groupCounts = Object.fromEntries(
      sources.github.discoveryGroups.map((group) => [
        group.id,
        selected.filter((candidate) =>
          candidate.matchedGroups.includes(group.id),
        ).length,
      ]),
    );
    const publishedGroupCounts = Object.fromEntries(
      sources.github.discoveryGroups.map((group) => [
        group.id,
        published.filter((repository) =>
          repository.matchedGroups.includes(group.id),
        ).length,
      ]),
    );
    const checks = {
      selectedForty: selected.length === GITHUB_ENRICHMENT_LIMIT,
      balancedGroups: Object.values(groupCounts).every(
        (count) => count === GITHUB_ENRICHMENT_LIMIT_PER_GROUP,
      ),
      uniqueRepositories:
        new Set(selected.map((candidate) => candidate.id)).size ===
        selected.length,
      longReadmeAcceptedAndTruncated:
        longReadme.accepted && longReadme.truncated,
      shortReadmeRejected: !shortReadme.accepted,
      badgeRemoved: !longReadme.content.includes("shields.io"),
      publishedTwenty: published.length === GITHUB_FEED_LIMIT,
      balancedPublishedGroups: Object.values(publishedGroupCounts).every(
        (count) => count === GITHUB_FEED_LIMIT_PER_GROUP,
      ),
      feedSchemaValid:
        feed.schemaVersion === 1 &&
        feed.stats.publishedRepositories === GITHUB_FEED_LIMIT &&
        feed.repositories.every(
          (repository) =>
            typeof repository.readmeExcerpt === "string" &&
            !("readme" in repository),
        ),
      featuredHistoryUpdated:
        Object.keys(state.featuredRepositories).length === GITHUB_FEED_LIMIT,
    };
    if (Object.values(checks).some((passed) => !passed)) {
      throw new Error(`GitHub enrichment validation failed: ${JSON.stringify(checks)}`);
    }
    console.log(
      JSON.stringify(
        { status: "ok", checks, groupCounts, publishedGroupCounts },
        null,
        2,
      ),
    );
    return;
  }

  const githubReadmeIndex = args.indexOf("--github-readme");
  if (githubReadmeIndex !== -1) {
    const fullName = args[githubReadmeIndex + 1];
    if (!fullName) {
      throw new Error("--github-readme requires owner/repository");
    }
    const githubToken = process.env.GITHUB_TOKEN;
    const readme = await fetchGitHubReadme(fullName, githubToken);
    if (readme === null) {
      console.log(JSON.stringify({ fullName, found: false }, null, 2));
      return;
    }
    const cleaned = cleanGitHubReadme(readme);
    console.log(
      JSON.stringify(
        {
          fullName,
          found: true,
          rawCharacters: cleaned.rawCharacters,
          cleanCharacters: cleaned.cleanCharacters,
          meaningfulCharacters: cleaned.meaningfulCharacters,
          truncated: cleaned.truncated,
          accepted: cleaned.accepted,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (args.includes("--github-candidates-only")) {
    const sources = await loadSources();
    const state = await loadState();
    const errors = [];
    const githubToken = process.env.GITHUB_TOKEN;

    if (!githubToken) {
      console.error(
        "GITHUB_TOKEN is not set; using the lower unauthenticated API limits",
      );
    }

    const result = await fetchGitHubCandidates(
      sources.github,
      githubToken,
      state,
      errors,
    );
    console.log(
      JSON.stringify(
        {
          status: "ok",
          queryCount: result.queries.length,
          successfulSearches: result.successfulSearches,
          candidateCount: result.candidates.length,
          candidates: result.candidates.map((repository) => ({
            id: repository.id,
            fullName: repository.fullName,
            stars: repository.stars,
            matchedGroups: repository.matchedGroups,
            discoveryModes: repository.discoveryModes,
          })),
          errors: errors.length > 0 ? errors : undefined,
        },
        null,
        2,
      ),
    );
    return;
  }

  const githubFeedDryRun = args.includes("--github-feed-dry-run");
  const githubOnly = args.includes("--github-only");
  if (githubFeedDryRun || githubOnly) {
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      throw new Error(
        "GITHUB_TOKEN is required for reliable GitHub feed generation",
      );
    }

    const sources = await loadSources();
    const state = await loadState();
    const errors = [];
    const { feed, repositories } = await buildGitHubFeed(
      sources.github,
      githubToken,
      state,
      errors,
    );

    if (githubFeedDryRun) {
      console.log(
        JSON.stringify(
          {
            status: "preview",
            stats: feed.stats,
            repositories: repositories.map((repository) => ({
              fullName: repository.fullName,
              finalScore: repository.finalScore,
              matchedGroups: repository.matchedGroups,
            })),
            errors: feed.errors,
          },
          null,
          2,
        ),
      );
      return;
    }

    // Publish the feed first. Only a successfully published repository is
    // recorded as featured, so a failed feed write cannot create false dedupe.
    await writeJSONAtomic(GITHUB_FEED_PATH, feed);
    const completedAt = new Date();
    markFeaturedRepositories(state, repositories, completedAt);
    state.lastSuccessfulRun = completedAt.toISOString();
    await saveState(state);
    console.log(
      JSON.stringify(
        {
          status: "ok",
          feedPath: GITHUB_FEED_PATH,
          publishedRepositories: repositories.length,
          errors: feed.errors,
        },
        null,
        2,
      ),
    );
    return;
  }

  const tweetsOnly = args.includes("--tweets-only");
  const podcastsOnly = args.includes("--podcasts-only");
  const blogsOnly = args.includes("--blogs-only");

  // If a specific --*-only flag is set, only that feed type runs.
  // If no flag is set, all three run.
  const runTweets = tweetsOnly || (!podcastsOnly && !blogsOnly);
  const runPodcasts = podcastsOnly || (!tweetsOnly && !blogsOnly);
  const runBlogs = blogsOnly || (!tweetsOnly && !podcastsOnly);

  const xBearerToken = process.env.X_BEARER_TOKEN;
  const pod2txtKey = process.env.POD2TXT_API_KEY;

  if (runPodcasts && !pod2txtKey) {
    console.error("POD2TXT_API_KEY not set");
    process.exit(1);
  }
  if (runTweets && !xBearerToken) {
    console.error("X_BEARER_TOKEN not set");
    process.exit(1);
  }

  const sources = await loadSources();
  const state = await loadState();
  const errors = [];

  // Fetch tweets
  if (runTweets) {
    console.error("Fetching X/Twitter content...");
    const xContent = await fetchXContent(
      sources.x_accounts,
      xBearerToken,
      state,
      errors,
    );
    console.error(`  Found ${xContent.length} builders with new tweets`);

    const totalTweets = xContent.reduce((sum, a) => sum + a.tweets.length, 0);
    const xErrors = errors.filter((e) => e.startsWith("X API"));

    if (xErrors.length > 0) {
      console.error("  X API errors:");
      for (const error of xErrors) {
        console.error(`    - ${error}`);
      }
    }

    if (xContent.length === 0 && xErrors.length > 0) {
      throw new Error(
        `X feed failed: 0 builders returned and ${xErrors.length} X API error(s) occurred`,
      );
    }

    const xFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: TWEET_LOOKBACK_HOURS,
      x: xContent,
      stats: { xBuilders: xContent.length, totalTweets },
      errors: xErrors.length > 0 ? xErrors : undefined,
    };
    await writeFile(
      join(SCRIPT_DIR, "..", "feed-x.json"),
      JSON.stringify(xFeed, null, 2),
    );
    console.error(
      `  feed-x.json: ${xContent.length} builders, ${totalTweets} tweets`,
    );
  }

  // Fetch podcasts
  if (runPodcasts) {
    console.error("Fetching podcast content (RSS + pod2txt)...");
    const podcasts = await fetchPodcastContent(
      sources.podcasts,
      pod2txtKey,
      state,
      errors,
    );
    console.error(`  Found ${podcasts.length} new episodes`);

    const podcastFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: PODCAST_LOOKBACK_HOURS,
      podcasts,
      stats: { podcastEpisodes: podcasts.length },
      errors:
        errors.filter((e) => e.startsWith("Podcast")).length > 0
          ? errors.filter((e) => e.startsWith("Podcast"))
          : undefined,
    };
    await writeFile(
      join(SCRIPT_DIR, "..", "feed-podcasts.json"),
      JSON.stringify(podcastFeed, null, 2),
    );
    console.error(`  feed-podcasts.json: ${podcasts.length} episodes`);
  }

  // Fetch blog posts
  if (runBlogs && sources.blogs && sources.blogs.length > 0) {
    console.error("Fetching blog content...");
    const blogContent = await fetchBlogContent(sources.blogs, state, errors);
    console.error(`  Found ${blogContent.length} new blog post(s)`);

    const blogFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: BLOG_LOOKBACK_HOURS,
      blogs: blogContent,
      stats: { blogPosts: blogContent.length },
      errors:
        errors.filter((e) => e.startsWith("Blog")).length > 0
          ? errors.filter((e) => e.startsWith("Blog"))
          : undefined,
    };
    await writeFile(
      join(SCRIPT_DIR, "..", "feed-blogs.json"),
      JSON.stringify(blogFeed, null, 2),
    );
    console.error(`  feed-blogs.json: ${blogContent.length} posts`);
  }

  // Save dedup state only after all requested feed work has completed.
  state.lastSuccessfulRun = new Date().toISOString();
  await saveState(state);

  if (errors.length > 0) {
    console.error(`  ${errors.length} non-fatal errors`);
  }
}

main().catch((err) => {
  console.error("Feed generation failed:", err.message);
  process.exit(1);
});
