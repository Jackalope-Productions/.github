// Deploy-order gate: sets a commit status on each evaluated PR head saying whether every
// Depends-On-Deployed dependency is confirmed deployed to the env this PR's base branch deploys to.
import { appendFileSync } from 'node:fs';
import { parseDeps, pickLatestEnvTag, isCarryOfPr, depKey, decide, prRefsFromSubject } from './lib.mjs';

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const REPO = process.env.REPO;
const [OWNER] = REPO.split('/');
// Secrets set through a PowerShell pipe can carry a BOM, which fetch rejects in a header.
const clean = (t) => (t || '').replace(/^﻿/, '').trim();
const OWN_TOKEN = clean(process.env.GH_TOKEN);
const READ_TOKEN = clean(process.env.READ_TOKEN) || OWN_TOKEN;
const CONTEXT = process.env.STATUS_CONTEXT || 'deploy-order';
const RUN_URL = process.env.RUN_URL || '';
const PR_NUMBER = process.env.PR_NUMBER ? Number(process.env.PR_NUMBER) : null;
const MAX_COMMITS = 2000;

let BRANCH_ENV_MAP;
try {
  BRANCH_ENV_MAP = JSON.parse(process.env.BRANCH_ENV_MAP || '{}');
} catch {
  console.error('::error::branch_env_map is not valid JSON');
  process.exit(1);
}

async function gh(path, { token = OWN_TOKEN, method = 'GET', body } = {}) {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`${method} ${path.replace(API, '')} -> HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return { data: res.status === 204 ? null : await res.json(), link: res.headers.get('link') || '' };
}

async function ghAll(path, opts, cap = Infinity) {
  const out = [];
  let url = path + (path.includes('?') ? '&' : '?') + 'per_page=100';
  while (url && out.length < cap) {
    const { data, link } = await gh(url, opts);
    out.push(...data);
    const next = link.split(',').find((p) => p.includes('rel="next"'));
    url = next ? next.match(/<([^>]+)>/)[1] : null;
  }
  return out.slice(0, cap);
}

const sameRepo = (owner, repo) => `${owner}/${repo}`.toLowerCase() === REPO.toLowerCase();
const tokenFor = (owner, repo) => (sameRepo(owner, repo) ? OWN_TOKEN : READ_TOKEN);

const tagCache = new Map();
async function envTagSha(owner, repo, env) {
  const key = `${owner}/${repo}@${env}`;
  if (tagCache.has(key)) return tagCache.get(key);
  const token = tokenFor(owner, repo);
  const refs = await ghAll(`/repos/${owner}/${repo}/git/matching-refs/tags/${env}-`, { token });
  const name = pickLatestEnvTag(refs.map((r) => r.ref.replace('refs/tags/', '')), env);
  let result = null;
  if (name) {
    const ref = refs.find((r) => r.ref === `refs/tags/${name}`);
    let obj = ref.object;
    if (obj.type === 'tag') obj = (await gh(`/repos/${owner}/${repo}/git/tags/${obj.sha}`, { token })).data.object;
    result = { name, sha: obj.sha };
  }
  tagCache.set(key, result);
  return result;
}

async function checkDep(dep) {
  const { owner, repo, number, env } = dep;
  const token = tokenFor(owner, repo);
  const base = { ...dep };
  let pr;
  try {
    pr = (await gh(`/repos/${owner}/${repo}/pulls/${number}`, { token })).data;
  } catch (e) {
    if (e.status === 404) return { ...base, met: false, reason: 'PR not found or not readable with the gate token' };
    throw e;
  }
  if (!pr.merged_at) return { ...base, met: false, reason: 'PR is not merged' };
  const tag = await envTagSha(owner, repo, env);
  if (!tag) return { ...base, met: false, reason: `no ${env}-* deploy tag in ${repo}` };
  const cmp = (await gh(`/repos/${owner}/${repo}/compare/${tag.sha}...${pr.merge_commit_sha}`, { token })).data;
  if (cmp.status === 'identical' || cmp.status === 'behind') {
    return { ...base, met: true, reason: `merge commit is in ${tag.name}` };
  }
  const since = encodeURIComponent(pr.merged_at);
  const history = await ghAll(`/repos/${owner}/${repo}/commits?sha=${tag.sha}&since=${since}`, { token }, 300);
  const carry = history.find((c) => isCarryOfPr(c.commit.message, number));
  if (carry) return { ...base, met: true, reason: `cherry-pick ${carry.sha.slice(0, 7)} is in ${tag.name}` };
  return { ...base, met: false, reason: `not in latest ${env} deploy (${tag.name})` };
}

const prCache = new Map();
async function prInfo(number) {
  if (!prCache.has(number)) {
    try {
      prCache.set(number, (await gh(`/repos/${REPO}/pulls/${number}`)).data);
    } catch (e) {
      if (e.status !== 404) throw e;
      prCache.set(number, null);
    }
  }
  return prCache.get(number);
}

// Uses compare (paginated) because the PR commits endpoint silently stops at 250.
async function prCommits(pr) {
  const out = [];
  let total = 0;
  for (let page = 1; out.length < MAX_COMMITS; page++) {
    const { data } = await gh(`/repos/${REPO}/compare/${encodeURIComponent(pr.base.ref)}...${pr.head.sha}?per_page=100&page=${page}`);
    total = data.total_commits;
    out.push(...data.commits);
    if (!data.commits.length || out.length >= total) break;
  }
  if (out.length < total) throw new Error(`PR carries ${total} commits; only ${out.length} could be checked`);
  return out;
}

async function collectDeps(pr, env) {
  const errors = [];
  const found = new Map();
  const add = (deps, source, allowEnvOverride) => {
    for (const d of deps) {
      const dep = { ...d, env: allowEnvOverride && d.env ? d.env : env, source };
      found.set(depKey(dep), dep);
    }
  };
  const own = parseDeps(pr.body, OWNER);
  errors.push(...own.errors);
  add(own.deps, `#${pr.number}`, true);

  // Promotion PRs carry the commits of earlier PRs but not their bodies; harvest those trailers too.
  const commits = await prCommits(pr);
  const seen = new Set([pr.number]);
  for (const c of commits) {
    // Squash and merge-commit subjects name the PR, which saves one API call per commit.
    let assoc = [];
    for (const n of prRefsFromSubject(c.commit.message)) {
      const info = await prInfo(n);
      // Only trust the subject when that PR's merge produced this exact commit; cherry-picks fall through.
      if (info && info.merge_commit_sha === c.sha) assoc.push(info);
    }
    if (!assoc.length) assoc = (await gh(`/repos/${REPO}/commits/${c.sha}/pulls`)).data;
    for (const a of assoc) {
      if (seen.has(a.number) || !a.merged_at) continue;
      seen.add(a.number);
      const parsed = parseDeps(a.body || (await prInfo(a.number))?.body || '', OWNER, { strict: false });
      errors.push(...parsed.errors.map((e) => `#${a.number}: ${e}`));
      add(parsed.deps, `#${a.number}`, false);
    }
  }
  return { deps: [...found.values()], errors };
}

