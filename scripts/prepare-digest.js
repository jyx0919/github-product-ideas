#!/usr/bin/env node

// ============================================================================
// GitHub Product Ideas — Prepare Digest
// ============================================================================
// Gathers everything the LLM needs to produce a digest:
// - Fetches the central GitHub project feed
// - Fetches the latest prompts from GitHub
// - Reads the user's config (language, project groups, delivery method)
// - Outputs a single JSON blob to stdout
//
// The LLM's ONLY job is to read this JSON, remix the content, and output
// the digest text. Everything else is handled here deterministically.
//
// Usage: node prepare-digest.js
// Output: JSON to stdout
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// -- Constants ---------------------------------------------------------------

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');

const DEFAULT_CONTENT_BASE =
  'https://raw.githubusercontent.com/jyx0919/git/main';
const CONTENT_BASE = (
  process.env.FOLLOW_BUILDERS_CONTENT_BASE_URL || DEFAULT_CONTENT_BASE
).replace(/\/+$/, '');
const FEED_GITHUB_URL = `${CONTENT_BASE}/feed-github.json`;

const PROMPTS_BASE = `${CONTENT_BASE}/prompts`;
const PROMPT_FILES = [
  'summarize-github.md',
  'digest-intro.md',
  'translate.md'
];
const GITHUB_GROUPS = [
  'ai-products',
  'developer-tools',
  'productivity-automation',
  'open-source-products',
  'data-infrastructure'
];
const DEFAULT_MAX_PROJECTS = 10;

// -- Fetch helpers -----------------------------------------------------------

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeGithubPreferences(value) {
  const preferences = value && typeof value === 'object' ? value : {};
  const requestedGroups = Array.isArray(preferences.enabledGroups)
    ? preferences.enabledGroups
    : GITHUB_GROUPS;
  const enabledGroups = [
    ...new Set(requestedGroups.filter(group => GITHUB_GROUPS.includes(group)))
  ];

  return {
    enabledGroups: enabledGroups.length > 0 ? enabledGroups : GITHUB_GROUPS,
    lookbackDays: clampInteger(preferences.lookbackDays, 7, 1, 30),
    maxProjectsPerDigest: clampInteger(
      preferences.maxProjectsPerDigest,
      DEFAULT_MAX_PROJECTS,
      1,
      20
    ),
    allowPreviouslyFeatured: preferences.allowPreviouslyFeatured === true
  };
}

function prepareGithubProjects(feed, githubPreferences) {
  const repositories = Array.isArray(feed?.repositories)
    ? feed.repositories
    : [];
  const enabledGroups = new Set(githubPreferences.enabledGroups);
  const eligible = repositories.filter(repository =>
    (repository.matchedGroups || []).some(group => enabledGroups.has(group))
  );
  const selected = eligible
    .slice(0, githubPreferences.maxProjectsPerDigest)
    .map(repository => {
      const {
        preliminaryScore,
        readmeQualityScore,
        readmeSignals,
        finalScore,
        ...digestRepository
      } = repository;
      return digestRepository;
    });

  return { eligible, selected };
}

function createDigestInput({ config, feedGithub, prompts, errors }) {
  const githubPreferences = normalizeGithubPreferences(
    config.githubPreferences
  );
  const { eligible, selected } = prepareGithubProjects(
    feedGithub,
    githubPreferences
  );

  return {
    status: 'ok',
    generatedAt: new Date().toISOString(),
    config: {
      language: config.language || 'en',
      frequency: config.frequency || 'weekly',
      delivery: config.delivery || { method: 'stdout' },
      githubPreferences
    },
    githubProjects: selected,
    stats: {
      availableGithubProjects: eligible.length,
      githubProjects: selected.length,
      feedGeneratedAt: feedGithub?.generatedAt || null
    },
    prompts,
    errors: errors.length > 0 ? errors : undefined
  };
}

async function validateGithubPreparation() {
  const mockFeed = {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    repositories: Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      fullName: `example/project-${index + 1}`,
      url: `https://github.com/example/project-${index + 1}`,
      matchedGroups: [index < 5 ? 'ai-products' : 'developer-tools'],
      finalScore: 100 - index,
      preliminaryScore: 80 - index,
      readmeQualityScore: 20,
      readmeSignals: { hasUsage: true },
      scoreSignals: { starGrowth: index },
      readmeExcerpt: 'Safe sample README content'
    }))
  };
  const config = {
    language: 'zh-CN',
    frequency: 'weekly',
    githubPreferences: {
      enabledGroups: ['developer-tools'],
      maxProjectsPerDigest: 2
    }
  };
  const promptPath = join(
    decodeURIComponent(new URL('.', import.meta.url).pathname),
    '..',
    'prompts',
    'summarize-github.md'
  );
  const githubPrompt = await readFile(promptPath, 'utf-8');
  const output = createDigestInput({
    config,
    feedGithub: mockFeed,
    prompts: { summarize_github: githubPrompt },
    errors: []
  });
  const checks = {
    filtersSelectedGroups:
      output.githubProjects.length === 2 &&
      output.githubProjects.every(repository =>
        repository.matchedGroups.includes('developer-tools')
      ),
    removesInternalScores: output.githubProjects.every(
      repository =>
        !('finalScore' in repository) &&
        !('preliminaryScore' in repository) &&
        !('readmeQualityScore' in repository) &&
        !('readmeSignals' in repository)
    ),
    preservesUsefulSignals: output.githubProjects.every(
      repository => 'scoreSignals' in repository
    ),
    loadsGithubPrompt:
      output.prompts.summarize_github.includes('Security Boundary'),
    excludesLegacyFeeds:
      !('x' in output) && !('podcasts' in output) && !('blogs' in output)
  };

  if (Object.values(checks).some(passed => !passed)) {
    throw new Error(
      `GitHub preparation validation failed: ${JSON.stringify(checks)}`
    );
  }
  console.log(JSON.stringify({ status: 'ok', checks }, null, 2));
}

// -- Main --------------------------------------------------------------------

async function main() {
  if (process.argv.includes('--validate-github-preparation')) {
    await validateGithubPreparation();
    return;
  }

  const errors = [];

  // 1. Read user config
  let config = {
    language: 'en',
    frequency: 'weekly',
    delivery: { method: 'stdout' },
    githubPreferences: normalizeGithubPreferences()
  };
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      errors.push(`Could not read config: ${err.message}`);
    }
  }

  // 2. Fetch the central GitHub project feed
  let feedGithub = await fetchJSON(FEED_GITHUB_URL);
  if (!feedGithub) {
    errors.push('Could not fetch GitHub project feed');
  } else if (feedGithub.schemaVersion !== 1) {
    errors.push(
      `Unsupported GitHub feed schema: ${feedGithub.schemaVersion ?? 'missing'}`
    );
    feedGithub = null;
  } else {
    if (feedGithub.errors?.length) {
      errors.push(
        ...feedGithub.errors.map(error => `GitHub feed problem: ${error}`)
      );
    }
  }

  // 3. Load prompts with priority: user custom > remote (GitHub) > local default
  //
  // If the user has a custom prompt at ~/.follow-builders/prompts/<file>,
  // use that (they personalized it — don't overwrite with remote updates).
  // Otherwise, fetch the latest from GitHub so they get central improvements.
  // If GitHub is unreachable, fall back to the local copy shipped with the skill.
  const prompts = {};
  const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);
  const localPromptsDir = join(scriptDir, '..', 'prompts');
  const userPromptsDir = join(USER_DIR, 'prompts');

  for (const filename of PROMPT_FILES) {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const userPath = join(userPromptsDir, filename);
    const localPath = join(localPromptsDir, filename);

    // Priority 1: user's custom prompt (they personalized it)
    if (existsSync(userPath)) {
      prompts[key] = await readFile(userPath, 'utf-8');
      continue;
    }

    // Priority 2: latest from GitHub (central updates)
    const remote = await fetchText(`${PROMPTS_BASE}/${filename}`);
    if (remote) {
      prompts[key] = remote;
      continue;
    }

    // Priority 3: local copy shipped with the skill
    if (existsSync(localPath)) {
      prompts[key] = await readFile(localPath, 'utf-8');
    } else {
      errors.push(`Could not load prompt: ${filename}`);
    }
  }

  // 4. Build the output — everything the LLM needs in one blob
  const output = createDigestInput({ config, feedGithub, prompts, errors });

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({
    status: 'error',
    message: err.message
  }));
  process.exit(1);
});