async function setStatus(sha, state, description) {
  if (process.env.DRY_RUN === '1') return console.log(`[dry-run] ${sha.slice(0, 7)} ${state}: ${description}`);
  await gh(`/repos/${REPO}/statuses/${sha}`, {
    method: 'POST',
    body: { state, description, context: CONTEXT, ...(RUN_URL ? { target_url: RUN_URL } : {}) },
  });
}

function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}

async function evaluate(pr) {
  const sha = pr.head.sha;
  const env = BRANCH_ENV_MAP[pr.base.ref];
  if (!env) {
    await setStatus(sha, 'success', `Base ${pr.base.ref} is not a mapped deploy branch`);
    return 'success';
  }
  let verdict;
  const results = [];
  const errors = [];
  try {
    const collected = await collectDeps(pr, env);
    errors.push(...collected.errors);
    for (const dep of collected.deps) results.push(await checkDep(dep));
    verdict = decide(results, errors);
  } catch (e) {
    verdict = decide([], [e.message]);
  }
  await setStatus(sha, verdict.state, verdict.description);
  summary([
    `### #${pr.number} -> ${pr.base.ref} (${env}): ${verdict.state}`,
    verdict.description,
    ...(results.length ? ['', '| Dependency | Env | From | Met | Detail |', '|---|---|---|---|---|'] : []),
    ...results.map((r) => `| ${r.owner}/${r.repo}#${r.number} | ${r.env} | ${r.source} | ${r.met ? 'yes' : 'no'} | ${r.reason} |`),
    ...errors.map((e) => `- error: ${e}`),
    '',
  ]);
  console.log(`#${pr.number}: ${verdict.state} - ${verdict.description}`);
  return verdict.state;
}

async function main() {
  let prs;
  if (PR_NUMBER) {
    prs = [(await gh(`/repos/${REPO}/pulls/${PR_NUMBER}`)).data];
    if (process.env.DRY_RUN === '1' && process.env.BODY_OVERRIDE) prs[0].body = process.env.BODY_OVERRIDE;
  } else {
    const open = await ghAll(`/repos/${REPO}/pulls?state=open`);
    prs = open.filter((p) => BRANCH_ENV_MAP[p.base.ref] && !p.draft);
  }
  let internalError = false;
  for (const pr of prs) {
    if ((await evaluate(pr)) === 'error') internalError = true;
  }
  if (!prs.length) console.log('No open PRs on mapped deploy branches.');
  if (internalError) process.exit(1);
}

main().catch((e) => {
  console.error(`::error::${e.message}`);
  process.exit(1);
});
