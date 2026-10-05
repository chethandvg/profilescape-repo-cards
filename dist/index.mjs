// src/action/main.ts
import { readFileSync as readFileSync2, realpathSync } from "node:fs";
import { relative as relative2, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";

// src/core/calendar.ts
var DAY = 864e5;
var isoDate = (d) => d.toISOString().slice(0, 10);
var parseDate = (iso) => /* @__PURE__ */ new Date(`${iso.slice(0, 10)}T00:00:00Z`);
function countsByDate(calendar) {
  return new Map(calendar.map((d) => [d.date, d.count]));
}
function yearWindow(calendar, now, weeks = 53) {
  const today = parseDate(isoDate(now));
  const start = today.getTime() - (today.getUTCDay() + (weeks - 1) * 7) * DAY;
  const counts = countsByDate(calendar);
  const cells = [];
  for (let t = start, i = 0; t <= today.getTime(); t += DAY, i++) {
    const date = isoDate(new Date(t));
    cells.push({ week: Math.floor(i / 7), day: i % 7, date, count: counts.get(date) ?? 0 });
  }
  return cells;
}
function yearStart(now) {
  const today = parseDate(isoDate(now));
  const y = today.getUTCFullYear() - 1;
  const m = today.getUTCMonth();
  const start = new Date(Date.UTC(y, m, today.getUTCDate()));
  return isoDate(start.getUTCMonth() === m ? start : new Date(Date.UTC(y, m + 1, 0)));
}
var cleanCount = (c) => typeof c === "number" && Number.isFinite(c) && c > 0 ? c : 0;
function lastYear(calendar, now) {
  const counts = countsByDate(Array.isArray(calendar) ? calendar.filter((d) => d && typeof d.date === "string") : []);
  const end = parseDate(isoDate(now)).getTime();
  const days = [];
  for (let t = parseDate(yearStart(now)).getTime(); t <= end; t += DAY) {
    const date = isoDate(new Date(t));
    days.push({ date, count: cleanCount(counts.get(date)) });
  }
  return days;
}
function yearTotal(data, now) {
  return cleanCount(data.year?.contributions) || totalOf(lastYear(data.calendar, now));
}
function monthStarts(cells, weeks, minGap, minTail = 2) {
  const starts = [];
  let prev = -1;
  for (let w = 0; w < weeks; w++) {
    const first = cells.find((c) => c.week === w);
    if (!first) continue;
    const month = Number(first.date.slice(5, 7)) - 1;
    if (month !== prev) starts.push({ week: w, month });
    prev = month;
  }
  return starts.filter((s, i) => {
    const next = starts[i + 1];
    if (i === 0 && next && next.week - s.week < minGap) return false;
    return !(i > 0 && !next && weeks - s.week < minTail);
  });
}
function streaks(calendar, now) {
  const today = isoDate(now);
  const days = calendar.filter((d) => d.date <= today);
  let longest = 0;
  let run2 = 0;
  for (const d of days) {
    run2 = d.count > 0 ? run2 + 1 : 0;
    longest = Math.max(longest, run2);
  }
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (!d) break;
    if (d.count > 0) current++;
    else if (i === days.length - 1 && d.date === today) continue;
    else break;
  }
  return { current, longest };
}
function levelScale(counts) {
  const nz = counts.filter((c) => c > 0).sort((a, b) => a - b);
  if (!nz.length) return () => 0;
  const q = [0.25, 0.5, 0.75].map((p) => nz[Math.min(nz.length - 1, Math.floor(nz.length * p))] ?? 0);
  return (c) => {
    if (c <= 0) return 0;
    if (c <= (q[0] ?? 0)) return 1;
    if (c <= (q[1] ?? 0)) return 2;
    if (c <= (q[2] ?? 0)) return 3;
    return 4;
  };
}
var totalOf = (days) => days.reduce((s, d) => s + d.count, 0);

// src/core/github.ts
var GitHubError = class extends Error {
  status;
  /** GraphQL error type (e.g. RESOURCE_LIMITS_EXCEEDED) or a local code (TIMEOUT, NETWORK, ORGANIZATION). */
  type;
  constructor(message, status, type) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.type = type;
  }
};
var LISTING_FIELDS = `
fragment RepoListing on Repository {
  id name nameWithOwner owner { login } description url homepageUrl
  stargazerCount forkCount isArchived isFork isPrivate isTemplate pushedAt createdAt
  primaryLanguage { name color }
  repositoryTopics(first: 8) { nodes { topic { name } } }
  languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name color } } }
}`;
var DETAIL_FIELDS = `
fragment RepoDetail on Repository {
  watchers { totalCount }
  issues(states: OPEN) { totalCount }
  pullRequests(states: OPEN) { totalCount }
  licenseInfo { spdxId }
  latestRelease { tagName publishedAt }
}`;
var PROFILE_Q = `
query($login: String!) {
  user(login: $login) {
    login name bio location company websiteUrl twitterUsername avatarUrl createdAt
    followers { totalCount }
    following { totalCount }
    publicRepos: repositories(privacy: PUBLIC, ownerAffiliations: OWNER, isFork: false) { totalCount }
    pinnedItems(first: 6, types: REPOSITORY) { nodes { ... on Repository { ...RepoListing } } }
    contributionsCollection {
      contributionYears
      totalCommitContributions totalPullRequestContributions totalIssueContributions
      totalPullRequestReviewContributions totalRepositoryContributions restrictedContributionsCount
      contributionCalendar { totalContributions }
    }
  }
}
${LISTING_FIELDS}`;
var COMMITS_Q = `
query($login: String!, $max: Int!) {
  user(login: $login) {
    contributionsCollection {
      commitContributionsByRepository(maxRepositories: $max) {
        contributions { totalCount }
        repository {
          nameWithOwner isPrivate isFork
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name color } } }
        }
      }
    }
  }
}`;
var REPOS_Q = `
query($login: String!, $cursor: String, $first: Int!) {
  user(login: $login) {
    repositories(first: $first, after: $cursor, ownerAffiliations: OWNER, isFork: false,
                 orderBy: { field: STARGAZERS, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ...RepoListing }
    }
  }
}
${LISTING_FIELDS}`;
var STARS_Q = `
query($login: String!, $cursor: String) {
  user(login: $login) {
    repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, isFork: false,
                 orderBy: { field: STARGAZERS, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { nameWithOwner stargazerCount isPrivate }
    }
  }
}`;
var DETAILS_Q = `
query($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Repository { id ...RepoDetail } }
}
${DETAIL_FIELDS}`;
var CALENDAR_Q = `
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar { weeks { contributionDays { date contributionCount } } }
    }
  }
}`;
var REPO_Q = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { ...RepoListing ...RepoDetail }
}
${LISTING_FIELDS}
${DETAIL_FIELDS}`;
var OWNER_Q = `
query($login: String!) {
  repositoryOwner(login: $login) { __typename }
}`;
var DETAIL_CANDIDATES = 12;
var MAX_TOTAL_REPO_PAGES = 50;
var CALENDAR_CONCURRENCY = 4;
var DAY_MS = 864e5;
var sleep = (ms) => ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
function summarizeErrors(errors) {
  const counts = /* @__PURE__ */ new Map();
  for (const e of errors) counts.set(e.message, (counts.get(e.message) ?? 0) + 1);
  const parts2 = [...counts].map(([m, n2]) => n2 > 1 ? `${m} (x${n2})` : m);
  return parts2.length > 3 ? `${parts2.slice(0, 3).join("; ")}; and ${parts2.length - 3} more` : parts2.join("; ");
}
function networkError(err, timeoutMs, endpoint) {
  const e = err;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    return new GitHubError(`GitHub API did not respond within ${Math.round(timeoutMs / 1e3)}s.`, void 0, "TIMEOUT");
  }
  let host = endpoint;
  try {
    host = new URL(endpoint).host;
  } catch {
  }
  const detail = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
  return new GitHubError(`Could not reach the GitHub API at ${host} (${detail}). Check the network connection and try again.`, void 0, "NETWORK");
}
async function graphql(o, query, variables, opts = {}) {
  const doFetch = o.fetchImpl ?? fetch;
  const endpoint = o.apiUrl ?? "https://api.github.com/graphql";
  const timeoutMs = o.timeoutMs ?? 3e4;
  const baseDelay = o.retryDelayMs ?? 800;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(baseDelay * 2 ** attempt);
    let res;
    let text;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), timeoutMs);
    try {
      res = await doFetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `bearer ${o.token}`,
          "Content-Type": "application/json",
          "User-Agent": "profilescape"
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal
      });
      text = await res.text();
    } catch (err) {
      lastError = networkError(err, timeoutMs, endpoint);
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 500) {
      lastError = new GitHubError(`GitHub API responded ${res.status}`, res.status);
      continue;
    }
    if (res.status === 401) throw new GitHubError("GitHub rejected the token (401). Check that the token is valid and not expired.", 401);
    if (res.status === 403 || res.status === 429) {
      throw new GitHubError(`GitHub API rate limit or permission error (${res.status}): ${text.slice(0, 200)}`, res.status);
    }
    if (!res.ok) throw new GitHubError(`GitHub API responded ${res.status}: ${text.slice(0, 200)}`, res.status);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      lastError = new GitHubError("GitHub API returned invalid JSON");
      continue;
    }
    if (body.errors?.length) {
      const msg = summarizeErrors(body.errors);
      const types = new Set(body.errors.map((e) => e.type));
      if (types.has("RATE_LIMITED")) throw new GitHubError(`GitHub API rate limit exceeded: ${msg}`, 429, "RATE_LIMITED");
      if (types.has("RESOURCE_LIMITS_EXCEEDED")) throw new GitHubError(`GitHub GraphQL error: ${msg}`, void 0, "RESOURCE_LIMITS_EXCEEDED");
      if (/something went wrong|timeout/i.test(msg)) {
        lastError = new GitHubError(`GitHub GraphQL error: ${msg}`);
        continue;
      }
      if (opts.allowPartial && body.data) {
        o.log?.(`GitHub left out some data: ${msg}`);
        return body.data;
      }
      if (types.has("NOT_FOUND")) throw new GitHubError(`Not found: ${msg}`, 404, "NOT_FOUND");
      throw new GitHubError(`GitHub GraphQL error: ${msg}`, void 0, [...types][0]);
    }
    if (!body.data) throw new GitHubError("GitHub API returned no data");
    return body.data;
  }
  throw lastError instanceof Error ? lastError : new GitHubError(String(lastError));
}
var isResourceLimit = (err) => err instanceof GitHubError && err.type === "RESOURCE_LIMITS_EXCEEDED";
var FALLBACK_COLOR = "#8B949E";
var langs = (l) => (l?.edges ?? []).map((e) => ({ name: e.node.name, color: e.node.color ?? FALLBACK_COLOR, value: e.size }));
function detailOf(r, createdAt) {
  return {
    watchers: r.watchers?.totalCount ?? 0,
    openIssues: r.issues?.totalCount ?? 0,
    openPullRequests: r.pullRequests?.totalCount ?? 0,
    license: r.licenseInfo?.spdxId && r.licenseInfo.spdxId !== "NOASSERTION" ? r.licenseInfo.spdxId : null,
    latestRelease: r.latestRelease ? { tag: r.latestRelease.tagName, publishedAt: r.latestRelease.publishedAt ?? createdAt } : null
  };
}
function toRepo(r) {
  return {
    owner: r.owner.login,
    name: r.name,
    nameWithOwner: r.nameWithOwner,
    description: r.description,
    url: r.url,
    homepageUrl: r.homepageUrl || null,
    stars: r.stargazerCount,
    forks: r.forkCount,
    ...detailOf(r, r.createdAt),
    primaryLanguage: r.primaryLanguage ? { name: r.primaryLanguage.name, color: r.primaryLanguage.color ?? FALLBACK_COLOR } : null,
    languages: langs(r.languages),
    topics: (r.repositoryTopics?.nodes ?? []).map((n2) => n2.topic.name),
    isArchived: r.isArchived,
    isFork: r.isFork,
    isPrivate: r.isPrivate,
    isTemplate: r.isTemplate,
    pushedAt: r.pushedAt ?? r.createdAt,
    createdAt: r.createdAt
  };
}
function aggregate(entries, hide) {
  const out = /* @__PURE__ */ new Map();
  for (const { weight, languages } of entries) {
    const visible = languages.filter((l) => !hide.has(l.name.toLowerCase()));
    const total = visible.reduce((s, l) => s + l.value, 0);
    if (!total || !weight) continue;
    for (const l of visible) {
      const cur = out.get(l.name) ?? { name: l.name, color: l.color, value: 0 };
      cur.value += weight * l.value / total;
      out.set(l.name, cur);
    }
  }
  return [...out.values()].sort((a, b) => b.value - a.value);
}
async function mapLimit(items2, limit, fn) {
  const out = new Array(items2.length);
  let next = 0;
  const worker = async () => {
    while (next < items2.length) {
      const i = next++;
      out[i] = await fn(items2[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items2.length) }, worker));
  return out;
}
function calendarWindows(history, createdAt, contributionYears, now) {
  const windows = [];
  if (history === "year") {
    let start2 = new Date(now.getTime() - 372 * DAY_MS);
    while (start2 < now) {
      const end = new Date(Math.min(start2.getTime() + 365 * DAY_MS, now.getTime()));
      windows.push({ from: start2, to: end });
      start2 = end;
    }
    return windows;
  }
  const created = Date.parse(createdAt);
  const years = contributionYears.filter((y) => Number.isInteger(y));
  const firstYearStart = years.length ? Date.UTC(Math.min(...years), 0, 1) : Number.NaN;
  let startMs = Math.min(...[created, firstYearStart].filter(Number.isFinite));
  if (!Number.isFinite(startMs)) startMs = now.getTime() - 372 * DAY_MS;
  startMs = Math.max(startMs, Date.UTC(now.getUTCFullYear() - 25, 0, 1));
  let start = new Date(startMs);
  while (start < now) {
    const nextYear = Date.UTC(start.getUTCFullYear() + 1, 0, 1);
    const end = new Date(Math.min(nextYear - 1e3, now.getTime()));
    windows.push({ from: start, to: end });
    start = new Date(nextYear);
  }
  return windows;
}
async function fetchCalendar(o, createdAt, contributionYears, now) {
  const windows = calendarWindows(o.history ?? "full", createdAt, contributionYears, now);
  const results = await mapLimit(
    windows,
    CALENDAR_CONCURRENCY,
    (w) => graphql(o, CALENDAR_Q, { login: o.login, from: w.from.toISOString(), to: w.to.toISOString() })
  );
  const days = /* @__PURE__ */ new Map();
  for (const data of results) {
    for (const w of data.user.contributionsCollection.contributionCalendar.weeks) {
      for (const d of w.contributionDays) days.set(d.date, d.contributionCount);
    }
  }
  const today = isoDate(now);
  return [...days.entries()].filter(([date]) => date <= today).sort(([a], [b]) => a < b ? -1 : 1).map(([date, count]) => ({ date, count }));
}
async function fetchRepo(o, spec) {
  const [owner, name] = spec.includes("/") ? spec.split("/", 2) : [o.login, spec];
  try {
    const data = await graphql(o, REPO_Q, { owner, name });
    return data.repository ? toRepo(data.repository) : null;
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) {
      o.log?.(`Repository ${owner}/${name} not found or not visible to the token; skipping.`);
      return null;
    }
    throw err;
  }
}
async function fetchCommitRepos(o) {
  for (let max = 100; ; max = Math.floor(max / 2)) {
    try {
      const data = await graphql(
        o,
        COMMITS_Q,
        { login: o.login, max },
        { allowPartial: true }
      );
      const list = data.user?.contributionsCollection?.commitContributionsByRepository ?? [];
      return list.filter((r) => !!r?.repository);
    } catch (err) {
      if (!isResourceLimit(err) || max <= 12) throw err;
      o.log?.(`Commit statistics were too heavy for one request; retrying with the top ${Math.floor(max / 2)} repositories.`);
    }
  }
}
async function fetchRepoListing(o) {
  const detailedLimit = Math.max(1, Math.floor(o.maxRepoPages ?? 5)) * 100;
  const repos = [];
  let cursor = null;
  let size = 100;
  let pages = 0;
  let more = true;
  while (more && repos.length < detailedLimit) {
    const first = Math.min(size, detailedLimit - repos.length);
    let data;
    try {
      data = await graphql(o, REPOS_Q, { login: o.login, cursor, first });
    } catch (err) {
      if (!isResourceLimit(err) || size <= 10) throw err;
      size = Math.max(10, Math.floor(size / 2));
      o.log?.(`GitHub found a page of 100 repositories too heavy; retrying with ${size} per page.`);
      continue;
    }
    pages++;
    repos.push(...data.user.repositories.nodes.filter((n2) => !!n2));
    more = data.user.repositories.pageInfo.hasNextPage;
    cursor = data.user.repositories.pageInfo.endCursor;
  }
  const tail = [];
  if (more) {
    o.log?.(`Read languages and topics of the ${repos.length} most starred repositories; counting stars of the rest.`);
    while (more && pages < MAX_TOTAL_REPO_PAGES) {
      const data = await graphql(o, STARS_Q, { login: o.login, cursor });
      pages++;
      tail.push(...data.user.repositories.nodes.filter((n2) => !!n2));
      more = data.user.repositories.pageInfo.hasNextPage;
      cursor = data.user.repositories.pageInfo.endCursor;
    }
    if (more) o.log?.(`Stopped after ${repos.length + tail.length} repositories; stars of the rest are not counted.`);
  }
  return { repos, tail };
}
async function fetchDetails(o, ids) {
  const out = /* @__PURE__ */ new Map();
  if (!ids.length) return out;
  const data = await graphql(o, DETAILS_Q, { ids }, { allowPartial: true });
  for (const n2 of data.nodes ?? []) if (n2?.id) out.set(n2.id, n2);
  return out;
}
async function explainMissingUser(o, original) {
  let kind;
  try {
    kind = (await graphql(o, OWNER_Q, { login: o.login })).repositoryOwner?.__typename;
  } catch {
  }
  if (kind === "Organization") {
    throw new GitHubError(
      `"${o.login}" is an organization. Profilescape renders personal profiles, so set the username to a user account.`,
      404,
      "ORGANIZATION"
    );
  }
  throw original;
}
async function fetchProfile(o) {
  const now = o.now ?? /* @__PURE__ */ new Date();
  const includePrivate = o.includePrivate ?? true;
  const hide = new Set((o.hideLanguages ?? []).map((l) => l.toLowerCase()));
  const exclude = new Set((o.excludeRepos ?? []).map((r) => r.toLowerCase()));
  const isExcluded = (nameWithOwner) => {
    const lower = nameWithOwner.toLowerCase();
    return exclude.has(lower) || exclude.has(lower.split("/")[1] ?? "");
  };
  let u;
  try {
    u = (await graphql(o, PROFILE_Q, { login: o.login })).user;
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return explainMissingUser(o, err);
    throw err;
  }
  if (!u) return explainMissingUser(o, new GitHubError(`GitHub user "${o.login}" not found`, 404, "NOT_FOUND"));
  const cc = u.contributionsCollection;
  const [commitRepos, listing] = await Promise.all([fetchCommitRepos(o), fetchRepoListing(o)]);
  const visible = (r) => (includePrivate || !r.isPrivate) && !isExcluded(r.nameWithOwner);
  const profileRepo = `${u.login}/${u.login}`.toLowerCase();
  const rawPinned = u.pinnedItems.nodes.filter((r) => !!r?.nameWithOwner).filter(visible);
  const rawOwn = listing.repos.filter(visible);
  const ranked = rawOwn.filter((r) => !r.isPrivate && !r.isArchived && r.nameWithOwner.toLowerCase() !== profileRepo).sort((a, b) => b.stargazerCount - a.stargazerCount || ((b.pushedAt ?? "") > (a.pushedAt ?? "") ? 1 : (b.pushedAt ?? "") < (a.pushedAt ?? "") ? -1 : 0)).slice(0, DETAIL_CANDIDATES);
  const ids = [...new Set([...rawPinned, ...ranked].map((r) => r.id).filter((id) => !!id))];
  const [calendar, extraFetched, details] = await Promise.all([
    fetchCalendar(o, u.createdAt, cc.contributionYears ?? [], now),
    Promise.all((o.extraRepos ?? []).map((spec) => fetchRepo(o, spec))),
    fetchDetails(o, ids)
  ]);
  const withDetail = (r) => {
    const d = r.id ? details.get(r.id) : void 0;
    return toRepo(d ? { ...r, ...d } : r);
  };
  const ownRepos = rawOwn.map(withDetail);
  const extra = extraFetched.filter((r) => r !== null && (includePrivate || !r.isPrivate));
  const committed = commitRepos.filter((r) => {
    const repo = r.repository;
    return !!repo && repo.nameWithOwner.toLowerCase() !== profileRepo && !repo.isFork && (includePrivate || !repo.isPrivate) && !isExcluded(repo.nameWithOwner);
  });
  const languagesByBytes = aggregate(
    ownRepos.map((r) => ({ weight: r.languages.reduce((s, l) => s + l.value, 0), languages: r.languages })),
    hide
  );
  const byCommits = aggregate(
    committed.map((r) => ({ weight: r.contributions.totalCount, languages: langs(r.repository?.languages) })),
    hide
  );
  const everyRepo = [...listing.repos, ...listing.tail];
  const publicIncluded = everyRepo.filter((r) => !r.isPrivate && !isExcluded(r.nameWithOwner));
  const excludedPublic = everyRepo.length - publicIncluded.length - everyRepo.filter((r) => r.isPrivate).length;
  const publicTotal = typeof u.publicRepos?.totalCount === "number" ? u.publicRepos.totalCount : everyRepo.filter((r) => !r.isPrivate).length;
  return {
    login: u.login,
    name: u.name || null,
    bio: u.bio || null,
    location: u.location || null,
    company: u.company || null,
    websiteUrl: u.websiteUrl || null,
    twitter: u.twitterUsername || null,
    avatarUrl: u.avatarUrl,
    createdAt: u.createdAt,
    followers: u.followers.totalCount,
    following: u.following.totalCount,
    calendar,
    year: {
      contributions: cc.contributionCalendar.totalContributions,
      commits: cc.totalCommitContributions,
      pullRequests: cc.totalPullRequestContributions,
      issues: cc.totalIssueContributions,
      reviews: cc.totalPullRequestReviewContributions,
      reposCreated: cc.totalRepositoryContributions,
      restricted: cc.restrictedContributionsCount
    },
    languages: byCommits.length ? byCommits : languagesByBytes,
    languagesByBytes,
    repos: ownRepos,
    pinned: rawPinned.map(withDetail),
    extraRepos: extra,
    totalStars: publicIncluded.reduce((s, r) => s + r.stargazerCount, 0),
    publicRepoCount: Math.max(0, publicTotal - excludedPublic),
    generatedAt: now.toISOString()
  };
}

// src/core/format.ts
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function compact(value) {
  const v = Math.round(value);
  if (Math.abs(v) >= 1e6) return `${trim(v / 1e6)}M`;
  if (Math.abs(v) >= 1e4) return `${trim(v / 1e3)}k`;
  return v.toLocaleString("en-US");
}
function trim(x) {
  return x.toFixed(1).replace(/\.0$/, "");
}
var DISPLAY_NAMES = {
  "jupyter notebook": "Jupyter",
  "visual basic .net": "VB.NET",
  "protocol buffer": "Protobuf",
  batchfile: "Batch",
  tsql: "T-SQL",
  plpgsql: "PL/pgSQL"
};
function displayName(language) {
  const name = language.trim();
  return Object.hasOwn(DISPLAY_NAMES, name.toLowerCase()) ? DISPLAY_NAMES[name.toLowerCase()] : name;
}
function plural(count, one, many = `${one}s`) {
  return count === 1 ? one : many;
}
function percent(fraction, digits = 1) {
  return `${(fraction * 100).toFixed(digits)}%`;
}
var valid = (iso) => !!iso && Number.isFinite(Date.parse(iso));
function parts(iso) {
  const [y = "1970", m = "1", d = "1"] = iso.slice(0, 10).split("-");
  return { y: Number(y), m: Number(m), d: Number(d) };
}
function shortDate(iso) {
  if (!valid(iso)) return "";
  const { y, m, d } = parts(iso);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}
function monthYear(iso) {
  if (!valid(iso)) return "";
  const { y, m } = parts(iso);
  return `${MONTHS[m - 1]} ${y}`;
}
function relativeTime(iso, now) {
  if (!valid(iso)) return "";
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 864e5);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months} ${plural(months, "month")} ago`;
  const years = Math.floor(days / 365.25);
  return `${years} ${plural(years, "year")} ago`;
}

// src/core/svg.ts
var SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',Helvetica,Arial,sans-serif";
var MONO = "ui-monospace,SFMono-Regular,'JetBrains Mono','Cascadia Code',Consolas,Menlo,monospace";
var REDUCED_MOTION = "@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important}}";
var XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function esc(value) {
  return String(value).replace(XML_INVALID, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function n(value, digits = 1) {
  const f = 10 ** digits;
  return String(Math.round(value * f) / f);
}
var NARROW = new Set("iljtfr.,:;'|!I ");
var WIDE = new Set("mwMW@");
function textWidth(s, size, opts = {}) {
  const chars = [...s];
  if (opts.mono) return chars.length * size * 0.6;
  let narrow = 0;
  let wide = 0;
  for (const ch of chars) {
    if (NARROW.has(ch)) narrow++;
    else if (WIDE.has(ch)) wide++;
  }
  const factor = (opts.weight ?? 400) < 600 ? 0.53 : 0.57;
  return (chars.length - narrow * 0.45 + wide * 0.35) * size * factor;
}
var TRAILING_SEPARATORS = /[\s.,;:!?·|/-]+$/;
function fit(s, maxWidth, size, opts = {}) {
  if (textWidth(s, size, opts) <= maxWidth) return s;
  const chars = [...s];
  while (chars.length > 1 && textWidth(`${chars.join("")}\u2026`, size, opts) > maxWidth) chars.pop();
  const kept = chars.join("");
  return `${kept.replace(TRAILING_SEPARATORS, "") || kept.trimEnd()}\u2026`;
}
function wrapPx(text, maxWidth, size, opts = {}, maxLines = Number.POSITIVE_INFINITY) {
  const w = (s) => textWidth(s, size, opts);
  const words2 = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (w(word) <= maxWidth) {
      words2.push(word);
      continue;
    }
    let rest = [...word];
    while (rest.length) {
      let cut = rest.length;
      while (cut > 1 && w(rest.slice(0, cut).join("")) > maxWidth) cut--;
      words2.push(rest.slice(0, cut).join(""));
      rest = rest.slice(cut);
    }
  }
  const lines = [];
  let cur = "";
  for (const word of words2) {
    const next = cur ? `${cur} ${word}` : word;
    if (!cur || w(next) <= maxWidth) cur = next;
    else {
      lines.push(cur);
      cur = word;
      if (lines.length > maxLines) break;
    }
  }
  if (cur && lines.length <= maxLines) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const trail = TRAILING_SEPARATORS;
  let last = (kept[maxLines - 1] ?? "").replace(trail, "");
  while (last && w(`${last}\u2026`) > maxWidth) {
    const sp = last.lastIndexOf(" ");
    last = (sp > 0 ? last.slice(0, sp) : [...last].slice(0, -1).join("")).replace(trail, "");
  }
  kept[maxLines - 1] = `${last}\u2026`;
  return kept;
}
function labelWidth(text, m = {}) {
  return [...text].length * ((m.size ?? 12) * 0.6 + (m.spacing ?? 1.4));
}
function fitLabel(text, maxWidth, m = {}) {
  if (labelWidth(text, m) <= maxWidth) return text;
  const chars = [...text];
  while (chars.length > 1 && labelWidth(`${chars.join("")}\u2026`, m) > maxWidth) chars.pop();
  return `${chars.join("").trimEnd()}\u2026`;
}
var HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
function safeColor(value, fallback) {
  if (typeof value !== "string") return fallback;
  const v = value.trim();
  return HEX_COLOR.test(v) ? v : fallback;
}
function rgb(hex2) {
  let h = hex2.replace("#", "").trim();
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const v = Number.parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(v)) return [136, 136, 136];
  return [v >> 16 & 255, v >> 8 & 255, v & 255];
}
function hex(r, g, b) {
  const c = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}
function mix(a, b, k) {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  return hex(ar + (br - ar) * k, ag + (bg - ag) * k, ab + (bb - ab) * k);
}
var shade = (c, k) => mix(c, "#000000", k);
var tint = (c, k) => mix(c, "#FFFFFF", k);
function luminance(c) {
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(c);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function lab(c) {
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(c).map(lin);
  const f = (t) => t > 216 / 24389 ? Math.cbrt(t) : t * 24389 / 27 / 116 + 16 / 116;
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
var lightness = (c) => lab(c)[0];
function deltaE(a, b) {
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
function toHsl([r, g, b]) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d + (G < B ? 6 : 0)) / 6 : max === G ? ((B - R) / d + 2) / 6 : ((R - G) / d + 4) / 6;
  return [h, s, l];
}
function fromHsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (offset) => {
    const k = (offset + h * 12) % 12;
    return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return hex(f(0), f(8), f(4));
}
function ensureContrast(color, background, min = 1.8, ink) {
  const lighter = ink ? luminance(ink) >= luminance(background) : contrast("#FFFFFF", background) >= contrast("#000000", background);
  const extreme = lighter ? "#FFFFFF" : "#000000";
  if (!HEX_COLOR.test(color.trim())) return ink ?? extreme;
  if (contrast(color, background) >= min) return color;
  const [h, s, l] = toHsl(rgb(color));
  const target = lighter ? 1 : 0;
  const steps = 40;
  for (let i = 1; i <= steps; i++) {
    const out = fromHsl(h, s, l + (target - l) * i / steps);
    if (contrast(out, background) >= min) return out;
  }
  return ink ?? extreme;
}
function linearGradient(id, from, to, vertical = false) {
  const [x2, y2] = vertical ? ["0", "1"] : ["1", "0"];
  return `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>`;
}
var delay = (seconds) => `style="animation-delay:${n(seconds, 3)}s"`;
var LABEL_CONTRAST = 4.5;
function labelColor(p) {
  return ensureContrast(p.accentB, p.panel, LABEL_CONTRAST, p.text);
}
function label(x, y, text, p, opts = {}) {
  const anchor = opts.anchor === "end" ? ' text-anchor="end"' : "";
  return `<text x="${n(x)}" y="${n(y)}"${anchor} class="mono" font-size="12" letter-spacing="1.4" fill="${opts.color ?? labelColor(p)}">${esc(text.toUpperCase())}</text>`;
}
function shell(o) {
  const { width: W5, height: H3, palette: p } = o;
  const r = o.radius ?? 20;
  const animate = o.animate ?? true;
  const glow2 = o.glow ? `<radialGradient id="ps-glow" cx="${o.glow.cx}" cy="${o.glow.cy}" r="${o.glow.r}"><stop offset="0" stop-color="${o.glow.color}" stop-opacity="${n(o.glow.opacity, 3)}"/><stop offset="1" stop-color="${o.glow.color}" stop-opacity="0"/></radialGradient>` : "";
  const base = `.sans{font-family:${SANS}}.mono{font-family:${MONO}}.fade{animation:ps-fade .6s ease-out backwards}@keyframes ps-fade{from{opacity:0}}.up{animation:ps-up .7s cubic-bezier(.2,.7,.2,1) backwards}@keyframes ps-up{from{opacity:0;transform:translateY(10px)}}` + REDUCED_MOTION + (animate ? "" : "*{animation:none!important}");
  const background = o.background === false ? "" : `<g clip-path="url(#ps-clip)"><rect width="${W5}" height="${H3}" fill="${p.panel}"/>${glow2 ? `<rect width="${W5}" height="${H3}" fill="url(#ps-glow)"/>` : ""}</g>`;
  const border = o.border === false ? "" : `<rect x=".5" y=".5" width="${W5 - 1}" height="${H3 - 1}" rx="${r}" fill="none" stroke="${p.border}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W5}" height="${H3}" viewBox="0 0 ${W5} ${H3}" role="img" aria-labelledby="ps-title"><title id="ps-title">${esc(o.title)}</title>${o.desc ? `<desc>${esc(o.desc)}</desc>` : ""}<defs><clipPath id="ps-clip"><rect width="${W5}" height="${H3}" rx="${r}"/></clipPath>${glow2}${o.defs ?? ""}<style>${base}${o.style ?? ""}</style></defs>${background}${o.body}${border}</svg>
`;
}

// src/core/theme-presets.ts
var PRESETS = [
  // GitHub Primer (dark default / light default) with the contribution-graph greens.
  {
    id: "github",
    label: "GitHub",
    dark: {
      bg: "#010409",
      panel: "#0D1117",
      panelAlt: "#161B22",
      border: "#30363D",
      text: "#E6EDF3",
      muted: "#9198A1",
      faint: "#6E7681",
      accentA: "#238636",
      accentB: "#39D353",
      success: "#3FB950",
      chipBg: "#161B22",
      empty: "#161B22",
      grid: "#FFFFFF",
      gridOpacity: 0.04,
      glowOpacity: 0.45,
      syntax: {
        keyword: "#FF7B72",
        type: "#FFA657",
        string: "#A5D6FF",
        property: "#7EE787",
        number: "#79C0FF",
        punctuation: "#C9D1D9",
        comment: "#8B949E"
      }
    },
    light: {
      bg: "#F6F8FA",
      panel: "#FFFFFF",
      panelAlt: "#F6F8FA",
      border: "#D0D7DE",
      text: "#1F2328",
      muted: "#59636E",
      faint: "#818B98",
      accentA: "#2DA44E",
      accentB: "#116329",
      success: "#1A7F37",
      chipBg: "#F6F8FA",
      empty: "#EBEDF0",
      grid: "#1F2328",
      gridOpacity: 0.05,
      glowOpacity: 0.2,
      syntax: {
        keyword: "#CF222E",
        type: "#953800",
        string: "#0A3069",
        property: "#116329",
        number: "#0550AE",
        punctuation: "#1F2328",
        comment: "#6E7781"
      }
    }
  },
  // folke/tokyonight Night and Day. Day text and muted are darker shades of its blue fg (#3760BF) to reach 7:1 / 4.5:1.
  {
    id: "tokyonight",
    label: "Tokyo Night",
    dark: {
      bg: "#16161E",
      panel: "#1A1B26",
      panelAlt: "#1F2335",
      border: "#292E42",
      text: "#C0CAF5",
      muted: "#9AA5CE",
      faint: "#737AA2",
      accentA: "#7AA2F7",
      accentB: "#BB9AF7",
      success: "#9ECE6A",
      chipBg: "#1F2335",
      empty: "#24283B",
      grid: "#C0CAF5",
      gridOpacity: 0.045,
      glowOpacity: 0.55,
      syntax: {
        keyword: "#BB9AF7",
        type: "#2AC3DE",
        string: "#9ECE6A",
        property: "#73DACA",
        number: "#FF9E64",
        punctuation: "#89DDFF",
        comment: "#565F89"
      }
    },
    light: {
      bg: "#D0D5E3",
      panel: "#E1E2E7",
      panelAlt: "#D8DAE3",
      border: "#C4C8DA",
      text: "#283A73",
      muted: "#4E5B8D",
      faint: "#767EA7",
      accentA: "#2E7DE9",
      accentB: "#9854F1",
      success: "#587539",
      chipBg: "#D8DAE3",
      empty: "#D0D5E3",
      grid: "#283A73",
      gridOpacity: 0.05,
      glowOpacity: 0.25,
      syntax: {
        keyword: "#9854F1",
        type: "#188092",
        string: "#587539",
        property: "#387068",
        number: "#B15C00",
        punctuation: "#006A83",
        comment: "#848CB5"
      }
    }
  },
  // Dracula and Alucard (draculatheme.com/spec). Comment is the faint tier; muted is Comment lifted toward Foreground.
  {
    id: "dracula",
    label: "Dracula",
    dark: {
      bg: "#21222C",
      panel: "#282A36",
      panelAlt: "#2F3241",
      border: "#44475A",
      text: "#F8F8F2",
      muted: "#9EA8C3",
      faint: "#6272A4",
      accentA: "#BD93F9",
      accentB: "#FF79C6",
      success: "#50FA7B",
      chipBg: "#2F3241",
      empty: "#343746",
      grid: "#F8F8F2",
      gridOpacity: 0.04,
      glowOpacity: 0.55,
      syntax: {
        keyword: "#FF79C6",
        type: "#8BE9FD",
        string: "#F1FA8C",
        property: "#50FA7B",
        number: "#BD93F9",
        punctuation: "#F8F8F2",
        comment: "#6272A4"
      }
    },
    light: {
      bg: "#F5F1DF",
      panel: "#FFFBEB",
      panelAlt: "#F7F3E1",
      border: "#E2DDCB",
      text: "#1F1F1F",
      muted: "#635D97",
      faint: "#918CB3",
      accentA: "#644AC9",
      accentB: "#A3144D",
      success: "#14710A",
      chipBg: "#F7F3E1",
      empty: "#EFEAD6",
      grid: "#1F1F1F",
      gridOpacity: 0.05,
      glowOpacity: 0.24,
      syntax: {
        keyword: "#A3144D",
        type: "#036A96",
        string: "#846E15",
        property: "#14710A",
        number: "#644AC9",
        punctuation: "#1F1F1F",
        comment: "#635D97"
      }
    }
  },
  // Nord: Polar Night / Snow Storm surfaces, Frost accents (nord10 → nord8). Light accents and syntax are deepened Frost/Aurora tones so they read on Snow Storm.
  {
    id: "nord",
    label: "Nord",
    dark: {
      bg: "#272C36",
      panel: "#2E3440",
      panelAlt: "#353C4A",
      border: "#434C5E",
      text: "#ECEFF4",
      muted: "#A3AAB8",
      faint: "#7B88A1",
      accentA: "#5E81AC",
      accentB: "#88C0D0",
      success: "#A3BE8C",
      chipBg: "#353C4A",
      empty: "#3B4252",
      grid: "#ECEFF4",
      gridOpacity: 0.04,
      glowOpacity: 0.45,
      syntax: {
        keyword: "#81A1C1",
        type: "#8FBCBB",
        string: "#A3BE8C",
        property: "#88C0D0",
        number: "#B48EAD",
        punctuation: "#ECEFF4",
        comment: "#616E88"
      }
    },
    light: {
      bg: "#E5E9F0",
      panel: "#ECEFF4",
      panelAlt: "#E5E9F0",
      border: "#D8DEE9",
      text: "#2E3440",
      muted: "#4C566A",
      faint: "#7B88A1",
      accentA: "#5E81AC",
      accentB: "#33707F",
      success: "#5E8A4A",
      chipBg: "#E5E9F0",
      empty: "#D8DEE9",
      grid: "#2E3440",
      gridOpacity: 0.05,
      glowOpacity: 0.22,
      syntax: {
        keyword: "#5E81AC",
        type: "#3B7D7C",
        string: "#5E8A4A",
        property: "#3E7E92",
        number: "#9A6A94",
        punctuation: "#4C566A",
        comment: "#7B88A1"
      }
    }
  },
  // Catppuccin Mocha / Latte, mauve → peach (Latte: mauve → maroon, as Latte peach is too light for labels).
  {
    id: "catppuccin",
    label: "Catppuccin",
    dark: {
      bg: "#11111B",
      panel: "#1E1E2E",
      panelAlt: "#252536",
      border: "#313244",
      text: "#CDD6F4",
      muted: "#A6ADC8",
      faint: "#6C7086",
      accentA: "#CBA6F7",
      accentB: "#FAB387",
      success: "#A6E3A1",
      chipBg: "#252536",
      empty: "#313244",
      grid: "#CDD6F4",
      gridOpacity: 0.04,
      glowOpacity: 0.5,
      syntax: {
        keyword: "#CBA6F7",
        type: "#F9E2AF",
        string: "#A6E3A1",
        property: "#B4BEFE",
        number: "#FAB387",
        punctuation: "#9399B2",
        comment: "#7F849C"
      }
    },
    light: {
      bg: "#E6E9EF",
      panel: "#EFF1F5",
      panelAlt: "#E6E9EF",
      border: "#CCD0DA",
      text: "#4C4F69",
      muted: "#5C5F77",
      faint: "#86899C",
      accentA: "#8839EF",
      accentB: "#E64553",
      success: "#40A02B",
      chipBg: "#E6E9EF",
      empty: "#DCE0E8",
      grid: "#4C4F69",
      gridOpacity: 0.05,
      glowOpacity: 0.25,
      syntax: {
        keyword: "#8839EF",
        type: "#DF8E1D",
        string: "#40A02B",
        property: "#7287FD",
        number: "#FE640B",
        punctuation: "#7C7F93",
        comment: "#8C8FA1"
      }
    }
  },
  // morhetz/gruvbox dark / light. Light swaps the accent order so the contribution ramp darkens toward busier days.
  {
    id: "gruvbox",
    label: "Gruvbox",
    dark: {
      bg: "#1D2021",
      panel: "#282828",
      panelAlt: "#32302F",
      border: "#3C3836",
      text: "#EBDBB2",
      muted: "#A89984",
      faint: "#7C6F64",
      accentA: "#FE8019",
      accentB: "#FABD2F",
      success: "#B8BB26",
      chipBg: "#32302F",
      empty: "#3C3836",
      grid: "#EBDBB2",
      gridOpacity: 0.04,
      glowOpacity: 0.45,
      syntax: {
        keyword: "#FB4934",
        type: "#FABD2F",
        string: "#B8BB26",
        property: "#83A598",
        number: "#D3869B",
        punctuation: "#EBDBB2",
        comment: "#928374"
      }
    },
    light: {
      bg: "#F2E5BC",
      panel: "#FBF1C7",
      panelAlt: "#F2E5BC",
      border: "#E0D0A8",
      text: "#3C3836",
      muted: "#665C54",
      faint: "#928374",
      accentA: "#B57614",
      accentB: "#AF3A03",
      success: "#79740E",
      chipBg: "#F2E5BC",
      empty: "#EBDBB2",
      grid: "#3C3836",
      gridOpacity: 0.05,
      glowOpacity: 0.22,
      syntax: {
        keyword: "#9D0006",
        type: "#B57614",
        string: "#79740E",
        property: "#076678",
        number: "#8F3F71",
        punctuation: "#3C3836",
        comment: "#928374"
      }
    }
  },
  // Solarized base03…base3 and accents. Text uses the emphasis tones (base2 / base02) to reach 7:1; light cyan is slightly deepened.
  {
    id: "solarized",
    label: "Solarized",
    dark: {
      bg: "#00212B",
      panel: "#002B36",
      panelAlt: "#073642",
      border: "#124452",
      text: "#EEE8D5",
      muted: "#93A1A1",
      faint: "#5D757C",
      accentA: "#268BD2",
      accentB: "#2AA198",
      success: "#859900",
      chipBg: "#073642",
      empty: "#073642",
      grid: "#93A1A1",
      gridOpacity: 0.05,
      glowOpacity: 0.5,
      syntax: {
        keyword: "#859900",
        type: "#B58900",
        string: "#2AA198",
        property: "#268BD2",
        number: "#D33682",
        punctuation: "#839496",
        comment: "#586E75"
      }
    },
    light: {
      bg: "#EEE8D5",
      panel: "#FDF6E3",
      panelAlt: "#F5EFDC",
      border: "#E4DDC8",
      text: "#073642",
      muted: "#586E75",
      faint: "#809090",
      accentA: "#268BD2",
      accentB: "#22867F",
      success: "#738500",
      chipBg: "#F5EFDC",
      empty: "#EEE8D5",
      grid: "#073642",
      gridOpacity: 0.05,
      glowOpacity: 0.22,
      syntax: {
        keyword: "#859900",
        type: "#B58900",
        string: "#2AA198",
        property: "#268BD2",
        number: "#D33682",
        punctuation: "#657B83",
        comment: "#93A1A1"
      }
    }
  },
  // Rosé Pine main / Dawn. Dawn text is a deeper shade of its ink, muted borrows main's Muted and the gold string is deepened for legibility.
  {
    id: "rosepine",
    label: "Ros\xE9 Pine",
    dark: {
      bg: "#191724",
      panel: "#1F1D2E",
      panelAlt: "#26233A",
      border: "#353148",
      text: "#E0DEF4",
      muted: "#908CAA",
      faint: "#6E6A86",
      accentA: "#C4A7E7",
      accentB: "#EBBCBA",
      success: "#9CCFD8",
      chipBg: "#26233A",
      empty: "#2F2B43",
      grid: "#E0DEF4",
      gridOpacity: 0.04,
      glowOpacity: 0.5,
      syntax: {
        keyword: "#31748F",
        type: "#9CCFD8",
        string: "#F6C177",
        property: "#EBBCBA",
        number: "#EB6F92",
        punctuation: "#908CAA",
        comment: "#6E6A86"
      }
    },
    light: {
      bg: "#FAF4ED",
      panel: "#FFFAF3",
      panelAlt: "#F2E9E1",
      border: "#DFDAD9",
      text: "#464261",
      muted: "#6E6A86",
      faint: "#938EA1",
      accentA: "#907AA9",
      accentB: "#B4637A",
      success: "#286983",
      chipBg: "#F4EDE8",
      empty: "#F2E9E1",
      grid: "#575279",
      gridOpacity: 0.05,
      glowOpacity: 0.22,
      syntax: {
        keyword: "#286983",
        type: "#56949F",
        string: "#D38D2F",
        property: "#D7827E",
        number: "#B4637A",
        punctuation: "#797593",
        comment: "#9893A5"
      }
    }
  },
  // Atom One Dark / One Light. Dark text uses the brighter UI foreground; comments use One Dark Pro's accessible #7F848E.
  {
    id: "onedark",
    label: "One Dark",
    dark: {
      bg: "#21252B",
      panel: "#282C34",
      panelAlt: "#2C313A",
      border: "#3B4048",
      text: "#D7DAE0",
      muted: "#ABB2BF",
      faint: "#7F848E",
      accentA: "#61AFEF",
      accentB: "#98C379",
      success: "#98C379",
      chipBg: "#2C313A",
      empty: "#353B45",
      grid: "#ABB2BF",
      gridOpacity: 0.04,
      glowOpacity: 0.5,
      syntax: {
        keyword: "#C678DD",
        type: "#E5C07B",
        string: "#98C379",
        property: "#E06C75",
        number: "#D19A66",
        punctuation: "#ABB2BF",
        comment: "#7F848E"
      }
    },
    light: {
      bg: "#F0F0F1",
      panel: "#FAFAFA",
      panelAlt: "#F0F0F1",
      border: "#DBDBDC",
      text: "#383A42",
      muted: "#696C77",
      faint: "#8E8F96",
      accentA: "#4078F2",
      accentB: "#50A14F",
      success: "#50A14F",
      chipBg: "#F0F0F1",
      empty: "#EAEAEB",
      grid: "#383A42",
      gridOpacity: 0.05,
      glowOpacity: 0.22,
      syntax: {
        keyword: "#A626A4",
        type: "#C18401",
        string: "#50A14F",
        property: "#E45649",
        number: "#986801",
        punctuation: "#383A42",
        comment: "#A0A1A7"
      }
    }
  },
  // sainnhe/everforest medium dark / light, blue → green. Light text and accents are deepened for contrast on the cream bg0.
  {
    id: "everforest",
    label: "Everforest",
    dark: {
      bg: "#232A2E",
      panel: "#2D353B",
      panelAlt: "#343F44",
      border: "#414B50",
      text: "#D3C6AA",
      muted: "#9DA9A0",
      faint: "#7A8478",
      accentA: "#7FBBB3",
      accentB: "#A7C080",
      success: "#A7C080",
      chipBg: "#343F44",
      empty: "#3D484D",
      grid: "#D3C6AA",
      gridOpacity: 0.04,
      glowOpacity: 0.45,
      syntax: {
        keyword: "#E67E80",
        type: "#DBBC7F",
        string: "#83C092",
        property: "#7FBBB3",
        number: "#D699B6",
        punctuation: "#D3C6AA",
        comment: "#859289"
      }
    },
    light: {
      bg: "#EFEBD4",
      panel: "#FDF6E3",
      panelAlt: "#F4F0D9",
      border: "#E0DCC7",
      text: "#404A50",
      muted: "#5C6A72",
      faint: "#829181",
      accentA: "#3A94C5",
      accentB: "#2E8F6A",
      success: "#7A8C01",
      chipBg: "#F4F0D9",
      empty: "#E6E2CC",
      grid: "#5C6A72",
      gridOpacity: 0.05,
      glowOpacity: 0.22,
      syntax: {
        keyword: "#F85552",
        type: "#DFA000",
        string: "#35A77C",
        property: "#3A94C5",
        number: "#DF69BA",
        punctuation: "#5C6A72",
        comment: "#939F91"
      }
    }
  },
  // rebelot/kanagawa Wave / Lotus: crystal blue → sakura pink, with wave-blue empty cells.
  {
    id: "kanagawa",
    label: "Kanagawa",
    dark: {
      bg: "#16161D",
      panel: "#1F1F28",
      panelAlt: "#2A2A37",
      border: "#363646",
      text: "#DCD7BA",
      muted: "#A6A69C",
      faint: "#727169",
      accentA: "#7E9CD8",
      accentB: "#D27E99",
      success: "#98BB6C",
      chipBg: "#2A2A37",
      empty: "#223249",
      grid: "#DCD7BA",
      gridOpacity: 0.04,
      glowOpacity: 0.5,
      syntax: {
        keyword: "#957FB8",
        type: "#7AA89F",
        string: "#98BB6C",
        property: "#E6C384",
        number: "#D27E99",
        punctuation: "#9CABCA",
        comment: "#727169"
      }
    },
    light: {
      bg: "#E5DDB0",
      panel: "#F2ECBC",
      panelAlt: "#E9E2B5",
      border: "#D5CEA3",
      text: "#43436C",
      muted: "#545464",
      faint: "#87867D",
      accentA: "#4D699B",
      accentB: "#B35B79",
      success: "#6F894E",
      chipBg: "#E9E2B5",
      empty: "#C7D7E0",
      grid: "#43436C",
      gridOpacity: 0.05,
      glowOpacity: 0.22,
      syntax: {
        keyword: "#624C83",
        type: "#597B75",
        string: "#6F894E",
        property: "#77713F",
        number: "#B35B79",
        punctuation: "#766B90",
        comment: "#8A8980"
      }
    }
  },
  // Original: zinc neutrals with a single soft steel-blue accent.
  {
    id: "monochrome",
    label: "Monochrome",
    dark: {
      bg: "#09090B",
      panel: "#111113",
      panelAlt: "#18181B",
      border: "#27272A",
      text: "#F4F4F5",
      muted: "#A1A1AA",
      faint: "#6B6B73",
      accentA: "#6A8CC4",
      accentB: "#B4CCEE",
      success: "#8CC7A1",
      chipBg: "#18181B",
      empty: "#1E1E22",
      grid: "#FFFFFF",
      gridOpacity: 0.04,
      glowOpacity: 0.45,
      syntax: {
        keyword: "#B4CCEE",
        type: "#E4E4E7",
        string: "#B4B4BC",
        property: "#D4D4D8",
        number: "#8DA9D6",
        punctuation: "#71717A",
        comment: "#5A5A63"
      }
    },
    light: {
      bg: "#FAFAFA",
      panel: "#FFFFFF",
      panelAlt: "#F4F4F5",
      border: "#E4E4E7",
      text: "#18181B",
      muted: "#52525B",
      faint: "#8E8E96",
      accentA: "#6A8AC0",
      accentB: "#34548A",
      success: "#2F7D4F",
      chipBg: "#F4F4F5",
      empty: "#EDEDEF",
      grid: "#18181B",
      gridOpacity: 0.05,
      glowOpacity: 0.2,
      syntax: {
        keyword: "#34548A",
        type: "#18181B",
        string: "#52525B",
        property: "#3F3F46",
        number: "#5A7AB0",
        punctuation: "#8E8E96",
        comment: "#A1A1AA"
      }
    }
  },
  // Original Profilescape theme: warm coral rising into amber over plum-black / warm white.
  {
    id: "sunset",
    label: "Sunset",
    dark: {
      bg: "#120C10",
      panel: "#1A1217",
      panelAlt: "#21171D",
      border: "#33242C",
      text: "#F6ECE8",
      muted: "#BCA39F",
      faint: "#8A6F70",
      accentA: "#FF6B5B",
      accentB: "#FFB547",
      success: "#9BD47A",
      chipBg: "#21171D",
      empty: "#2A1E25",
      grid: "#F6ECE8",
      gridOpacity: 0.04,
      glowOpacity: 0.55,
      syntax: {
        keyword: "#FF7A8A",
        type: "#FFC66D",
        string: "#B5D98A",
        property: "#FFA07A",
        number: "#E9A2E0",
        punctuation: "#D8B4A6",
        comment: "#8A6F70"
      }
    },
    light: {
      bg: "#FFF7F2",
      panel: "#FFFDFB",
      panelAlt: "#FFF3EC",
      border: "#F3DED4",
      text: "#2B1A1E",
      muted: "#6F5458",
      faint: "#A68C89",
      accentA: "#E04E3C",
      accentB: "#D06E00",
      success: "#2F8A4C",
      chipBg: "#FFF1E9",
      empty: "#F7E9E2",
      grid: "#2B1A1E",
      gridOpacity: 0.05,
      glowOpacity: 0.24,
      syntax: {
        keyword: "#D6334A",
        type: "#B86400",
        string: "#4E8A2A",
        property: "#C2512B",
        number: "#A23D9A",
        punctuation: "#8C6A64",
        comment: "#A88F8C"
      }
    }
  }
];

// src/core/themes.ts
var aurora = {
  id: "aurora",
  label: "Aurora",
  dark: {
    bg: "#0B0D14",
    panel: "#11141D",
    panelAlt: "#161A26",
    border: "#232838",
    text: "#E6E8F0",
    muted: "#8B93A7",
    faint: "#5C637A",
    accentA: "#8B7CFF",
    accentB: "#3EC6E0",
    success: "#3FB950",
    chipBg: "#171B28",
    empty: "#1A1F2C",
    grid: "#FFFFFF",
    gridOpacity: 0.045,
    glowOpacity: 0.55,
    syntax: {
      keyword: "#C792EA",
      type: "#7FDBCA",
      string: "#C3E88D",
      property: "#82AAFF",
      number: "#F78C6C",
      punctuation: "#89DDFF",
      comment: "#5A6178"
    }
  },
  light: {
    bg: "#FBFBFE",
    panel: "#FFFFFF",
    panelAlt: "#F4F5FA",
    border: "#E3E6EF",
    text: "#0F172A",
    muted: "#525B70",
    faint: "#8A92A6",
    accentA: "#5B4BFF",
    accentB: "#0E9DB8",
    success: "#1A7F37",
    chipBg: "#F1F2F8",
    empty: "#EDEFF5",
    grid: "#0F172A",
    gridOpacity: 0.05,
    glowOpacity: 0.28,
    syntax: {
      keyword: "#8E44C9",
      type: "#0B8A7A",
      string: "#4E8A12",
      property: "#2F5FD0",
      number: "#C2541E",
      punctuation: "#0E7FA0",
      comment: "#8A92A6"
    }
  }
};
var THEMES = Object.fromEntries([aurora, ...PRESETS].map((t) => [t.id, t]));
var DEFAULT_THEME = "aurora";
function themeIds() {
  return Object.keys(THEMES);
}
function getTheme(id) {
  const key = (id ?? DEFAULT_THEME).trim().toLowerCase();
  return Object.hasOwn(THEMES, key) ? THEMES[key] : THEMES[DEFAULT_THEME];
}
function applyOverrides(base, ...overrides) {
  let out = { ...base, syntax: { ...base.syntax } };
  for (const o of overrides) {
    if (!o) continue;
    const { syntax, ...rest } = o;
    out = { ...out, ...rest, syntax: { ...out.syntax, ...syntax ?? {} } };
  }
  return out;
}
var RAMP_STEP = 7;
function contribRamp(p, mode) {
  const dark = mode === "dark";
  const peak = dark ? mix(p.accentB, "#FFFFFF", 0.35) : shade(p.accentB, 0.15);
  const ramp = [
    p.empty,
    mix(p.empty, p.accentA, 0.45),
    p.accentA,
    mix(p.accentA, p.accentB, 0.6),
    peak
  ];
  const toward = dark ? "#FFFFFF" : "#000000";
  const rise = (a, b) => dark ? lightness(b) - lightness(a) : lightness(a) - lightness(b);
  for (let i = 1; i < ramp.length; i++) {
    const prev = ramp[i - 1];
    const base = ramp[i];
    let c = base;
    const distinct = (x) => rise(prev, x) >= RAMP_STEP && deltaE(prev, x) >= 10;
    for (let s = 1; s <= 40 && !distinct(c); s++) c = mix(base, toward, s / 40);
    ramp[i] = c;
  }
  return ramp;
}
function otherColor(p, used) {
  const candidates = [p.faint, mix(p.faint, p.text, 0.45), mix(p.faint, p.panel, 0.45), p.muted];
  let best = p.faint;
  let bestScore = -1;
  for (const c of candidates) {
    if (contrast(c, p.panel) < 1.3) continue;
    const score = Math.min(Number.POSITIVE_INFINITY, ...used.map((u) => deltaE(c, u)));
    if (score >= 12) return c;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

// src/core/options.ts
function own(table, key) {
  return Object.hasOwn(table, key) ? table[key] : void 0;
}
function readOptions(options) {
  const src = options ?? {};
  const get = (key) => Object.hasOwn(src, key) ? src[key] : void 0;
  return {
    has: (key) => get(key) !== void 0 && get(key) !== null,
    raw: get,
    string(key, fallback) {
      const v = get(key);
      return typeof v === "string" && v.trim() !== "" ? v : typeof v === "number" ? String(v) : fallback;
    },
    optionalString(key) {
      const v = get(key);
      return typeof v === "string" && v.trim() !== "" ? v : void 0;
    },
    number(key, fallback, range = {}) {
      const v = get(key);
      const num = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
      if (!Number.isFinite(num)) return fallback;
      return Math.min(range.max ?? Number.POSITIVE_INFINITY, Math.max(range.min ?? Number.NEGATIVE_INFINITY, num));
    },
    boolean(key, fallback) {
      const v = get(key);
      if (typeof v === "boolean") return v;
      if (typeof v === "string") return ["true", "yes", "1", "on"].includes(v.trim().toLowerCase());
      return fallback;
    },
    /** Accepts an array or a comma/newline separated string. */
    list(key, fallback) {
      const v = get(key);
      if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
      if (typeof v === "string") return v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      return fallback;
    },
    oneOf(key, allowed, fallback) {
      const v = get(key);
      return typeof v === "string" && allowed.includes(v) ? v : fallback;
    }
  };
}

// src/cards/languages.ts
var MIN_CONTRAST = 1.8;
var validStats = (list) => (Array.isArray(list) ? list : []).filter(
  (l) => !!l && typeof l.name === "string" && l.name.trim() !== "" && typeof l.value === "number" && Number.isFinite(l.value) && l.value > 0
);
function percentLabels(values) {
  const total = values.reduce((s, v) => s + v, 0);
  if (total <= 0) return values.map(() => "0%");
  const raw = values.map((v) => v / total * 1e3);
  const tenths = raw.map(Math.floor);
  let left = 1e3 - tenths.reduce((s, v) => s + v, 0);
  const order = raw.map((r, i) => ({ i, rem: r - Math.floor(r) })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    tenths[i] = (tenths[i] ?? 0) + 1;
    left--;
  }
  return tenths.map((t, i) => t === 0 && (values[i] ?? 0) > 0 ? "<0.1%" : `${(t / 10).toFixed(1)}%`);
}
function prepareLanguages(list, opts, p) {
  const hidden = new Set(opts.hide.map((h) => h.trim().toLowerCase()));
  const source = validStats(list);
  const merged = /* @__PURE__ */ new Map();
  for (const l of source) {
    const name = l.name.trim();
    const key = name.toLowerCase();
    if (hidden.has(key)) continue;
    const cur = merged.get(key);
    if (cur) cur.value += l.value;
    else merged.set(key, { name, color: ensureContrast(safeColor(l.color, p.muted), p.panel, MIN_CONTRAST, p.text), value: l.value });
  }
  const visible = [...merged.values()].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  const top = Math.max(1, Math.min(10, Math.round(opts.top)));
  const kept = visible.length > top + 1 ? visible.slice(0, top) : visible;
  const rest = visible.slice(kept.length).reduce((s, l) => s + l.value, 0);
  const items2 = kept.map((l) => ({ ...l, other: false }));
  if (rest > 0) {
    const existing = items2.find((l) => l.name.toLowerCase() === "other");
    if (existing) existing.value += rest;
    else items2.push({ name: "Other", color: otherColor(p, items2.map((l) => l.color)), value: rest, other: true });
  }
  const total = items2.reduce((s, l) => s + l.value, 0);
  const pcts = percentLabels(items2.map((l) => l.value));
  return {
    slices: items2.map((l, i) => ({ ...l, share: total > 0 ? l.value / total : 0, pct: pcts[i] ?? "0%" })),
    count: visible.length,
    allHidden: visible.length === 0 && source.length > 0
  };
}
function pickSource(data, wanted) {
  const commits = validStats(data.languages);
  const bytes = validStats(data.languagesByBytes);
  if (wanted === "commits" && !commits.length && bytes.length) return { weighting: "bytes", list: bytes };
  if (wanted === "bytes" && !bytes.length && commits.length) return { weighting: "commits", list: commits };
  return { weighting: wanted, list: wanted === "commits" ? commits : bytes };
}
function legendName(name, maxWidth, size) {
  const opts = { weight: 600 };
  if (textWidth(name, size, opts) <= maxWidth) return name;
  return fit(displayName(name), maxWidth, size, opts);
}
var STYLE = ".lg-seg{transform-box:fill-box;transform-origin:0 50%;animation:lg-grow .8s cubic-bezier(.2,.7,.2,1) backwards}@keyframes lg-grow{from{transform:scaleX(0)}}";
function header(h, x, y, width, p) {
  const infoW = h.info ? labelWidth(h.info) : 0;
  const room = width - infoW - 32;
  const showInfo = h.info && room >= Math.min(220, labelWidth(h.title));
  const title = fitLabel(h.title, showInfo ? room : width);
  return label(x, y, title, p) + (showInfo ? label(x + width, y, h.info, p, { anchor: "end", color: p.muted }) : "");
}
function stackedBar(slices, x, y, width, height, p, id) {
  const r = height / 2;
  const defs = `<clipPath id="${id}"><rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${height}" rx="${n(r)}"/></clipPath>`;
  const gap = slices.length > 1 ? 3 : 0;
  let cx = x;
  const segs = slices.map((s, i) => {
    const w = s.share * width;
    const last = i === slices.length - 1;
    const seg = `<rect class="lg-seg" ${delay(0.1 + i * 0.08)} x="${n(cx, 2)}" y="${n(y)}" width="${n(Math.max(1.5, last ? w : w - gap), 2)}" height="${height}" fill="${s.color}"/>`;
    cx += w;
    return seg;
  });
  const svg = `<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${height}" rx="${n(r)}" fill="${p.empty}"/><g clip-path="url(#${id})">${segs.join("")}</g>`;
  return { svg, defs };
}
function emptyMessage(prepared) {
  return prepared.allHidden ? { title: "All languages are hidden", sub: "Remove some names from the hide option to bring them back." } : { title: "No language data yet", sub: "Your languages will appear here once your repositories have code." };
}
function barLayout({ prepared, head, p }) {
  const W5 = 1200;
  const PAD5 = 40;
  const parts2 = [];
  if (head) parts2.push(header(head, PAD5, 56, W5 - PAD5 * 2, p));
  const barY = head ? 80 : PAD5;
  const { slices } = prepared;
  const bar = stackedBar(slices, PAD5, barY, W5 - PAD5 * 2, 16, p, "lg-bar");
  parts2.push(bar.svg);
  if (!slices.length) {
    const msg = emptyMessage(prepared);
    parts2.push(
      `<g class="fade" ${delay(0.2)}><text x="${PAD5}" y="${barY + 58}" class="sans" font-size="16" font-weight="600" fill="${p.text}">${esc(msg.title)}</text><text x="${PAD5}" y="${barY + 80}" class="sans" font-size="13" fill="${p.muted}">${esc(msg.sub)}</text></g>`
    );
    return { width: W5, height: barY + 80 + PAD5, body: parts2.join(""), defs: bar.defs };
  }
  const cols = 4;
  const colW = (W5 - PAD5 * 2) / cols;
  const first = barY + 16 + 42;
  const pitch = 34;
  slices.forEach((s, i) => {
    const lx = PAD5 + i % cols * colW;
    const ly = first + Math.floor(i / cols) * pitch;
    const pctW = textWidth(s.pct, 13, { mono: true });
    const name = legendName(s.name, colW - 20 - 8 - pctW - 20, 15);
    parts2.push(
      `<g class="fade" ${delay(0.35 + i * 0.05)}><circle cx="${n(lx + 6)}" cy="${n(ly - 5)}" r="6" fill="${s.color}"/><text x="${n(lx + 20)}" y="${n(ly)}"><tspan class="sans" font-size="15" font-weight="600" fill="${s.other ? p.muted : p.text}">${esc(name)}</tspan><tspan dx="8" class="mono" font-size="13" fill="${p.muted}">${esc(s.pct)}</tspan></text></g>`
    );
  });
  const rows = Math.ceil(slices.length / cols);
  return { width: W5, height: first + (rows - 1) * pitch + 36, body: parts2.join(""), defs: bar.defs };
}
function donutLayout({ prepared, head, p }) {
  const W5 = 1200;
  const PAD5 = 40;
  const R = 96;
  const T = 24;
  const r = R - T / 2;
  const C = 2 * Math.PI * r;
  const parts2 = [];
  const top = head ? 84 : PAD5;
  const cx = PAD5 + R + 16;
  const cy = top + R;
  const H3 = cy + R + PAD5;
  if (head) parts2.push(header(head, PAD5, 56, W5 - PAD5 * 2, p));
  const { slices } = prepared;
  parts2.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="none" stroke="${p.empty}" stroke-width="${T}"/>`);
  const gap = slices.length > 1 ? 3 : 0;
  let start = 0;
  const sweep = 0.9;
  const style = `.lg-arc{animation:lg-sweep .5s linear backwards}@keyframes lg-sweep{from{stroke-dasharray:0 ${n(C, 2)}}}`;
  for (const s of slices) {
    const len = Math.max(1, s.share * C - gap);
    const timing = `style="animation-delay:${n(0.15 + start * sweep, 3)}s;animation-duration:${n(Math.max(0.12, s.share * sweep), 3)}s"`;
    parts2.push(
      `<circle class="lg-arc" ${timing} cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="none" stroke="${s.color}" stroke-width="${T}" stroke-dasharray="${n(len, 2)} ${n(C, 2)}" transform="rotate(${n(-90 + start * 360, 2)} ${n(cx)} ${n(cy)})"/>`
    );
    start += s.share;
  }
  const lead = slices[0];
  const innerW = (R - T) * 2 - 44;
  if (lead) {
    const size = lead.pct.length > 5 ? 28 : 32;
    parts2.push(
      `<g class="fade" ${delay(0.5)}><text x="${n(cx)}" y="${n(cy + 6)}" text-anchor="middle" class="sans" font-size="${size}" font-weight="800" letter-spacing="-1" fill="${p.text}">${esc(lead.pct)}</text><text x="${n(cx)}" y="${n(cy + 28)}" text-anchor="middle" class="sans" font-size="13" fill="${p.muted}">${esc(fit(lead.name, innerW, 13))}</text></g>`
    );
  } else {
    parts2.push(`<text x="${n(cx)}" y="${n(cy + 7)}" text-anchor="middle" class="mono" font-size="20" fill="${p.faint}">${esc("</>")}</text>`);
  }
  const lx0 = cx + R + 72;
  const areaW = W5 - PAD5 - lx0;
  if (!slices.length) {
    const msg = emptyMessage(prepared);
    parts2.push(
      `<g class="fade" ${delay(0.2)}><text x="${n(lx0)}" y="${n(cy - 4)}" class="sans" font-size="16" font-weight="600" fill="${p.text}">${esc(msg.title)}</text><text x="${n(lx0)}" y="${n(cy + 18)}" class="sans" font-size="13" fill="${p.muted}">${esc(msg.sub)}</text></g>`
    );
    return { width: W5, height: H3, body: parts2.join(""), defs: "", style };
  }
  const cols = slices.length > 6 ? 2 : 1;
  const colGap = 56;
  const colW = (areaW - (cols - 1) * colGap) / cols;
  const rows = Math.ceil(slices.length / cols);
  const pitch = Math.min(38, (R * 2 + 8) / Math.max(1, rows));
  const firstY = cy - (rows - 1) * pitch / 2 + 5;
  const pctW = 64;
  const longest = Math.max(0, ...slices.map((s) => textWidth(s.name, 15, { weight: 600 })));
  const nameW = Math.min(colW - pctW - 16 - 96, Math.max(cols === 1 ? 200 : 150, Math.ceil(longest) + 42));
  const trackW = colW - nameW - pctW - 16;
  slices.forEach((s, i) => {
    const col = Math.floor(i / rows);
    const row = i % rows;
    const x = lx0 + col * (colW + colGap);
    const y = firstY + row * pitch;
    const tx = x + nameW;
    const w = Math.max(3, s.share * trackW);
    parts2.push(
      `<g class="fade" ${delay(0.3 + i * 0.05)}><circle cx="${n(x + 5)}" cy="${n(y - 5)}" r="5" fill="${s.color}"/><text x="${n(x + 18)}" y="${n(y)}" class="sans" font-size="15" font-weight="600" fill="${s.other ? p.muted : p.text}">${esc(legendName(s.name, nameW - 30, 15))}</text><rect x="${n(tx)}" y="${n(y - 9)}" width="${n(trackW)}" height="8" rx="4" fill="${p.empty}"/><text x="${n(x + colW)}" y="${n(y)}" text-anchor="end" class="mono" font-size="13" fill="${p.muted}">${esc(s.pct)}</text></g><rect class="lg-seg" ${delay(0.35 + i * 0.06)} x="${n(tx)}" y="${n(y - 9)}" width="${n(w)}" height="8" rx="4" fill="${s.color}"/>`
    );
  });
  return { width: W5, height: H3, body: parts2.join(""), defs: "", style };
}
function compactLayout({ prepared, head, p }) {
  const W5 = 400;
  const PAD5 = 24;
  const parts2 = [];
  if (head) parts2.push(label(PAD5, 40, fitLabel(head.title, W5 - PAD5 * 2), p));
  const barY = head ? 56 : PAD5;
  const { slices } = prepared;
  const bar = stackedBar(slices, PAD5, barY, W5 - PAD5 * 2, 10, p, "lg-bar");
  parts2.push(bar.svg);
  if (!slices.length) {
    const msg = emptyMessage(prepared);
    const lines = wrapPx(msg.sub, 300, 12.5, {}, 2);
    parts2.push(
      `<g class="fade" ${delay(0.2)}><text x="${PAD5}" y="${barY + 44}" class="sans" font-size="15" font-weight="600" fill="${p.text}">${esc(msg.title)}</text>` + lines.map((l, i) => `<text x="${PAD5}" y="${barY + 66 + i * 18}" class="sans" font-size="12.5" fill="${p.muted}">${esc(l)}</text>`).join("") + "</g>"
    );
    return { width: W5, height: barY + 66 + (lines.length - 1) * 18 + PAD5, body: parts2.join(""), defs: bar.defs };
  }
  const cols = 2;
  const colW = (W5 - PAD5 * 2) / cols;
  const first = barY + 10 + 32;
  const pitch = 27;
  slices.forEach((s, i) => {
    const lx = PAD5 + i % cols * colW;
    const ly = first + Math.floor(i / cols) * pitch;
    const pctW = textWidth(s.pct, 12, { mono: true });
    const name = legendName(s.name, colW - 16 - 6 - pctW - 12, 13.5);
    parts2.push(
      `<g class="fade" ${delay(0.3 + i * 0.05)}><circle cx="${n(lx + 5)}" cy="${n(ly - 4.5)}" r="5" fill="${s.color}"/><text x="${n(lx + 16)}" y="${n(ly)}"><tspan class="sans" font-size="13.5" font-weight="600" fill="${s.other ? p.muted : p.text}">${esc(name)}</tspan><tspan dx="6" class="mono" font-size="12" fill="${p.muted}">${esc(s.pct)}</tspan></text></g>`
    );
  });
  const rows = Math.ceil(slices.length / cols);
  return { width: W5, height: first + (rows - 1) * pitch + 22, body: parts2.join(""), defs: bar.defs };
}
var WEIGHT_LABEL = {
  commits: { title: "Languages \xB7 weighted by commits", short: "by commits" },
  bytes: { title: "Languages \xB7 by code size", short: "by code size" }
};
function render(ctx) {
  const p = ctx.palette;
  const o = readOptions(ctx.options);
  const layout2 = o.oneOf("layout", ["bar", "donut", "compact"], "bar");
  const { weighting, list } = pickSource(ctx.data, o.oneOf("weighting", ["commits", "bytes"], "commits"));
  const prepared = prepareLanguages(list, { hide: o.list("hide", []), top: o.number("top", 6, { min: 1, max: 10 }) }, p);
  const customTitle = o.optionalString("title");
  const showTitle = !o.boolean("hideTitle", false);
  const scope = weighting === "commits" ? "last 12 months" : ctx.data.repos?.length ? `${ctx.data.repos.length} ${plural(ctx.data.repos.length, "repository", "repositories")}` : "";
  const info = [
    customTitle ? WEIGHT_LABEL[weighting].short : "",
    prepared.count ? `${prepared.count} ${plural(prepared.count, "language")}` : "",
    prepared.count ? scope : ""
  ].filter(Boolean).join(" \xB7 ");
  const head = showTitle ? { title: customTitle ?? WEIGHT_LABEL[weighting].title, info } : null;
  const args = { prepared, head, p };
  const drawn = layout2 === "donut" ? donutLayout(args) : layout2 === "compact" ? compactLayout(args) : barLayout(args);
  const summary = prepared.slices.length ? prepared.slices.map((s) => `${s.name} ${s.pct}`).join(", ") : emptyMessage(prepared).title;
  const what = `Most used languages (${WEIGHT_LABEL[weighting].short})`;
  const svg = shell({
    width: drawn.width,
    height: drawn.height,
    palette: p,
    title: what,
    desc: summary,
    defs: drawn.defs,
    style: STYLE + (drawn.style ?? ""),
    body: drawn.body,
    radius: layout2 === "compact" ? 16 : 20,
    glow: layout2 === "compact" ? null : { cx: 0, cy: 0, r: 0.9, color: p.accentA, opacity: p.glowOpacity * 0.18 },
    animate: ctx.animate
  });
  return [{ name: "languages", alt: `${what}: ${summary}`, svg, layout: layout2 === "compact" ? "half" : "full" }];
}
var card = {
  id: "languages",
  title: "Languages",
  description: "Your most used languages in their real GitHub colours, weighted by your commits or by code size, as a stacked bar, a donut or a compact half-width card.",
  options: [
    {
      key: "weighting",
      type: "string",
      default: "commits",
      description: `"commits" weights each repo's languages by your commits in the last 12 months; "bytes" uses raw code size.`
    },
    { key: "layout", type: "string", default: "bar", description: '"bar" (stacked bar + legend), "donut" (donut + legend with bars) or "compact" (half-width card).' },
    { key: "top", type: "number", default: 6, description: 'Languages to show (1 to 10); the rest fold into "Other".' },
    { key: "hide", type: "list", default: [], description: 'Language names to leave out (case-insensitive), e.g. ["Jupyter Notebook", "HTML"].' },
    { key: "title", type: "string", description: "Header label text. Defaults to a label that states the weighting." },
    { key: "hideTitle", type: "boolean", default: false, description: "Hide the header row and tighten the layout." }
  ],
  render
};

// src/cards/landscape.ts
var W = 1200;
var PAD = 40;
var GAP = 0.1;
var RIM = 0.55;
var SLAB = 10;
var MIN_H = 3;
var CLEARANCE = 24;
var COL_W = 200;
var INS_X = W - PAD - 2 * COL_W;
var ROW_H = 84;
var TOP = 56;
var SCALES = ["sqrt", "linear", "log"];
var SCALE_NOTE = {
  sqrt: "height \u221D \u221Acontributions",
  linear: "height \u221D contributions",
  log: "height \u221D log contributions"
};
var OPTIONS = [
  { key: "title", type: "string", default: "Contribution landscape", description: "Header label, shown in small caps above the total." },
  { key: "hideTitle", type: "boolean", default: false, description: "Hide the header (label and total) for a cleaner embed." },
  { key: "insights", type: "boolean", default: true, description: "Show best day, busiest month, favourite weekday and active days." },
  { key: "peak", type: "boolean", default: true, description: "Pin a small callout on the tallest bar (your best day)." },
  { key: "scale", type: "string", default: "sqrt", description: 'Bar height scale: "sqrt" (keeps quiet days visible next to outliers), "linear" or "log".' },
  { key: "weeks", type: "number", default: 53, description: "Number of weeks to show, 26 to 53. Fewer weeks means bigger bars." },
  { key: "height", type: "number", default: 124, description: "Height of the tallest bar in px, 40 to 240." }
];
var fmt = (v) => Math.round(v).toLocaleString("en-US");
function share(part, whole) {
  const pct = whole > 0 ? part / whole * 100 : 0;
  return part > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}
var sanitize = (raw) => raw.map((c) => ({ ...c, count: Number.isFinite(c.count) && c.count > 0 ? Math.round(c.count) : 0 }));
function summarize(cells) {
  let total = 0;
  let active = 0;
  let best = null;
  const byDay = [0, 0, 0, 0, 0, 0, 0];
  const byMonth = /* @__PURE__ */ new Map();
  for (const c of cells) {
    total += c.count;
    if (c.count > 0) active++;
    if (c.count > 0 && (!best || c.count > best.count)) best = c;
    byDay[c.day] = (byDay[c.day] ?? 0) + c.count;
    const key = c.date.slice(0, 7);
    byMonth.set(key, (byMonth.get(key) ?? 0) + c.count);
  }
  const weekday = { day: 0, total: -1 };
  byDay.forEach((t, day) => {
    if (t > weekday.total) Object.assign(weekday, { day, total: t });
  });
  const month = { key: "", total: -1 };
  for (const [key, t] of byMonth) if (t > month.total) Object.assign(month, { key, total: t });
  return { days: cells.length, total, peak: best?.count ?? 0, best, active, weekday, month };
}
function heightFn(scale, peak, maxH) {
  if (peak <= 0) return () => 0;
  const shape = scale === "linear" ? (c) => c / peak : scale === "log" ? (c) => Math.log1p(c) / Math.log1p(peak) : (c) => Math.sqrt(c / peak);
  return (c) => c > 0 ? MIN_H + (maxH - MIN_H) * Math.min(1, shape(c)) : 0;
}
var overlaps = (a, b, m = 0) => a.x0 < b.x1 + m && a.x1 > b.x0 - m && a.y0 < b.y1 + m && a.y1 > b.y0 - m;
function levelColours(p, dark) {
  const ramp = contribRamp(p, dark ? "dark" : "light");
  return ramp.map((top) => {
    const front = shade(top, dark ? 0.2 : 0.1);
    const right = shade(top, dark ? 0.38 : 0.22);
    return {
      top,
      front,
      frontLow: shade(front, dark ? 0.22 : 0.08),
      right,
      rightLow: shade(right, dark ? 0.24 : 0.08),
      rim: tint(top, dark ? 0.3 : 0.45)
    };
  });
}
function renderLandscape(ctx) {
  const p = ctx.palette;
  const dark = ctx.mode === "dark";
  const o = readOptions(ctx.options);
  const weeks = Math.round(o.number("weeks", 53, { min: 26, max: 53 }));
  const maxH = Math.round(o.number("height", 124, { min: 40, max: 240 }));
  const scaleRaw = o.string("scale", "sqrt").trim().toLowerCase();
  const scale = SCALES.includes(scaleRaw) ? scaleRaw : "sqrt";
  const showInsights = o.boolean("insights", true);
  const showPeak = o.boolean("peak", true);
  const hideTitle = o.boolean("hideTitle", false);
  const spanPhrase = weeks >= 52 ? "in the last year" : `in the last ${weeks} weeks`;
  const titleText2 = o.string("title", "Contribution landscape");
  const cells = sanitize(yearWindow(ctx.data.calendar, ctx.now, weeks));
  const fullYear = weeks >= 52;
  const counted = fullYear ? sanitize(lastYear(ctx.data.calendar, ctx.now).map((d) => ({ ...d, week: 0, day: parseDate(d.date).getUTCDay() }))) : cells;
  const sum = summarize(counted);
  const total = fullYear ? yearTotal(ctx.data, ctx.now) : sum.total;
  const { peak, best } = sum;
  const peakAll = Math.max(0, ...cells.map((c) => c.count));
  const empty = peakAll === 0;
  const height = heightFn(scale, peakAll, maxH);
  const level = levelScale(cells.map((c) => c.count));
  const colours = levelColours(p, dark);
  const s = Math.min(1.4, 964 / (weeks * 17 + 63));
  const wx = 17 * s;
  const wy = 5.5 * s;
  const dx = -9 * s;
  const dy = 8 * s;
  const px = (w, d) => w * wx + d * dx;
  const py = (w, d) => w * wy + d * dy;
  const dayLabelGap = 12;
  const leftExtent = px(-RIM, 7 + RIM);
  const rightExtent = Math.max(px(weeks + RIM, -RIM), px(weeks + RIM, 1.5) + dayLabelGap + textWidth("Mon", 11, { mono: true }));
  const ox = (W - (rightExtent - leftExtent)) / 2 - leftExtent;
  const reserved = [];
  const headlineValue = fmt(total);
  const headlineRest = `${plural(total, "contribution")} ${spanPhrase}`;
  const headlineW = textWidth(headlineValue, 36, { weight: 800 }) + 12 + textWidth(headlineRest, 16);
  const labelText = fitLabel(titleText2, INS_X - PAD - 40);
  if (!hideTitle) {
    reserved.push({ x0: PAD, y0: PAD - 8, x1: PAD + Math.max(headlineW, labelWidth(labelText)), y1: TOP + 54 });
  }
  const insightsBlock = !empty && showInsights;
  const emptyBlock = empty;
  if (insightsBlock) reserved.push({ x0: INS_X, y0: PAD - 8, x1: W - PAD, y1: TOP + ROW_H + 52 });
  if (emptyBlock) reserved.push({ x0: INS_X, y0: PAD - 8, x1: W - PAD, y1: TOP + 92 });
  const roomH = empty ? Math.min(maxH, 56) : maxH;
  let oy = PAD + roomH + 6;
  for (const r of reserved) {
    for (let w = 0; w < weeks; w++) {
      for (let d = 0; d < 7; d++) {
        const x0 = ox + px(w + GAP, d + 1 - GAP);
        const x1 = ox + px(w + 1 - GAP, d + GAP);
        if (x1 < r.x0 - 12 || x0 > r.x1 + 12) continue;
        oy = Math.max(oy, r.y1 + CLEARANCE - (py(w + GAP, d + GAP) - roomH));
      }
    }
  }
  oy = Math.round(oy);
  const P = (w, d, h = 0) => [ox + px(w, d), oy + py(w, d) - h];
  const pt = (w, d, h = 0) => {
    const [x, y] = P(w, d, h);
    return `${n(x)} ${n(y)}`;
  };
  const minGap = Math.ceil((textWidth("Mmm", 11, { mono: true }) + 8) / wx);
  const monthLabels2 = monthStarts(cells, weeks, minGap).map((m) => {
    const [x, y] = P(m.week + 0.5, 7 + RIM);
    return { x, y: y + SLAB + 18, text: MONTHS[m.month] ?? "" };
  });
  const slabBottom = P(weeks + RIM, 7 + RIM)[1] + SLAB;
  let H3 = slabBottom + 40;
  for (const m of monthLabels2) H3 = Math.max(H3, m.y + 26);
  const legend2 = legendParts(empty, peakAll, scale);
  const legendRight = PAD + legend2.width;
  const frontAt = (x) => {
    const w = Math.max(-RIM, Math.min(weeks + RIM, (x - ox - px(0, 7 + RIM)) / wx));
    return P(w, 7 + RIM)[1] + SLAB + 22;
  };
  H3 = Math.max(H3, frontAt(legendRight) + 20 + 34);
  H3 = Math.round(H3);
  const legendY = H3 - 34;
  const grads = colours.slice(1).map(
    (c, i) => linearGradient(`ps3d-f${i + 1}`, c.front, c.frontLow, true) + linearGradient(`ps3d-r${i + 1}`, c.right, c.rightLow, true)
  ).join("");
  const defs = grads + linearGradient("ps3d-accent", p.accentA, p.accentB) + `<filter id="ps3d-blur" x="-15%" y="-40%" width="130%" height="180%"><feGaussianBlur stdDeviation="14"/></filter>`;
  const levelCss = colours.slice(1).map(
    (c, i) => `.t${i + 1}{fill:${c.top};stroke:${c.rim}}.f${i + 1}{fill:url(#ps3d-f${i + 1})}.r${i + 1}{fill:url(#ps3d-r${i + 1})}`
  ).join("");
  const stagger = 1.05 / weeks;
  const style = `.t1,.t2,.t3,.t4{stroke-width:.6;stroke-linejoin:round}${levelCss}.wk{animation:ps3d-rise .9s cubic-bezier(.2,.7,.2,1) backwards}@keyframes ps3d-rise{from{opacity:0;transform:translateY(28px)}}.pin{animation:ps3d-drop .7s cubic-bezier(.2,.7,.2,1) backwards}@keyframes ps3d-drop{from{opacity:0;transform:translateY(-8px)}}`;
  const slabTop = mix(p.panel, p.empty, 0.45);
  const slabFront = dark ? mix(p.panel, p.border, 0.75) : shade(p.empty, 0.07);
  const slabRight = dark ? mix(p.panel, p.border, 0.4) : shade(p.empty, 0.14);
  const a0 = pt(-RIM, -RIM);
  const b0 = pt(weeks + RIM, -RIM);
  const c0 = pt(weeks + RIM, 7 + RIM);
  const e0 = pt(-RIM, 7 + RIM);
  const shadowDrop = SLAB + 12;
  const shadow = `<path d="M${pt(-RIM, -RIM, -shadowDrop)}L${pt(weeks + RIM, -RIM, -shadowDrop)}L${pt(weeks + RIM, 7 + RIM, -shadowDrop)}L${pt(-RIM, 7 + RIM, -shadowDrop)}Z" fill="${dark ? shade(p.bg, 0.6) : p.text}" opacity="${dark ? 0.7 : 0.13}" filter="url(#ps3d-blur)"/>`;
  const slab = `<path d="M${e0}L${c0}l0 ${SLAB}L${pt(-RIM, 7 + RIM, -SLAB)}Z" fill="${slabFront}"/><path d="M${c0}L${b0}l0 ${SLAB}L${pt(weeks + RIM, 7 + RIM, -SLAB)}Z" fill="${slabRight}"/><path d="M${a0}L${b0}L${c0}L${e0}Z" fill="${slabTop}" stroke="${dark ? mix(p.border, p.panel, 0.2) : p.border}" stroke-linejoin="round"/>`;
  const k = 1 - 2 * GAP;
  const rel = (...v) => v.map((x) => n(x)).join(" ").replace(/ -/g, "-");
  const topLoop = `l${rel(wx * k, wy * k, dx * k, dy * k, -wx * k, -wy * k)}z`;
  const tiles2 = cells.filter((c) => c.count === 0).map((c) => `M${pt(c.week + GAP, c.day + GAP)}${topLoop}`).join("");
  const floor = tiles2 ? `<path d="${tiles2}" fill="${colours[0]?.top ?? p.empty}"/>` : "";
  const byWeek = /* @__PURE__ */ new Map();
  let peakBar = null;
  const weekHeights = new Array(weeks).fill(0);
  for (const c of cells) {
    if (c.count <= 0) continue;
    const h = height(c.count);
    const lv = Math.max(1, level(c.count));
    const w = c.week;
    const d = c.day;
    weekHeights[w] = (weekHeights[w] ?? 0) + h;
    if (best && c.date === best.date) peakBar = { w, d, h };
    const hs = n(h);
    const front = `M${pt(w + GAP, d + 1 - GAP)}l${rel(wx * k, wy * k)}v-${hs}l${rel(-wx * k, -wy * k)}z`;
    const right = `M${pt(w + 1 - GAP, d + 1 - GAP)}l${rel(-dx * k, -dy * k)}v-${hs}l${rel(dx * k, dy * k)}z`;
    const top = `M${pt(w + GAP, d + GAP, h)}${topLoop}`;
    const parts2 = byWeek.get(w) ?? [];
    parts2.push(`<path class="f${lv}" d="${front}"/><path class="r${lv}" d="${right}"/><path class="t${lv}" d="${top}"/>`);
    byWeek.set(w, parts2);
  }
  const bars = [...byWeek.entries()].sort((x, y) => x[0] - y[0]).map(([w, parts2]) => `<g class="wk" style="animation-delay:${n(0.15 + w * stagger, 3)}s">${parts2.join("")}</g>`).join("");
  let glowW = weeks / 2;
  if (!empty) {
    let bestSum = -1;
    for (let w = 0; w + 7 <= weeks; w++) {
      let t = 0;
      for (let i = w; i < w + 7; i++) t += weekHeights[i] ?? 0;
      if (t > bestSum) {
        bestSum = t;
        glowW = w + 3.5;
      }
    }
  }
  const [gx, gy] = P(glowW, 3.5, empty ? 0 : maxH * 0.45);
  const axis = [1, 3, 5].map((d) => {
    const [x, y] = P(weeks + RIM, d + 0.5);
    return `<text x="${n(x + dayLabelGap)}" y="${n(y + 4)}" class="mono" font-size="11" fill="${p.muted}">${(WEEKDAYS[d] ?? "").slice(0, 3)}</text>`;
  }).join("") + monthLabels2.map((m) => `<text x="${n(m.x)}" y="${n(m.y)}" text-anchor="middle" class="mono" font-size="11" fill="${p.muted}">${m.text}</text>`).join("");
  let pin = "";
  if (showPeak && peakBar && best) {
    const [cx, cy] = P(peakBar.w + 0.5, peakBar.d + 0.5, peakBar.h);
    const value = fmt(best.count);
    const when = shortDate(best.date).replace(/, \d{4}$/, "");
    const pw = Math.round(textWidth(value, 12.5, { weight: 700 }) + 7 + textWidth(when, 12) + 24);
    const ph = 26;
    const shift = pw / 2 - 16;
    const candidates = [];
    for (const lift of [34, 52, 70, 88]) {
      for (const off of [0, -shift, shift]) {
        candidates.push({ x0: cx + off - pw / 2, y0: cy - lift - ph, x1: cx + off + pw / 2, y1: cy - lift });
      }
    }
    for (const side2 of [-1, 1]) {
      for (const lift of [18, 0, 40]) {
        const x0 = side2 < 0 ? cx - 22 - pw : cx + 22;
        candidates.push({ x0, y0: cy - lift - ph / 2, x1: x0 + pw, y1: cy - lift + ph / 2 });
      }
    }
    const fits = (r2) => r2.x0 >= PAD / 2 && r2.x1 <= W - PAD / 2 && r2.y0 >= PAD / 2 && r2.y1 <= H3 - 70 && !reserved.some((q) => overlaps(r2, q, 10));
    const r = candidates.find(fits);
    if (r) {
      const lx = Math.max(r.x0 + ph / 2, Math.min(r.x1 - ph / 2, cx));
      const ly = Math.max(r.y0, Math.min(r.y1, cy));
      const tx = cx < r.x0 ? r.x0 : cx > r.x1 ? r.x1 : lx;
      const ty = cy > r.y1 ? r.y1 : cy < r.y0 ? r.y0 : ly;
      pin = `<g class="pin" style="animation-delay:${n(0.15 + 1.05 + 0.25, 3)}s"><line x1="${n(cx)}" y1="${n(cy)}" x2="${n(tx)}" y2="${n(ty)}" stroke="${p.text}" stroke-opacity=".55" stroke-dasharray="2 3"/><circle cx="${n(cx)}" cy="${n(cy)}" r="2.8" fill="${p.text}"/><rect x="${n(r.x0)}" y="${n(r.y0)}" width="${pw}" height="${ph}" rx="${ph / 2}" fill="${p.panel}" fill-opacity=".94" stroke="${p.border}"/><text x="${n(r.x0 + 12)}" y="${n(r.y0 + 17.5)}" class="sans" font-size="12.5" font-weight="700" fill="${p.text}">${esc(value)}<tspan dx="7" font-size="12" font-weight="400" fill="${p.muted}">${esc(when)}</tspan></text></g>`;
    }
  }
  const header2 = hideTitle ? "" : `<g class="fade">${label(PAD, TOP, labelText, p)}<text x="${PAD}" y="${TOP + 46}" class="sans"><tspan font-size="36" font-weight="800" letter-spacing="-1" fill="url(#ps3d-accent)">${esc(headlineValue)}</tspan><tspan dx="12" font-size="16" fill="${p.muted}">${esc(headlineRest)}</tspan></text></g>`;
  let side = "";
  if (insightsBlock && best) {
    const items2 = [
      ["Best day", fmt(best.count), shortDate(best.date)],
      ["Busiest month", monthYear(`${sum.month.key}-01`), `${fmt(sum.month.total)} ${plural(sum.month.total, "contribution")}`],
      ["Favourite weekday", WEEKDAYS[sum.weekday.day] ?? "Sunday", `${fmt(sum.weekday.total)} ${plural(sum.weekday.total, "contribution")}`],
      ["Active days", fmt(sum.active), `of ${fmt(sum.days)} \xB7 ${share(sum.active, sum.days)}`]
    ];
    side = items2.map(([name, value, sub], i) => {
      const x = INS_X + i % 2 * COL_W;
      const y = TOP + Math.floor(i / 2) * ROW_H;
      return `<g class="fade" style="animation-delay:${n(0.25 + i * 0.08, 3)}s"><text x="${x}" y="${y}" class="mono" font-size="11" letter-spacing="1" fill="${p.muted}">${esc(name.toUpperCase())}</text><text x="${x}" y="${y + 29}" class="sans" font-size="23" font-weight="700" letter-spacing="-.3" fill="${p.text}">${esc(fit(value, COL_W - 16, 23, { weight: 700 }))}</text><text x="${x}" y="${y + 49}" class="mono" font-size="11.5" fill="${p.muted}">${esc(fit(sub, COL_W - 12, 11.5, { mono: true }))}</text></g>`;
    }).join("");
  } else if (emptyBlock) {
    side = `<g class="fade" style="animation-delay:.25s"><text x="${INS_X}" y="${TOP}" class="mono" font-size="11" letter-spacing="1" fill="${p.muted}">NO ACTIVITY YET</text><text x="${INS_X}" y="${TOP + 30}" class="sans" font-size="23" font-weight="700" letter-spacing="-.3" fill="${p.text}">A blank canvas</text><text x="${INS_X}" y="${TOP + 56}" class="sans" font-size="14" fill="${p.muted}">Every commit, pull request, issue and review</text><text x="${INS_X}" y="${TOP + 76}" class="sans" font-size="14" fill="${p.muted}">raises a bar on this landscape.</text></g>`;
  }
  const legendSvg = renderLegend(legend2, legendY, colours, p);
  const body = shadow + slab + floor + axis + bars + pin + header2 + side + legendSvg;
  const who = ctx.data.name?.trim() || ctx.data.login;
  const summary = empty ? `No contributions ${spanPhrase}.` : `${fmt(total)} ${plural(total, "contribution")} ${spanPhrase}. Best day: ${fmt(peak)} on ${shortDate(best?.date ?? "")}. Busiest month: ${monthYear(`${sum.month.key}-01`)}. Favourite weekday: ${WEEKDAYS[sum.weekday.day]}. Active on ${sum.active} of ${sum.days} days.`;
  const svg = shell({
    width: W,
    height: H3,
    palette: p,
    title: `${who}: 3D contribution landscape`,
    desc: summary,
    body,
    defs,
    style,
    radius: 20,
    animate: ctx.animate,
    glow: { cx: Number(n(gx / W, 3)), cy: Number(n(gy / H3, 3)), r: 0.36, color: p.accentA, opacity: p.glowOpacity * (empty ? 0.25 : 0.5) }
  });
  return {
    name: "3d",
    alt: `3D contribution landscape: ${fmt(total)} ${plural(total, "contribution")} ${spanPhrase}`,
    svg,
    layout: "full"
  };
}
var LEGEND_SIZE = 11.5;
var CUBES_X = 36;
var CUBE_STEP = 19;
function legendParts(empty, peak, scale) {
  const notes = empty ? ["each tile is one day"] : [`peak ${fmt(peak)}/day`, SCALE_NOTE[scale], "each bar is one day"];
  const mono = { mono: true };
  const cubes = CUBES_X + 5 * CUBE_STEP + 6;
  const width = cubes + textWidth("More", LEGEND_SIZE, mono) + notes.reduce((s, t) => s + 24 + textWidth(`\xB7${t}`, LEGEND_SIZE, mono), 0);
  return { width, notes };
}
function renderLegend(legend2, y, colours, p) {
  const k = 0.62;
  const wv = [17 * k * 0.8, 5.5 * k * 0.8];
  const dv = [-9 * k * 0.8, 8 * k * 0.8];
  const ground = y - 3;
  const cubes = colours.map((c, i) => {
    const h = i === 0 ? 1.5 : 2 + i * 3;
    const bx = PAD + CUBES_X + i * CUBE_STEP - dv[0];
    const by = ground - (wv[1] + dv[1]) / 2;
    const q = (a, b, z = 0) => `${n(bx + a * wv[0] + b * dv[0])} ${n(by + a * wv[1] + b * dv[1] - z)}`;
    const top = `<path d="M${q(0, 0, h)}L${q(1, 0, h)}L${q(1, 1, h)}L${q(0, 1, h)}Z" fill="${c.top}"/>`;
    return `<path d="M${q(0, 1)}L${q(1, 1)}L${q(1, 1, h)}L${q(0, 1, h)}Z" fill="${c.front}"/><path d="M${q(1, 0)}L${q(1, 1)}L${q(1, 1, h)}L${q(1, 0, h)}Z" fill="${c.right}"/>` + top;
  }).join("");
  const moreX = PAD + CUBES_X + 5 * CUBE_STEP + 6;
  const notes = legend2.notes.map((t) => `<tspan dx="12" fill-opacity=".6">\xB7</tspan><tspan dx="12">${esc(t)}</tspan>`).join("");
  return `<g class="fade" style="animation-delay:.4s"><text x="${PAD}" y="${n(y)}" class="mono" font-size="${LEGEND_SIZE}" fill="${p.muted}">Less</text>` + cubes + `<text x="${n(moreX)}" y="${n(y)}" class="mono" font-size="${LEGEND_SIZE}" fill="${p.muted}">More${notes}</text></g>`;
}
var card2 = {
  id: "3d",
  title: "3D contribution landscape",
  description: "Your last year of contributions as an isometric landscape: every day is a bar whose height and colour grow with the work done, with your best day pinned and insights on your busiest month, favourite weekday and active days.",
  options: OPTIONS,
  render: (ctx) => [renderLandscape(ctx)]
};

// src/cards/grid.ts
var GRID_STYLES = ["pulse", "rain"];
var FULL_W = 1200;
var PAD2 = 40;
var MIN_WEEKS = 26;
var MAX_WEEKS = 53;
var MIN_CELL = 8;
var MAX_CELL = 40;
var GAP2 = 0.2;
var AXIS = 12;
var PULSE = { loop: 7, sweep: 3.4, start: 0.6, lead: 0.1, peak: 0.04, settle: 0.15 };
var SWELL = [1, 1.08, 1.13, 1.18, 1.24];
var BOOST = [0.2, 0.36, 0.5, 0.62, 0.8];
var RAIN = { start: 0.25, sweep: 1.4, drop: 0.7, settle: 0.35, groups: 6, spacing: 0.75 };
var GRID_OPTIONS = [
  {
    key: "style",
    type: "string",
    default: "pulse",
    description: '"pulse" (a light wave sweeps across your year) or "rain" (columns drop in, then your busiest days twinkle).'
  },
  { key: "weeks", type: "number", default: 53, description: "Weeks to show, 26 to 53, ending today." },
  {
    key: "cellSize",
    type: "number",
    default: "auto",
    description: "Cell size in px (8 to 40). By default cells grow to fill the 1200px card; smaller values make a narrower card."
  },
  { key: "title", type: "string", default: "Contributions \xB7 last 12 months", description: "Header label." },
  { key: "hideTitle", type: "boolean", default: false, description: "Hide the header label." },
  { key: "hideStats", type: "boolean", default: false, description: "Hide the total / active days / best day line." },
  { key: "loop", type: "boolean", default: true, description: "Loop the animation forever; false plays it once." }
];
var safeCount = (c) => Number.isFinite(c) && c > 0 ? Math.floor(c) : 0;
var fmt2 = (v) => v.toLocaleString("en-US");
function summarize2(cells) {
  let total = 0;
  let active = 0;
  let best = null;
  for (const c of cells) {
    total += c.count;
    if (c.count > 0) active++;
    if (c.count > 0 && (!best || c.count >= best.count)) best = c;
  }
  return { total, active, best };
}
function group(week, day) {
  let x = Math.imul(week + 1, 374761393) + Math.imul(day + 1, 668265263) | 0;
  x = Math.imul(x ^ x >>> 13, 1274126177);
  return ((x ^ x >>> 16) >>> 0) % RAIN.groups;
}
function statsLine(x, y, s, p, maxWidth) {
  const big = fmt2(s.total);
  const bigW = textWidth(big, 32, { weight: 800 }) - big.length;
  const unit = ` ${plural(s.total, "contribution")}`;
  const sep2 = (gap) => `<tspan dx="${gap}" fill="${p.faint}">\xB7</tspan>`;
  const activeVal = fmt2(s.active);
  const activeUnit = `${plural(s.active, "active day")}`;
  let svg = `<tspan font-size="32" font-weight="800" letter-spacing="-1" fill="url(#ps-grid-num)">${esc(big)}</tspan><tspan dx="10" fill="${p.muted}">${esc(unit.trim())}</tspan>` + sep2(16) + `<tspan dx="16" font-weight="700" fill="${p.text}">${esc(activeVal)}</tspan><tspan dx="6" fill="${p.muted}">${esc(activeUnit)}</tspan>`;
  let width = bigW + 10 + textWidth(unit.trim(), 16) + 32 + textWidth("\xB7", 16) + textWidth(activeVal, 16, { weight: 700 }) + 6 + textWidth(activeUnit, 16);
  if (s.best) {
    const bestVal = fmt2(s.best.count);
    const when = `on ${shortDate(s.best.date)}`;
    const extra = 32 + textWidth("\xB7", 16) + textWidth("best day", 16) + 6 + textWidth(bestVal, 16, { weight: 700 }) + 6 + textWidth(when, 16);
    if (width + extra <= maxWidth) {
      svg += sep2(16) + `<tspan dx="16" fill="${p.muted}">best day</tspan><tspan dx="6" font-weight="700" fill="${p.text}">${esc(bestVal)}</tspan><tspan dx="6" fill="${p.muted}">${esc(when)}</tspan>`;
      width += extra;
    }
  }
  return { svg: `<text x="${n(x)}" y="${n(y)}" class="sans" font-size="16">${svg}</text>`, width };
}
function legendWidth(cell) {
  return textWidth("Less", AXIS, { mono: true }) + 8 + 5 * cell + 4 * 4 + 8 + textWidth("More", AXIS, { mono: true });
}
function layout(o) {
  const gutter = Math.ceil(textWidth("Wed", AXIS, { mono: true })) + 12;
  const fullAvail = FULL_W - 2 * PAD2 - gutter;
  const fitPitch = fullAvail / (o.weeks - GAP2);
  let pitch = fitPitch;
  let W5 = FULL_W;
  if (o.requestedCell > 0) {
    const want = Math.min(MAX_CELL, Math.max(MIN_CELL, o.requestedCell)) / (1 - GAP2);
    if (want < fitPitch) {
      pitch = want;
      const content2 = 2 * PAD2 + gutter + pitch * (o.weeks - GAP2);
      W5 = Math.min(FULL_W, Math.max(o.minWidth, Math.ceil(content2)));
    }
  }
  const cell = pitch * (1 - GAP2);
  const gridW = pitch * (o.weeks - GAP2);
  const gridH = pitch * (7 - GAP2);
  let y = PAD2;
  let labelY = null;
  let statsY = null;
  if (!o.hideTitle) {
    labelY = y + 16;
    y = labelY;
  }
  if (!o.hideStats) {
    statsY = labelY === null ? y + 26 : y + 46;
    y = statsY;
  }
  const monthY = labelY === null && statsY === null ? y + 10 : y + (statsY === null ? 32 : 36);
  const gy = monthY + 12;
  const footY = gy + gridH + 32;
  return {
    W: W5,
    H: Math.ceil(footY + 30),
    gx: PAD2 + gutter,
    gy,
    pitch,
    cell,
    rx: Math.max(2, cell * 0.22),
    gridW,
    gridH,
    labelY,
    statsY,
    monthY,
    footY
  };
}
function monthLabels(cells, weeks, L, p) {
  const minGap = Math.ceil((textWidth("Mmm", AXIS, { mono: true }) + 8) / L.pitch);
  const out = [];
  for (const s of monthStarts(cells, weeks, minGap)) {
    const name = MONTHS[s.month] ?? "";
    const x = L.gx + s.week * L.pitch;
    if (x + textWidth(name, AXIS, { mono: true }) > L.gx + L.gridW + 1) continue;
    out.push(`<text x="${n(x)}" y="${n(L.monthY)}">${name}</text>`);
  }
  const days = [
    [1, "Mon"],
    [3, "Wed"],
    [5, "Fri"]
  ];
  for (const [d, name] of days) {
    const y = L.gy + d * L.pitch + L.cell / 2 + AXIS * 0.35;
    out.push(`<text x="${n(L.gx - 12)}" y="${n(y)}" text-anchor="end">${name}</text>`);
  }
  return `<g class="mono fade" font-size="${AXIS}" fill="${p.muted}">${out.join("")}</g>`;
}
function legend(L, ramp, p) {
  const size = 12;
  const right = L.gx + L.gridW;
  const moreW = textWidth("More", AXIS, { mono: true });
  const cellsRight = right - moreW - 8;
  const cellsLeft = cellsRight - (5 * size + 4 * 4);
  const swatches = ramp.map(
    (c, i) => `<rect x="${n(cellsLeft + i * (size + 4))}" y="${n(L.footY - 10)}" width="${size}" height="${size}" rx="3" fill="${c}"/>`
  ).join("");
  return `<g class="mono" font-size="${AXIS}" fill="${p.muted}"><text x="${n(cellsLeft - 8)}" y="${n(L.footY)}" text-anchor="end">Less</text>${swatches}<text x="${n(right)}" y="${n(L.footY)}" text-anchor="end">More</text></g>`;
}
function emptyMessage2(L, p) {
  const head = "No contributions yet";
  const sub = "Every commit, pull request and review lights up a square.";
  const w = Math.min(L.gridW - 16, Math.max(textWidth(head, 16, { weight: 700 }), textWidth(sub, 13)) + 64);
  const h = 70;
  const cx = L.gx + L.gridW / 2;
  const cy = L.gy + L.gridH / 2;
  return `<g class="up" style="animation-delay:.35s"><rect x="${n(cx - w / 2)}" y="${n(cy - h / 2)}" width="${n(w)}" height="${h}" rx="14" fill="${p.panel}" fill-opacity=".94" stroke="${p.border}"/><text x="${n(cx)}" y="${n(cy - 5)}" text-anchor="middle" class="sans" font-size="16" font-weight="700" fill="${p.text}">${head}</text><text x="${n(cx)}" y="${n(cy + 17)}" text-anchor="middle" class="sans" font-size="13" fill="${p.muted}">${sub}</text></g>`;
}
function pulseMotion(L, weeks, ramp, p, mode, iterations) {
  const T = PULSE.loop;
  const dw = PULSE.sweep / Math.max(1, weeks - 1);
  const wave = mode === "dark" ? mix(p.accentB, p.text, 0.82) : mix(p.accentB, p.panel, 0.3);
  const pk = n(PULSE.peak * 100, 2);
  const st = n(PULSE.settle * 100, 2);
  const frames = ramp.map((base, l) => {
    const hi = mix(base, wave, BOOST[l] ?? 0.5);
    const swell = SWELL[l] ?? 1;
    const grow = swell > 1 ? `;transform:scale(${swell})` : "";
    const back = swell > 1 ? ";transform:none" : "";
    return `.l${l}{animation:ps-p${l} ${T}s cubic-bezier(.3,0,.25,1) ${iterations} backwards}@keyframes ps-p${l}{${pk}%{fill:${hi}${grow}}${st}%{fill:${base}${back}}}`;
  }).join("");
  const xa = L.gx - (L.pitch - L.cell) / 2;
  const xb = L.gx + L.gridW + (L.pitch - L.cell) / 2;
  const ta = PULSE.start + PULSE.lead - dw / 2;
  const travel = weeks * dw;
  const tp = travel / T * 100;
  const fade = Math.min(4, tp * 0.08);
  const scanFrames = `@keyframes ps-scan{0%{transform:translateX(${n(xa)}px);opacity:0}${n(fade, 2)}%{opacity:1}${n(tp - fade, 2)}%{opacity:1}${n(tp, 2)}%,100%{transform:translateX(${n(xb)}px);opacity:0}}`;
  const top = L.gy - 8;
  const height = L.gridH + 16;
  const trail = Math.max(L.pitch * 5, 60);
  const line = mode === "dark" ? mix(p.accentB, p.text, 0.35) : p.accentB;
  const defs = `<linearGradient id="ps-grid-trail" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${p.accentB}" stop-opacity="0"/><stop offset="1" stop-color="${p.accentB}" stop-opacity="${mode === "dark" ? 0.34 : 0.24}"/></linearGradient><linearGradient id="ps-grid-line" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${line}" stop-opacity="0"/><stop offset=".22" stop-color="${line}"/><stop offset=".78" stop-color="${line}"/><stop offset="1" stop-color="${line}" stop-opacity="0"/></linearGradient>`;
  const under = `<rect class="scan" opacity="0" x="${n(-trail)}" y="${n(L.gy)}" width="${n(trail)}" height="${n(L.gridH)}" fill="url(#ps-grid-trail)"/>`;
  const over = `<g class="scan" opacity="0"><rect x="-4" y="${n(top)}" width="8" height="${n(height)}" rx="4" fill="url(#ps-grid-line)" opacity=".28"/><rect x="-1" y="${n(top)}" width="2" height="${n(height)}" rx="1" fill="url(#ps-grid-line)"/></g>`;
  const css = ".c>rect{animation-delay:inherit;transform-box:fill-box;transform-origin:center}" + frames + `.scan{animation:ps-scan ${T}s linear ${iterations} backwards;animation-delay:${n(ta, 3)}s}` + scanFrames;
  return {
    css,
    column: (w) => `animation-delay:${n(PULSE.start + w * dw, 3)}s`,
    cellClass: () => "",
    under: `<defs>${defs}</defs>${under}`,
    over
  };
}
function rainMotion(L, weeks, cells, level, ramp, p, mode, iterations) {
  const dw = RAIN.sweep / Math.max(1, weeks - 1);
  const dist = Math.round(Math.min(40, L.pitch * 1.6));
  const twinkleStart = RAIN.start + RAIN.sweep + RAIN.drop + RAIN.settle;
  const peak = ramp[4] ?? p.accentB;
  const flash = mode === "dark" ? mix(peak, p.text, 0.3) : mix(peak, p.accentB, 0.55);
  const groups = Array.from({ length: RAIN.groups }, (_, k2) => {
    const duration = 4.2 + k2 % 3 * 0.8;
    return `.t${k2}{animation-duration:${n(duration, 2)}s;animation-delay:${n(twinkleStart + k2 * RAIN.spacing, 3)}s}`;
  }).join("");
  const css = `.c{animation:ps-drop ${RAIN.drop}s cubic-bezier(.34,1.45,.64,1) backwards}@keyframes ps-drop{from{opacity:0;transform:translateY(-${dist}px)}}.tw,.sp{transform-box:fill-box;transform-origin:center}.tw{animation:ps-tw 5s ease-in-out ${iterations} backwards}@keyframes ps-tw{7%{fill:${flash};transform:scale(1.2)}17%{fill:${peak};transform:none}}.sp{animation:ps-sp 5s ease-in-out ${iterations} backwards}@keyframes ps-sp{0%{opacity:0;transform:scale(.2) rotate(-45deg)}7%{opacity:1;transform:scale(1) rotate(0deg)}17%{opacity:0;transform:scale(.35) rotate(45deg)}}` + groups;
  const r = Math.max(5, L.cell * 0.7);
  const k = r * 0.14;
  const rel = `q${n(k)} ${n(r - k)} ${n(r)} ${n(r)}q${n(k - r)} ${n(k)} ${n(-r)} ${n(r)}q${n(-k)} ${n(k - r)} ${n(-r)} ${n(-r)}q${n(r - k)} ${n(-k)} ${n(r)} ${n(-r)}z`;
  const sparks = [];
  for (const c of cells) {
    if (level(c.count) !== 4) continue;
    const cx = L.gx + c.week * L.pitch + L.cell / 2;
    const cy = L.gy + c.day * L.pitch + L.cell / 2;
    sparks.push(`<path class="sp t${group(c.week, c.day)}" opacity="0" d="M${n(cx)} ${n(cy - r)}${rel}"/>`);
  }
  const glint = mode === "dark" ? p.text : p.panel;
  return {
    css,
    column: (w) => `animation-delay:${n(RAIN.start + w * dw, 3)}s`,
    cellClass: (c, lv) => lv === 4 ? ` tw t${group(c.week, c.day)}` : "",
    under: "",
    over: sparks.length ? `<g fill="${glint}">${sparks.join("")}</g>` : ""
  };
}
function renderGrid(ctx) {
  const o = readOptions(ctx.options);
  const styleRaw = o.string("style", "pulse").trim().toLowerCase();
  const style = GRID_STYLES.includes(styleRaw) ? styleRaw : "pulse";
  const weeks = Math.round(o.number("weeks", MAX_WEEKS, { min: MIN_WEEKS, max: MAX_WEEKS }));
  const requestedCell = o.number("cellSize", 0);
  const hideTitle = o.boolean("hideTitle", false);
  const hideStats = o.boolean("hideStats", false);
  const iterations = o.boolean("loop", true) ? "infinite" : "1";
  const period = weeks >= 52 ? "last 12 months" : `last ${weeks} weeks`;
  const title = o.string("title", `Contributions \xB7 ${period}`);
  const p = ctx.palette;
  const ramp = contribRamp(p, ctx.mode);
  const cells = yearWindow(ctx.data.calendar ?? [], ctx.now, weeks).map((c) => ({ ...c, count: safeCount(c.count) }));
  const level = levelScale(cells.map((c) => c.count));
  const fullYear = weeks >= 52;
  const counted = fullYear ? lastYear(ctx.data.calendar ?? [], ctx.now).map((d) => ({ ...d, week: 0, day: 0, count: safeCount(d.count) })) : cells;
  const stats = summarize2(counted);
  if (fullYear) stats.total = yearTotal(ctx.data, ctx.now);
  const first = cells[0];
  const last = cells[cells.length - 1];
  const range = first && last ? `${shortDate(first.date)} \u2013 ${shortDate(last.date)}` : "";
  const probe = statsLine(0, 0, stats, p, Number.POSITIVE_INFINITY);
  const chrome = Math.max(
    hideStats ? 0 : Math.min(probe.width, 760),
    hideTitle ? 0 : Math.min(labelWidth(title), 760),
    textWidth(range, AXIS, { mono: true }) + 32 + legendWidth(12),
    460
  );
  const L = layout({ weeks, requestedCell, hideTitle, hideStats, minWidth: Math.ceil(chrome + 2 * PAD2) });
  const contentRight = L.W - PAD2;
  const motion = style === "rain" ? rainMotion(L, weeks, cells, level, ramp, p, ctx.mode, iterations) : pulseMotion(L, weeks, ramp, p, ctx.mode, iterations);
  const columns = [];
  const size = n(L.cell);
  const rx = n(L.rx);
  for (let w = 0; w < weeks; w++) {
    const parts2 = [];
    for (let d = 0; d < 7; d++) {
      const c = cells[w * 7 + d];
      if (!c) break;
      const lv = level(c.count);
      const x = L.gx + w * L.pitch;
      const y = L.gy + d * L.pitch;
      parts2.push(
        `<rect class="l${lv}${motion.cellClass(c, lv)}" x="${n(x)}" y="${n(y)}" width="${size}" height="${size}" rx="${rx}" fill="${ramp[lv]}"/>`
      );
      if (stats.best && c.date === stats.best.date) {
        const off = 2.5;
        parts2.push(
          `<rect x="${n(x - off)}" y="${n(y - off)}" width="${n(L.cell + off * 2)}" height="${n(L.cell + off * 2)}" rx="${n(L.rx + off)}" fill="none" stroke="${p.text}" stroke-opacity=".7" stroke-width="1.5"/>`
        );
      }
    }
    if (parts2.length) columns.push(`<g class="c" style="${motion.column(w)}">${parts2.join("")}</g>`);
  }
  const body = [];
  if (L.labelY !== null) {
    const text = fitLabel(title, contentRight - PAD2);
    body.push(`<g class="fade">${label(PAD2, L.labelY, text, p)}</g>`);
  }
  if (L.statsY !== null) {
    const line = statsLine(PAD2, L.statsY, stats, p, contentRight - PAD2);
    body.push(`<g class="up" style="animation-delay:.08s">${line.svg}</g>`);
  }
  body.push(monthLabels(cells, weeks, L, p));
  body.push(motion.under);
  body.push(`<g>${columns.join("")}</g>`);
  body.push(motion.over);
  if (cells.every((c) => c.count === 0)) body.push(emptyMessage2(L, p));
  if (range) {
    body.push(
      `<text x="${n(L.gx)}" y="${n(L.footY)}" class="mono fade" font-size="${AXIS}" fill="${p.muted}">${esc(range)}</text>`
    );
  }
  body.push(`<g class="fade">${legend(L, ramp, p)}</g>`);
  const summary = `${fmt2(stats.total)} ${plural(stats.total, "contribution")} in the ${period}`;
  const desc = stats.best ? `${fmt2(stats.active)} ${plural(stats.active, "active day")}. Best day: ${shortDate(stats.best.date)} with ${fmt2(stats.best.count)} ${plural(stats.best.count, "contribution")}.` : "No contributions yet.";
  const svg = shell({
    width: L.W,
    height: L.H,
    palette: p,
    title: `Contribution grid: ${summary}`,
    desc,
    radius: L.W <= 600 ? 16 : 20,
    glow: { cx: 0.08, cy: 0, r: 0.9, color: p.accentA, opacity: p.glowOpacity * 0.22 },
    defs: linearGradient("ps-grid-num", p.accentA, p.accentB),
    style: motion.css,
    body: body.join(""),
    animate: ctx.animate
  });
  return { name: "grid", alt: `Contribution grid: ${summary}`, svg, layout: "full" };
}
var card3 = {
  id: "grid",
  title: "Contribution grid",
  description: "Your contribution calendar, animated: a light wave pulses across your year, or columns rain into place and your busiest days twinkle.",
  options: GRID_OPTIONS,
  render: (ctx) => [renderGrid(ctx)]
};

// src/cards/icons.generated.ts
var ICONS = {
  "typescript": { title: "TypeScript", hex: "3178C6", category: "language", path: "M1.125 0C.502 0 0 .502 0 1.125v21.75C0 23.498.502 24 1.125 24h21.75c.623 0 1.125-.502 1.125-1.125V1.125C24 .502 23.498 0 22.875 0zm17.363 9.75c.612 0 1.154.037 1.627.111a6.38 6.38 0 0 1 1.306.34v2.458a3.95 3.95 0 0 0-.643-.361 5.093 5.093 0 0 0-.717-.26 5.453 5.453 0 0 0-1.426-.2c-.3 0-.573.028-.819.086a2.1 2.1 0 0 0-.623.242c-.17.104-.3.229-.393.374a.888.888 0 0 0-.14.49c0 .196.053.373.156.529.104.156.252.304.443.444s.423.276.696.41c.273.135.582.274.926.416.47.197.892.407 1.266.628.374.222.695.473.963.753.268.279.472.598.614.957.142.359.214.776.214 1.253 0 .657-.125 1.21-.373 1.656a3.033 3.033 0 0 1-1.012 1.085 4.38 4.38 0 0 1-1.487.596c-.566.12-1.163.18-1.79.18a9.916 9.916 0 0 1-1.84-.164 5.544 5.544 0 0 1-1.512-.493v-2.63a5.033 5.033 0 0 0 3.237 1.2c.333 0 .624-.03.872-.09.249-.06.456-.144.623-.25.166-.108.29-.234.373-.38a1.023 1.023 0 0 0-.074-1.089 2.12 2.12 0 0 0-.537-.5 5.597 5.597 0 0 0-.807-.444 27.72 27.72 0 0 0-1.007-.436c-.918-.383-1.602-.852-2.053-1.405-.45-.553-.676-1.222-.676-2.005 0-.614.123-1.141.369-1.582.246-.441.58-.804 1.004-1.089a4.494 4.494 0 0 1 1.47-.629 7.536 7.536 0 0 1 1.77-.201zm-15.113.188h9.563v2.166H9.506v9.646H6.789v-9.646H3.375z" },
  "javascript": { title: "JavaScript", hex: "F7DF1E", category: "language", path: "M0 0h24v24H0V0zm22.034 18.276c-.175-1.095-.888-2.015-3.003-2.873-.736-.345-1.554-.585-1.797-1.14-.091-.33-.105-.51-.046-.705.15-.646.915-.84 1.515-.66.39.12.75.42.976.9 1.034-.676 1.034-.676 1.755-1.125-.27-.42-.404-.601-.586-.78-.63-.705-1.469-1.065-2.834-1.034l-.705.089c-.676.165-1.32.525-1.71 1.005-1.14 1.291-.811 3.541.569 4.471 1.365 1.02 3.361 1.244 3.616 2.205.24 1.17-.87 1.545-1.966 1.41-.811-.18-1.26-.586-1.755-1.336l-1.83 1.051c.21.48.45.689.81 1.109 1.74 1.756 6.09 1.666 6.871-1.004.029-.09.24-.705.074-1.65l.046.067zm-8.983-7.245h-2.248c0 1.938-.009 3.864-.009 5.805 0 1.232.063 2.363-.138 2.711-.33.689-1.18.601-1.566.48-.396-.196-.597-.466-.83-.855-.063-.105-.11-.196-.127-.196l-1.825 1.125c.305.63.75 1.172 1.324 1.517.855.51 2.004.675 3.207.405.783-.226 1.458-.691 1.811-1.411.51-.93.402-2.07.397-3.346.012-2.054 0-4.109 0-6.179l.004-.056z" },
  "python": { title: "Python", hex: "3776AB", category: "language", path: "M14.25.18l.9.2.73.26.59.3.45.32.34.34.25.34.16.33.1.3.04.26.02.2-.01.13V8.5l-.05.63-.13.55-.21.46-.26.38-.3.31-.33.25-.35.19-.35.14-.33.1-.3.07-.26.04-.21.02H8.77l-.69.05-.59.14-.5.22-.41.27-.33.32-.27.35-.2.36-.15.37-.1.35-.07.32-.04.27-.02.21v3.06H3.17l-.21-.03-.28-.07-.32-.12-.35-.18-.36-.26-.36-.36-.35-.46-.32-.59-.28-.73-.21-.88-.14-1.05-.05-1.23.06-1.22.16-1.04.24-.87.32-.71.36-.57.4-.44.42-.33.42-.24.4-.16.36-.1.32-.05.24-.01h.16l.06.01h8.16v-.83H6.18l-.01-2.75-.02-.37.05-.34.11-.31.17-.28.25-.26.31-.23.38-.2.44-.18.51-.15.58-.12.64-.1.71-.06.77-.04.84-.02 1.27.05zm-6.3 1.98l-.23.33-.08.41.08.41.23.34.33.22.41.09.41-.09.33-.22.23-.34.08-.41-.08-.41-.23-.33-.33-.22-.41-.09-.41.09zm13.09 3.95l.28.06.32.12.35.18.36.27.36.35.35.47.32.59.28.73.21.88.14 1.04.05 1.23-.06 1.23-.16 1.04-.24.86-.32.71-.36.57-.4.45-.42.33-.42.24-.4.16-.36.09-.32.05-.24.02-.16-.01h-8.22v.82h5.84l.01 2.76.02.36-.05.34-.11.31-.17.29-.25.25-.31.24-.38.2-.44.17-.51.15-.58.13-.64.09-.71.07-.77.04-.84.01-1.27-.04-1.07-.14-.9-.2-.73-.25-.59-.3-.45-.33-.34-.34-.25-.34-.16-.33-.1-.3-.04-.25-.02-.2.01-.13v-5.34l.05-.64.13-.54.21-.46.26-.38.3-.32.33-.24.35-.2.35-.14.33-.1.3-.06.26-.04.21-.02.13-.01h5.84l.69-.05.59-.14.5-.21.41-.28.33-.32.27-.35.2-.36.15-.36.1-.35.07-.32.04-.28.02-.21V6.07h2.09l.14.01zm-6.47 14.25l-.23.33-.08.41.08.41.23.33.33.23.41.08.41-.08.33-.23.23-.33.08-.41-.08-.41-.23-.33-.33-.23-.41-.08-.41.08z" },
  "go": { title: "Go", hex: "00ADD8", category: "language", path: "M1.811 10.231c-.047 0-.058-.023-.035-.059l.246-.315c.023-.035.081-.058.128-.058h4.172c.046 0 .058.035.035.07l-.199.303c-.023.036-.082.07-.117.07zM.047 11.306c-.047 0-.059-.023-.035-.058l.245-.316c.023-.035.082-.058.129-.058h5.328c.047 0 .07.035.058.07l-.093.28c-.012.047-.058.07-.105.07zm2.828 1.075c-.047 0-.059-.035-.035-.07l.163-.292c.023-.035.07-.07.117-.07h2.337c.047 0 .07.035.07.082l-.023.28c0 .047-.047.082-.082.082zm12.129-2.36c-.736.187-1.239.327-1.963.514-.176.046-.187.058-.34-.117-.174-.199-.303-.327-.548-.444-.737-.362-1.45-.257-2.115.175-.795.514-1.204 1.274-1.192 2.22.011.935.654 1.706 1.577 1.835.795.105 1.46-.175 1.987-.77.105-.13.198-.27.315-.434H10.47c-.245 0-.304-.152-.222-.35.152-.362.432-.97.596-1.274a.315.315 0 01.292-.187h4.253c-.023.316-.023.631-.07.947a4.983 4.983 0 01-.958 2.29c-.841 1.11-1.94 1.8-3.33 1.986-1.145.152-2.209-.07-3.143-.77-.865-.655-1.356-1.52-1.484-2.595-.152-1.274.222-2.419.993-3.424.83-1.086 1.928-1.776 3.272-2.02 1.098-.2 2.15-.07 3.096.571.62.41 1.063.97 1.356 1.648.07.105.023.164-.117.2m3.868 6.461c-1.064-.024-2.034-.328-2.852-1.029a3.665 3.665 0 01-1.262-2.255c-.21-1.32.152-2.489.947-3.529.853-1.122 1.881-1.706 3.272-1.95 1.192-.21 2.314-.095 3.33.595.923.63 1.496 1.484 1.648 2.605.198 1.578-.257 2.863-1.344 3.962-.771.783-1.718 1.273-2.805 1.495-.315.06-.63.07-.934.106zm2.78-4.72c-.011-.153-.011-.27-.034-.387-.21-1.157-1.274-1.81-2.384-1.554-1.087.245-1.788.935-2.045 2.033-.21.912.234 1.835 1.075 2.21.643.28 1.285.244 1.905-.07.923-.48 1.425-1.228 1.484-2.233z" },
  "rust": { title: "Rust", hex: "000000", category: "language", path: "M23.8346 11.7033l-1.0073-.6236a13.7268 13.7268 0 00-.0283-.2936l.8656-.8069a.3483.3483 0 00-.1154-.578l-1.1066-.414a8.4958 8.4958 0 00-.087-.2856l.6904-.9587a.3462.3462 0 00-.2257-.5446l-1.1663-.1894a9.3574 9.3574 0 00-.1407-.2622l.49-1.0761a.3437.3437 0 00-.0274-.3361.3486.3486 0 00-.3006-.154l-1.1845.0416a6.7444 6.7444 0 00-.1873-.2268l.2723-1.153a.3472.3472 0 00-.417-.4172l-1.1532.2724a14.0183 14.0183 0 00-.2278-.1873l.0415-1.1845a.3442.3442 0 00-.49-.328l-1.076.491c-.0872-.0476-.1742-.0952-.2623-.1407l-.1903-1.1673A.3483.3483 0 0016.256.955l-.9597.6905a8.4867 8.4867 0 00-.2855-.086l-.414-1.1066a.3483.3483 0 00-.5781-.1154l-.8069.8666a9.2936 9.2936 0 00-.2936-.0284L12.2946.1683a.3462.3462 0 00-.5892 0l-.6236 1.0073a13.7383 13.7383 0 00-.2936.0284L9.9803.3374a.3462.3462 0 00-.578.1154l-.4141 1.1065c-.0962.0274-.1903.0567-.2855.086L7.744.955a.3483.3483 0 00-.5447.2258L7.009 2.348a9.3574 9.3574 0 00-.2622.1407l-1.0762-.491a.3462.3462 0 00-.49.328l.0416 1.1845a7.9826 7.9826 0 00-.2278.1873L3.8413 3.425a.3472.3472 0 00-.4171.4171l.2713 1.1531c-.0628.075-.1255.1509-.1863.2268l-1.1845-.0415a.3462.3462 0 00-.328.49l.491 1.0761a9.167 9.167 0 00-.1407.2622l-1.1662.1894a.3483.3483 0 00-.2258.5446l.6904.9587a13.303 13.303 0 00-.087.2855l-1.1065.414a.3483.3483 0 00-.1155.5781l.8656.807a9.2936 9.2936 0 00-.0283.2935l-1.0073.6236a.3442.3442 0 000 .5892l1.0073.6236c.008.0982.0182.1964.0283.2936l-.8656.8079a.3462.3462 0 00.1155.578l1.1065.4141c.0273.0962.0567.1914.087.2855l-.6904.9587a.3452.3452 0 00.2268.5447l1.1662.1893c.0456.088.0922.1751.1408.2622l-.491 1.0762a.3462.3462 0 00.328.49l1.1834-.0415c.0618.0769.1235.1528.1873.2277l-.2713 1.1541a.3462.3462 0 00.4171.4161l1.153-.2713c.075.0638.151.1255.2279.1863l-.0415 1.1845a.3442.3442 0 00.49.327l1.0761-.49c.087.0486.1741.0951.2622.1407l.1903 1.1662a.3483.3483 0 00.5447.2268l.9587-.6904a9.299 9.299 0 00.2855.087l.414 1.1066a.3452.3452 0 00.5781.1154l.8079-.8656c.0972.0111.1954.0203.2936.0294l.6236 1.0073a.3472.3472 0 00.5892 0l.6236-1.0073c.0982-.0091.1964-.0183.2936-.0294l.8069.8656a.3483.3483 0 00.578-.1154l.4141-1.1066a8.4626 8.4626 0 00.2855-.087l.9587.6904a.3452.3452 0 00.5447-.2268l.1903-1.1662c.088-.0456.1751-.0931.2622-.1407l1.0762.49a.3472.3472 0 00.49-.327l-.0415-1.1845a6.7267 6.7267 0 00.2267-.1863l1.1531.2713a.3472.3472 0 00.4171-.416l-.2713-1.1542c.0628-.0749.1255-.1508.1863-.2278l1.1845.0415a.3442.3442 0 00.328-.49l-.49-1.076c.0475-.0872.0951-.1742.1407-.2623l1.1662-.1893a.3483.3483 0 00.2258-.5447l-.6904-.9587.087-.2855 1.1066-.414a.3462.3462 0 00.1154-.5781l-.8656-.8079c.0101-.0972.0202-.1954.0283-.2936l1.0073-.6236a.3442.3442 0 000-.5892zm-6.7413 8.3551a.7138.7138 0 01.2986-1.396.714.714 0 11-.2997 1.396zm-.3422-2.3142a.649.649 0 00-.7715.5l-.3573 1.6685c-1.1035.501-2.3285.7795-3.6193.7795a8.7368 8.7368 0 01-3.6951-.814l-.3574-1.6684a.648.648 0 00-.7714-.499l-1.473.3158a8.7216 8.7216 0 01-.7613-.898h7.1676c.081 0 .1356-.0141.1356-.088v-2.536c0-.074-.0536-.0881-.1356-.0881h-2.0966v-1.6077h2.2677c.2065 0 1.1065.0587 1.394 1.2088.0901.3533.2875 1.5044.4232 1.8729.1346.413.6833 1.2381 1.2685 1.2381h3.5716a.7492.7492 0 00.1296-.0131 8.7874 8.7874 0 01-.8119.9526zM6.8369 20.024a.714.714 0 11-.2997-1.396.714.714 0 01.2997 1.396zM4.1177 8.9972a.7137.7137 0 11-1.304.5791.7137.7137 0 011.304-.579zm-.8352 1.9813l1.5347-.6824a.65.65 0 00.33-.8585l-.3158-.7147h1.2432v5.6025H3.5669a8.7753 8.7753 0 01-.2834-3.348zm6.7343-.5437V8.7836h2.9601c.153 0 1.0792.1772 1.0792.8697 0 .575-.7107.7815-1.2948.7815zm10.7574 1.4862c0 .2187-.008.4363-.0243.651h-.9c-.09 0-.1265.0586-.1265.1477v.413c0 .973-.5487 1.1846-1.0296 1.2382-.4576.0517-.9648-.1913-1.0275-.4717-.2704-1.5186-.7198-1.8436-1.4305-2.4034.8817-.5599 1.799-1.386 1.799-2.4915 0-1.1936-.819-1.9458-1.3769-2.3153-.7825-.5163-1.6491-.6195-1.883-.6195H5.4682a8.7651 8.7651 0 014.907-2.7699l1.0974 1.151a.648.648 0 00.9182.0213l1.227-1.1743a8.7753 8.7753 0 016.0044 4.2762l-.8403 1.8982a.652.652 0 00.33.8585l1.6178.7188c.0283.2875.0425.577.0425.8717zm-9.3006-9.5993a.7128.7128 0 11.984 1.0316.7137.7137 0 01-.984-1.0316zm8.3389 6.71a.7107.7107 0 01.9395-.3625.7137.7137 0 11-.9405.3635z" },
  "c": { title: "C", hex: "A8B9CC", category: "language", path: "M16.5921 9.1962s-.354-3.298-3.627-3.39c-3.2741-.09-4.9552 2.474-4.9552 6.14 0 3.6651 1.858 6.5972 5.0451 6.5972 3.184 0 3.5381-3.665 3.5381-3.665l6.1041.365s.36 3.31-2.196 5.836c-2.552 2.5241-5.6901 2.9371-7.8762 2.9201-2.19-.017-5.2261.034-8.1602-2.97-2.938-3.0101-3.436-5.9302-3.436-8.8002 0-2.8701.556-6.6702 4.047-9.5502C7.444.72 9.849 0 12.254 0c10.0422 0 10.7172 9.2602 10.7172 9.2602z" },
  "cplusplus": { title: "C++", hex: "00599C", category: "language", path: "M22.394 6c-.167-.29-.398-.543-.652-.69L12.926.22c-.509-.294-1.34-.294-1.848 0L2.26 5.31c-.508.293-.923 1.013-.923 1.6v10.18c0 .294.104.62.271.91.167.29.398.543.652.69l8.816 5.09c.508.293 1.34.293 1.848 0l8.816-5.09c.254-.147.485-.4.652-.69.167-.29.27-.616.27-.91V6.91c.003-.294-.1-.62-.268-.91zM12 19.11c-3.92 0-7.109-3.19-7.109-7.11 0-3.92 3.19-7.11 7.11-7.11a7.133 7.133 0 016.156 3.553l-3.076 1.78a3.567 3.567 0 00-3.08-1.78A3.56 3.56 0 008.444 12 3.56 3.56 0 0012 15.555a3.57 3.57 0 003.08-1.778l3.078 1.78A7.135 7.135 0 0112 19.11zm7.11-6.715h-.79v.79h-.79v-.79h-.79v-.79h.79v-.79h.79v.79h.79zm2.962 0h-.79v.79h-.79v-.79h-.79v-.79h.79v-.79h.79v.79h.79z" },
  "kotlin": { title: "Kotlin", hex: "7F52FF", category: "language", path: "M24 24H0V0h24L12 12Z" },
  "swift": { title: "Swift", hex: "F05138", category: "language", path: "M7.508 0c-.287 0-.573 0-.86.002-.241.002-.483.003-.724.01-.132.003-.263.009-.395.015A9.154 9.154 0 0 0 4.348.15 5.492 5.492 0 0 0 2.85.645 5.04 5.04 0 0 0 .645 2.848c-.245.48-.4.972-.495 1.5-.093.52-.122 1.05-.136 1.576a35.2 35.2 0 0 0-.012.724C0 6.935 0 7.221 0 7.508v8.984c0 .287 0 .575.002.862.002.24.005.481.012.722.014.526.043 1.057.136 1.576.095.528.25 1.02.495 1.5a5.03 5.03 0 0 0 2.205 2.203c.48.244.97.4 1.498.495.52.093 1.05.124 1.576.138.241.007.483.009.724.01.287.002.573.002.86.002h8.984c.287 0 .573 0 .86-.002.241-.001.483-.003.724-.01a10.523 10.523 0 0 0 1.578-.138 5.322 5.322 0 0 0 1.498-.495 5.035 5.035 0 0 0 2.203-2.203c.245-.48.4-.972.495-1.5.093-.52.124-1.05.138-1.576.007-.241.009-.481.01-.722.002-.287.002-.575.002-.862V7.508c0-.287 0-.573-.002-.86a33.662 33.662 0 0 0-.01-.724 10.5 10.5 0 0 0-.138-1.576 5.328 5.328 0 0 0-.495-1.5A5.039 5.039 0 0 0 21.152.645 5.32 5.32 0 0 0 19.654.15a10.493 10.493 0 0 0-1.578-.138 34.98 34.98 0 0 0-.722-.01C17.067 0 16.779 0 16.492 0H7.508zm6.035 3.41c4.114 2.47 6.545 7.162 5.549 11.131-.024.093-.05.181-.076.272l.002.001c2.062 2.538 1.5 5.258 1.236 4.745-1.072-2.086-3.066-1.568-4.088-1.043a6.803 6.803 0 0 1-.281.158l-.02.012-.002.002c-2.115 1.123-4.957 1.205-7.812-.022a12.568 12.568 0 0 1-5.64-4.838c.649.48 1.35.902 2.097 1.252 3.019 1.414 6.051 1.311 8.197-.002C9.651 12.73 7.101 9.67 5.146 7.191a10.628 10.628 0 0 1-1.005-1.384c2.34 2.142 6.038 4.83 7.365 5.576C8.69 8.408 6.208 4.743 6.324 4.86c4.436 4.47 8.528 6.996 8.528 6.996.154.085.27.154.36.213.085-.215.16-.437.224-.668.708-2.588-.09-5.548-1.893-7.992z" },
  "ruby": { title: "Ruby", hex: "CC342D", category: "language", path: "M20.156.083c3.033.525 3.893 2.598 3.829 4.77L24 4.822 22.635 22.71 4.89 23.926h.016C3.433 23.864.15 23.729 0 19.139l1.645-3 2.819 6.586.503 1.172 2.805-9.144-.03.007.016-.03 9.255 2.956-1.396-5.431-.99-3.9 8.82-.569-.615-.51L16.5 2.114 20.159.073l-.003.01zM0 19.089zM5.13 5.073c3.561-3.533 8.157-5.621 9.922-3.84 1.762 1.777-.105 6.105-3.673 9.636-3.563 3.532-8.103 5.734-9.864 3.957-1.766-1.777.045-6.217 3.612-9.75l.003-.003z" },
  "php": { title: "PHP", hex: "777BB4", category: "language", path: "M7.01 10.207h-.944l-.515 2.648h.838c.556 0 .97-.105 1.242-.314.272-.21.455-.559.55-1.049.092-.47.05-.802-.124-.995-.175-.193-.523-.29-1.047-.29zM12 5.688C5.373 5.688 0 8.514 0 12s5.373 6.313 12 6.313S24 15.486 24 12c0-3.486-5.373-6.312-12-6.312zm-3.26 7.451c-.261.25-.575.438-.917.551-.336.108-.765.164-1.285.164H5.357l-.327 1.681H3.652l1.23-6.326h2.65c.797 0 1.378.209 1.744.628.366.418.476 1.002.33 1.752a2.836 2.836 0 0 1-.305.847c-.143.255-.33.49-.561.703zm4.024.715l.543-2.799c.063-.318.039-.536-.068-.651-.107-.116-.336-.174-.687-.174H11.46l-.704 3.625H9.388l1.23-6.327h1.367l-.327 1.682h1.218c.767 0 1.295.134 1.586.401s.378.7.263 1.299l-.572 2.944h-1.389zm7.597-2.265a2.782 2.782 0 0 1-.305.847c-.143.255-.33.49-.561.703a2.44 2.44 0 0 1-.917.551c-.336.108-.765.164-1.286.164h-1.18l-.327 1.682h-1.378l1.23-6.326h2.649c.797 0 1.378.209 1.744.628.366.417.477 1.001.331 1.751zM17.766 10.207h-.943l-.516 2.648h.838c.557 0 .971-.105 1.242-.314.272-.21.455-.559.551-1.049.092-.47.049-.802-.125-.995s-.524-.29-1.047-.29z" },
  "scala": { title: "Scala", hex: "DC322F", category: "language", path: "M4.589 24c4.537 0 13.81-1.516 14.821-3v-5.729c-.957 1.408-10.284 2.912-14.821 2.912V24zM4.589 16.365c4.537 0 13.81-1.516 14.821-3V7.636c-.957 1.408-10.284 2.912-14.821 2.912v5.817zM4.589 8.729c4.537 0 13.81-1.516 14.821-3V0C18.453 1.408 9.126 2.912 4.589 2.912v5.817z" },
  "elixir": { title: "Elixir", hex: "4B275F", category: "language", path: "M19.793 16.575c0 3.752-2.927 7.426-7.743 7.426-5.249 0-7.843-3.71-7.843-8.29 0-5.21 3.892-12.952 8-15.647a.397.397 0 0 1 .61.371 9.716 9.716 0 0 0 1.694 6.518c.522.795 1.092 1.478 1.763 2.352.94 1.227 1.637 1.906 2.644 3.842l.015.028a7.107 7.107 0 0 1 .86 3.4z" },
  "erlang": { title: "Erlang", hex: "A90533", category: "language", path: "M8.859 7.889c.154-1.863 1.623-3.115 3.344-3.119 1.734.004 2.986 1.256 3.029 3.119zm12.11 11.707c.802-.86 1.52-1.872 2.172-3.03l-3.616-1.807c-1.27 2.064-3.127 3.965-5.694 3.977-3.738-.012-5.206-3.208-5.198-7.322h13.966c.019-.464.019-.68 0-.904.091-2.447-.558-4.504-1.737-6.106l-.007.005H24v15.186h-3.039zm-17.206-.001C1.901 17.62.811 14.894.813 11.64c-.002-2.877.902-5.35 2.456-7.232H0v15.187h3.761Z" },
  "haskell": { title: "Haskell", hex: "5D4F85", category: "language", path: "M0 3.535L5.647 12 0 20.465h4.235L9.883 12 4.235 3.535zm5.647 0L11.294 12l-5.647 8.465h4.235l3.53-5.29 3.53 5.29h4.234L9.883 3.535zm8.941 4.938l1.883 2.822H24V8.473zm2.824 4.232l1.882 2.822H24v-2.822z" },
  "clojure": { title: "Clojure", hex: "5881D8", category: "language", path: "M11.503 12.216c-.119.259-.251.549-.387.858-.482 1.092-1.016 2.42-1.21 3.271a4.91 4.91 0 0 0-.112 1.096c0 .164.009.337.022.514.682.25 1.417.388 2.186.39a6.39 6.39 0 0 0 2.001-.326 3.808 3.808 0 0 1-.418-.441c-.854-1.089-1.329-2.682-2.082-5.362M8.355 6.813A6.347 6.347 0 0 0 5.657 12a6.347 6.347 0 0 0 2.625 5.134c.39-1.622 1.366-3.107 2.83-6.084-.087-.239-.186-.5-.297-.775-.406-1.018-.991-2.198-1.513-2.733a4.272 4.272 0 0 0-.947-.729M17.527 19.277c-.84-.105-1.533-.232-2.141-.446A7.625 7.625 0 0 1 4.376 12a7.6 7.6 0 0 1 2.6-5.73 5.582 5.582 0 0 0-1.324-.162c-2.236.02-4.597 1.258-5.58 4.602-.092.486-.07.854-.07 1.29 0 6.627 5.373 12 12 12 4.059 0 7.643-2.017 9.815-5.101-1.174.293-2.305.433-3.271.436-.362 0-.702-.02-1.019-.058M15.273 16.952c.074.036.242.097.475.163a6.354 6.354 0 0 0 2.6-5.115h-.002a6.354 6.354 0 0 0-6.345-6.345 6.338 6.338 0 0 0-1.992.324c1.289 1.468 1.908 3.566 2.507 5.862l.001.003c.001.002.192.637.518 1.48.326.842.789 1.885 1.293 2.645.332.51.697.876.945.983M12.001 0a11.98 11.98 0 0 0-9.752 5.013c1.134-.71 2.291-.967 3.301-.957 1.394.004 2.491.436 3.017.732.127.073.248.152.366.233A7.625 7.625 0 0 1 19.625 12a7.605 7.605 0 0 1-2.268 5.425c.344.038.709.063 1.084.061 1.328 0 2.766-.293 3.842-1.198.703-.592 1.291-1.458 1.617-2.757.065-.502.1-1.012.1-1.531 0-6.627-5.371-12-11.999-12" },
  "dart": { title: "Dart", hex: "0175C2", category: "language", path: "M4.105 4.105S9.158 1.58 11.684.316a3.079 3.079 0 0 1 1.481-.315c.766.047 1.677.788 1.677.788L24 9.948v9.789h-4.263V24H9.789l-9-9C.303 14.5 0 13.795 0 13.105c0-.319.18-.818.316-1.105l3.789-7.895zm.679.679v11.787c.002.543.021 1.024.498 1.508L10.204 23h8.533v-4.263L4.784 4.784zm12.055-.678c-.899-.896-1.809-1.78-2.74-2.643-.302-.267-.567-.468-1.07-.462-.37.014-.87.195-.87.195L6.341 4.105l10.498.001z" },
  "lua": { title: "Lua", hex: "000080", category: "language", path: "M.38 10.377l-.272-.037c-.048.344-.082.695-.101 1.041l.275.016c.018-.34.051-.682.098-1.02zM4.136 3.289l-.184-.205c-.258.232-.509.48-.746.734l.202.188c.231-.248.476-.49.728-.717zM5.769 2.059l-.146-.235c-.296.186-.586.385-.863.594l.166.219c.27-.203.554-.399.843-.578zM1.824 18.369c.185.297.384.586.593.863l.22-.164c-.205-.271-.399-.555-.58-.844l-.233.145zM1.127 16.402l-.255.104c.129.318.274.635.431.943l.005.01.245-.125-.005-.01c-.153-.301-.295-.611-.421-.922zM.298 9.309l.269.063c.076-.332.168-.664.272-.986l-.261-.087c-.108.332-.202.672-.28 1.01zM.274 12.42l-.275.01c.012.348.04.699.083 1.043l.273-.033c-.042-.336-.069-.68-.081-1.02zM.256 14.506c.073.34.162.682.264 1.014l.263-.08c-.1-.326-.187-.658-.258-.99l-.269.056zM11.573.275L11.563 0c-.348.012-.699.039-1.044.082l.034.273c.338-.041.68-.068 1.02-.08zM23.221 8.566c.1.326.186.66.256.992l.27-.059c-.072-.34-.16-.682-.262-1.014l-.264.081zM17.621 1.389c-.309-.164-.627-.314-.947-.449l-.107.252c.314.133.625.281.926.439l.128-.242zM15.693.572c-.332-.105-.67-.199-1.01-.277l-.063.268c.332.076.664.168.988.273l.085-.264zM6.674 1.545c.298-.15.606-.291.916-.418L7.486.873c-.317.127-.632.272-.937.428l-.015.008.125.244.015-.008zM23.727 11.588l.275-.01a11.797 11.797 0 0 0-.082-1.045l-.273.033c.041.338.068.682.08 1.022zM13.654.105c-.346-.047-.696-.08-1.043-.098l-.014.273c.339.018.683.051 1.019.098l.038-.273zM9.544.527l-.058-.27c-.34.072-.681.16-1.014.264l.081.262c.325-.099.659-.185.991-.256zM1.921 5.469l.231.15c.185-.285.384-.566.592-.834l-.217-.17c-.213.276-.417.563-.606.854zM.943 7.318l.253.107c.132-.313.28-.625.439-.924l-.243-.128c-.163.307-.314.625-.449.945zM18.223 21.943l.145.234c.295-.186.586-.385.863-.594l-.164-.219c-.272.204-.557.4-.844.579zM21.248 19.219l.217.17c.215-.273.418-.561.607-.854l-.23-.148c-.186.285-.385.564-.594.832zM19.855 20.715l.184.203c.258-.23.51-.479.746-.732l-.201-.188c-.23.248-.477.488-.729.717zM22.359 17.504l.244.129c.162-.307.314-.625.449-.945l-.254-.107a11.27 11.27 0 0 1-.439.923zM23.617 13.629l.273.039c.049-.346.082-.695.102-1.043l-.275-.014c-.018.338-.051.682-.1 1.018zM23.156 15.621l.264.086c.107-.332.201-.67.279-1.01l-.268-.063c-.077.333-.169.665-.275.987zM22.453 6.672c.154.303.297.617.424.932l.256-.104c-.131-.322-.277-.643-.436-.953l-.244.125zM8.296 23.418c.331.107.67.201 1.009.279l.062-.268c-.331-.076-.663-.168-.986-.273l-.085.262zM10.335 23.889c.345.049.696.082 1.043.102l.014-.275c-.339-.018-.682-.051-1.019-.098l-.038.271zM17.326 22.449c-.303.154-.613.297-.926.424l.104.256c.318-.131.639-.275.947-.434l.004-.002-.123-.246-.006.002zM4.613 21.467c.274.213.562.418.854.605l.149-.23c-.285-.184-.565-.385-.833-.592l-.17.217zM12.417 23.725l.009.275c.348-.014.699-.041 1.045-.084l-.035-.271c-.336.041-.68.068-1.019.08zM6.37 22.604c.307.162.625.314.946.449l.107-.254c-.313-.133-.624-.279-.924-.439l-.129.244zM3.083 20.041c.233.258.48.51.734.746l.188-.201c-.249-.23-.49-.477-.717-.729l-.205.184zM14.445 23.475l.059.27c.34-.074.68-.162 1.014-.266l-.082-.262c-.325.099-.659.185-.991.258zM21.18.129A2.689 2.689 0 1 0 21.18 5.507 2.689 2.689 0 1 0 21.18.129zM15.324 15.447c0 .471.314.66.852.66.67 0 1.297-.396 1.297-1.016v-.645c-.23.107-.379.141-1.107.24-.735.109-1.042.306-1.042.761zM12 2.818c-5.07 0-9.18 4.109-9.18 9.18 0 5.068 4.11 9.18 9.18 9.18 5.07 0 9.18-4.111 9.18-9.18 0-5.07-4.11-9.18-9.18-9.18zm-2.487 13.77H5.771v-6.023h.769v5.346h2.974v.677zm4.13 0h-.619v-.67c-.405.57-.811.793-1.446.793-.843 0-1.38-.463-1.38-1.182v-3.271h.686v3c0 .52.347.85.893.85.719 0 1.181-.578 1.181-1.461v-2.389h.686v4.33zm-.53-8.393c0-1.484 1.205-2.689 2.689-2.689s2.688 1.205 2.688 2.689-1.203 2.688-2.688 2.688-2.689-1.203-2.689-2.688zm5.567 7.856v.52c-.223.059-.33.074-.471.074-.34 0-.637-.238-.711-.57-.381.406-.918.637-1.471.637-.877 0-1.422-.463-1.422-1.248 0-.527.256-.916.76-1.123.266-.107.414-.141 1.389-.264.545-.066.719-.191.719-.48v-.182c0-.412-.348-.645-.967-.645-.645 0-.957.24-1.016.77h-.693c.041-1 .686-1.404 1.734-1.404 1.066 0 1.627.412 1.627 1.182v2.412c0 .215.133.338.373.338.041-.002.074-.002.149-.017z" },
  "r": { title: "R", hex: "276DC3", category: "language", path: "M12 2.746c-6.627 0-12 3.599-12 8.037 0 3.897 4.144 7.144 9.64 7.88V16.26c-2.924-.915-4.925-2.755-4.925-4.877 0-3.035 4.084-5.494 9.12-5.494 5.038 0 8.757 1.683 8.757 5.494 0 1.976-.999 3.379-2.662 4.272.09.066.174.128.258.216.169.149.25.363.372.544 2.128-1.45 3.44-3.437 3.44-5.631 0-4.44-5.373-8.038-12-8.038zm-2.111 4.99v13.516l4.093-.002-.002-5.291h1.1c.225 0 .321.066.549.25.272.22.715.982.715.982l2.164 4.063 4.627-.002-2.864-4.826s-.086-.193-.265-.383a2.22 2.22 0 00-.582-.416c-.422-.214-1.149-.434-1.149-.434s3.578-.264 3.578-3.826c0-3.562-3.744-3.63-3.744-3.63zm4.127 2.93l2.478.002s1.149-.062 1.149 1.127c0 1.165-1.149 1.17-1.149 1.17h-2.478zm1.754 6.119c-.494.049-1.012.079-1.54.088v1.807a16.622 16.622 0 002.37-.473l-.471-.891s-.108-.183-.248-.394c-.039-.054-.08-.098-.111-.137z" },
  "julia": { title: "Julia", hex: "9558B2", category: "language", path: "M11.138 17.569a5.569 5.569 0 1 1-11.138 0 5.569 5.569 0 1 1 11.138 0zm6.431-11.138a5.569 5.569 0 1 1-11.138 0 5.569 5.569 0 1 1 11.138 0zM24 17.569a5.569 5.569 0 1 1-11.138 0 5.569 5.569 0 1 1 11.138 0z" },
  "zig": { title: "Zig", hex: "F7A41D", category: "language", path: "m23.53 1.02-7.686 3.45h-7.06l-2.98 3.452h7.173L.47 22.98l7.681-3.607h7.065v-.002l2.978-3.45-7.148-.001 12.482-14.9zM0 4.47v14.901h1.883l2.98-3.45H3.451v-8h.942l2.824-3.45H0zm22.117 0-2.98 3.608h1.412v7.844h-.942l-2.98 3.45H24V4.47h-1.883z" },
  "ocaml": { title: "OCaml", hex: "EC6813", category: "language", path: "M12.178 21.637c-.085-.17-.187-.524-.255-.676-.067-.135-.27-.506-.37-.625-.22-.253-.27-.27-.338-.608-.12-.574-.405-1.588-.76-2.296-.187-.372-.49-.677-.761-.947-.236-.236-.777-.624-.878-.607-.895.169-1.166 1.046-1.587 1.739-.237.388-.473.71-.66 1.115-.167.371-.151.793-.439 1.115a2.952 2.952 0 00-.624 1.097c-.034.084-.101.929-.186 1.131l1.318-.084c1.233.085.877.557 2.787.456l3.022-.1a5.376 5.376 0 00-.27-.71zM20.96 1.539H3.023A3.02 3.02 0 000 4.56v6.587c.44-.152 1.047-1.08 1.25-1.3.337-.389.405-.895.574-1.2.389-.709.456-1.215 1.334-1.215.406 0 .575.1.845.473.186.253.523.743.675 1.064.186.371.474.86.609.962.1.068.185.136.27.17.135.05.253-.051.354-.12.118-.1.17-.286.287-.556.17-.39.339-.827.44-.997.169-.27.236-.608.422-.76.27-.236.641-.253.743-.27.557-.118.81.27 1.08.507.186.168.423.49.609.91.135.339.304.661.388.846.068.185.237.49.338.86.101.322.337.575.44.744 0 0 .152.406 1.03.778a7.505 7.505 0 00.81.286c.39.135.76.12 1.233.068.338 0 .524-.49.676-.878.084-.237.185-.895.236-1.081.05-.185-.085-.32.034-.49.135-.186.22-.203.287-.439.17-.523 1.114-.54 1.655-.54.456 0 .389.44 1.149.287.439-.085.86.05 1.318.185.388.102.76.22.98.473.134.17.489.997.134 1.031.033.033.067.118.118.151-.085.322-.422.085-.625.051-.253-.05-.44 0-.693.118-.439.187-1.063.17-1.452.49-.32.271-.32.861-.473 1.2 0 0-.422 1.063-1.317 1.722-.237.17-.692.574-1.672.726-.44.068-.86.068-1.318.05-.22-.016-.438-.016-.658-.016-.136 0-.575-.017-.558.034l-.05.119a.6.6 0 00.033.169c.017.1.017.185.034.27 0 .185-.017.388 0 .574.017.388.17.743.186 1.148.017.44.236.913.456 1.267.085.135.203.152.254.32.067.186 0 .406.033.609.118.794.355 1.638.71 2.364v.017c.439-.067.895-.236 1.47-.32 1.063-.153 2.532-.085 3.478-.17 2.399-.22 3.7.98 5.844.49V4.562a3.045 3.045 0 00-3.04-3.023zm-8.951 14.187c0-.034 0-.034 0 0zm-6.47 2.769c.17-.372.271-.778.406-1.15.135-.354.337-.86.693-1.046-.05-.05-.744-.068-.929-.085a7.406 7.406 0 01-.608-.084 22.976 22.976 0 01-1.15-.236c-.22-.051-.979-.322-1.13-.39-.39-.168-.642-.658-.93-.607-.185.034-.37.101-.49.287-.1.152-.134.423-.202.608-.084.203-.22.405-.32.608-.238.354-.626.676-.795 1.03-.033.085-.05.169-.084.254v4.07c.202.034.405.068.624.135 1.69.456 2.095.49 3.75.304l.152-.017c.118-.27.22-1.165.304-1.435.067-.22.153-.39.187-.591.033-.203 0-.406-.017-.59-.034-.491.354-.661.54-1.065z" },
  "fsharp": { title: "F#", hex: "378BBA", category: "language", path: "M0 12 11.39.61v5.695L5.695 12l5.695 5.695v5.695L0 12zm7.322 0 4.068-4.068v8.136L7.322 12zM24 12 12.203.61v5.695L17.898 12l-5.695 5.695v5.695L24 12z" },
  "solidity": { title: "Solidity", hex: "363636", category: "language", path: "M4.409 6.608L7.981.255l3.572 6.353H4.409zM8.411 0l3.569 6.348L15.552 0H8.411zm4.036 17.392l3.572 6.354 3.575-6.354h-7.147zm-.608-10.284h-7.43l3.715 6.605 3.715-6.605zm.428-.25h7.428L15.982.255l-3.715 6.603zM15.589 24l-3.569-6.349L8.448 24h7.141zm-3.856-6.858H4.306l3.712 6.603 3.715-6.603zm.428-.25h7.433l-3.718-6.605-3.715 6.605z" },
  "webassembly": { title: "WebAssembly", hex: "654FF0", category: "language", path: "M14.745,0c0,0.042,0,0.085,0,0.129c0,1.52-1.232,2.752-2.752,2.752c-1.52,0-2.752-1.232-2.752-2.752 c0-0.045,0-0.087,0-0.129H0v24h24V0H14.745z M11.454,21.431l-1.169-5.783h-0.02l-1.264,5.783H7.39l-1.824-8.497h1.59l1.088,5.783 h0.02l1.311-5.783h1.487l1.177,5.854h0.02l1.242-5.854h1.561l-2.027,8.497H11.454z M20.209,21.431l-0.542-1.891h-2.861l-0.417,1.891 h-1.59l2.056-8.497h2.509l2.5,8.497H20.209z M17.812,15.028l-0.694,3.118h2.159l-0.796-3.118H17.812z" },
  "html5": { title: "HTML5", hex: "E34F26", category: "language", path: "M1.5 0h21l-1.91 21.563L11.977 24l-8.564-2.438L1.5 0zm7.031 9.75l-.232-2.718 10.059.003.23-2.622L5.412 4.41l.698 8.01h9.126l-.326 3.426-2.91.804-2.955-.81-.188-2.11H6.248l.33 4.171L12 19.351l5.379-1.443.744-8.157H8.531z" },
  "css": { title: "CSS", hex: "663399", category: "language", path: "M0 0v20.16A3.84 3.84 0 0 0 3.84 24h16.32A3.84 3.84 0 0 0 24 20.16V3.84A3.84 3.84 0 0 0 20.16 0Zm14.256 13.08c1.56 0 2.28 1.08 2.304 2.64h-1.608c.024-.288-.048-.6-.144-.84-.096-.192-.288-.264-.552-.264-.456 0-.696.264-.696.84-.024.576.288.888.768 1.08.72.288 1.608.744 1.92 1.296q.432.648.432 1.656c0 1.608-.912 2.592-2.496 2.592-1.656 0-2.4-1.032-2.424-2.688h1.68c0 .792.264 1.176.792 1.176.264 0 .456-.072.552-.24.192-.312.24-1.176-.048-1.512-.312-.408-.912-.6-1.32-.816q-.828-.396-1.224-.936c-.24-.36-.36-.888-.36-1.536 0-1.44.936-2.472 2.424-2.448m5.4 0c1.584 0 2.304 1.08 2.328 2.64h-1.608c0-.288-.048-.6-.168-.84-.096-.192-.264-.264-.528-.264-.48 0-.72.264-.72.84s.288.888.792 1.08c.696.288 1.608.744 1.92 1.296.264.432.408.984.408 1.656.024 1.608-.888 2.592-2.472 2.592-1.68 0-2.424-1.056-2.448-2.688h1.68c0 .744.264 1.176.792 1.176.264 0 .456-.072.552-.24.216-.312.264-1.176-.048-1.512-.288-.408-.888-.6-1.32-.816-.552-.264-.96-.576-1.2-.936s-.36-.888-.36-1.536c-.024-1.44.912-2.472 2.4-2.448m-11.031.018c.711-.006 1.419.198 1.839.63.432.432.672 1.128.648 1.992H9.336c.024-.456-.096-.792-.432-.96-.312-.144-.768-.048-.888.24-.12.264-.192.576-.168.864v3.504c0 .744.264 1.128.768 1.128a.65.65 0 0 0 .552-.264c.168-.24.192-.552.168-.84h1.776c.096 1.632-.984 2.712-2.568 2.688-1.536 0-2.496-.864-2.472-2.472v-4.032c0-.816.24-1.44.696-1.848.432-.408 1.146-.624 1.857-.63" },
  "sass": { title: "Sass", hex: "CC6699", category: "language", path: "M12 0c6.627 0 12 5.373 12 12s-5.373 12-12 12S0 18.627 0 12 5.373 0 12 0zM9.615 15.998c.175.645.156 1.248-.024 1.792l-.065.18c-.024.061-.052.12-.078.176-.14.29-.326.56-.555.81-.698.759-1.672 1.047-2.09.805-.45-.262-.226-1.335.584-2.19.871-.918 2.12-1.509 2.12-1.509v-.003l.108-.061zm9.911-10.861c-.542-2.133-4.077-2.834-7.422-1.645-1.989.707-4.144 1.818-5.693 3.267C4.568 8.48 4.275 9.98 4.396 10.607c.427 2.211 3.457 3.657 4.703 4.73v.006c-.367.18-3.056 1.529-3.686 2.925-.675 1.47.105 2.521.615 2.655 1.575.436 3.195-.36 4.065-1.649.84-1.261.766-2.881.404-3.676.496-.135 1.08-.195 1.83-.104 2.101.24 2.521 1.56 2.43 2.1-.09.539-.523.854-.674.944-.15.091-.195.12-.181.181.015.09.091.09.21.075.165-.03 1.096-.45 1.141-1.471.045-1.29-1.186-2.729-3.375-2.7-.9.016-1.471.091-1.875.256-.03-.045-.061-.075-.105-.105-1.35-1.455-3.855-2.475-3.75-4.41.03-.705.285-2.564 4.8-4.814 3.705-1.846 6.661-1.335 7.171-.21.733 1.604-1.576 4.59-5.431 5.024-1.47.165-2.235-.404-2.431-.615-.209-.225-.239-.24-.314-.194-.12.06-.045.255 0 .375.12.3.585.825 1.396 1.095.704.225 2.43.359 4.5-.45 2.324-.899 4.139-3.405 3.614-5.505l.073.067z" },
  "markdown": { title: "Markdown", hex: "000000", category: "language", path: "M22.27 19.385H1.73A1.73 1.73 0 010 17.655V6.345a1.73 1.73 0 011.73-1.73h20.54A1.73 1.73 0 0124 6.345v11.308a1.73 1.73 0 01-1.73 1.731zM5.769 15.923v-4.5l2.308 2.885 2.307-2.885v4.5h2.308V8.078h-2.308l-2.307 2.885-2.308-2.885H3.46v7.847zM21.232 12h-2.309V8.077h-2.307V12h-2.308l3.461 4.039z" },
  "mdx": { title: "MDX", hex: "1B1F24", category: "language", path: "M.79 7.12h22.42c.436 0 .79.355.79.792v8.176c0 .436-.354.79-.79.79H.79a.79.79 0 0 1-.79-.79V7.912a.79.79 0 0 1 .79-.791V7.12Zm2.507 7.605v-3.122l1.89 1.89L7.12 11.56v3.122h1.055v-5.67l-2.99 2.99L2.24 9.056v5.67h1.055v-.001Zm8.44-1.845-1.474-1.473-.746.746 2.747 2.747 2.745-2.747-.746-.746-1.473 1.473v-4h-1.054v4Zm10.041.987-2.175-2.175 2.22-2.22-.746-.746-2.22 2.22-2.22-2.22-.747.746 2.22 2.22-2.176 2.177.746.746 2.177-2.177 2.176 2.175.745-.746Z" },
  "gnubash": { title: "GNU Bash", hex: "4EAA25", category: "language", path: "M21.038,4.9l-7.577-4.498C13.009,0.134,12.505,0,12,0c-0.505,0-1.009,0.134-1.462,0.403L2.961,4.9 C2.057,5.437,1.5,6.429,1.5,7.503v8.995c0,1.073,0.557,2.066,1.462,2.603l7.577,4.497C10.991,23.866,11.495,24,12,24 c0.505,0,1.009-0.134,1.461-0.402l7.577-4.497c0.904-0.537,1.462-1.529,1.462-2.603V7.503C22.5,6.429,21.943,5.437,21.038,4.9z M15.17,18.946l0.013,0.646c0.001,0.078-0.05,0.167-0.111,0.198l-0.383,0.22c-0.061,0.031-0.111-0.007-0.112-0.085L14.57,19.29 c-0.328,0.136-0.66,0.169-0.872,0.084c-0.04-0.016-0.057-0.075-0.041-0.142l0.139-0.584c0.011-0.046,0.036-0.092,0.069-0.121 c0.012-0.011,0.024-0.02,0.036-0.026c0.022-0.011,0.043-0.014,0.062-0.006c0.229,0.077,0.521,0.041,0.802-0.101 c0.357-0.181,0.596-0.545,0.592-0.907c-0.003-0.328-0.181-0.465-0.613-0.468c-0.55,0.001-1.064-0.107-1.072-0.917 c-0.007-0.667,0.34-1.361,0.889-1.8l-0.007-0.652c-0.001-0.08,0.048-0.168,0.111-0.2l0.37-0.236 c0.061-0.031,0.111,0.007,0.112,0.087l0.006,0.653c0.273-0.109,0.511-0.138,0.726-0.088c0.047,0.012,0.067,0.076,0.048,0.151 l-0.144,0.578c-0.011,0.044-0.036,0.088-0.065,0.116c-0.012,0.012-0.025,0.021-0.038,0.028c-0.019,0.01-0.038,0.013-0.057,0.009 c-0.098-0.022-0.332-0.073-0.699,0.113c-0.385,0.195-0.52,0.53-0.517,0.778c0.003,0.297,0.155,0.387,0.681,0.396 c0.7,0.012,1.003,0.318,1.01,1.023C16.105,17.747,15.736,18.491,15.17,18.946z M19.143,17.859c0,0.06-0.008,0.116-0.058,0.145 l-1.916,1.164c-0.05,0.029-0.09,0.004-0.09-0.056v-0.494c0-0.06,0.037-0.093,0.087-0.122l1.887-1.129 c0.05-0.029,0.09-0.004,0.09,0.056V17.859z M20.459,6.797l-7.168,4.427c-0.894,0.523-1.553,1.109-1.553,2.187v8.833 c0,0.645,0.26,1.063,0.66,1.184c-0.131,0.023-0.264,0.039-0.398,0.039c-0.42,0-0.833-0.114-1.197-0.33L3.226,18.64 c-0.741-0.44-1.201-1.261-1.201-2.142V7.503c0-0.881,0.46-1.702,1.201-2.142l7.577-4.498c0.363-0.216,0.777-0.33,1.197-0.33 c0.419,0,0.833,0.114,1.197,0.33l7.577,4.498c0.624,0.371,1.046,1.013,1.164,1.732C21.686,6.557,21.12,6.411,20.459,6.797z" },
  "openjdk": { title: "OpenJDK", hex: "000000", category: "language", path: "M11.915 0 11.7.215C9.515 2.4 7.47 6.39 6.046 10.483c-1.064 1.024-3.633 2.81-3.711 3.551-.093.87 1.746 2.611 1.55 3.235-.198.625-1.304 1.408-1.014 1.939.1.188.823.011 1.277-.491a13.389 13.389 0 0 0-.017 2.14c.076.906.27 1.668.643 2.232.372.563.956.911 1.667.911.397 0 .727-.114 1.024-.264.298-.149.571-.33.91-.5.68-.34 1.634-.666 3.53-.604 1.903.062 2.872.39 3.559.704.687.314 1.15.664 1.925.664.767 0 1.395-.336 1.807-.9.412-.563.631-1.33.72-2.24.06-.623.055-1.32 0-2.066.454.45 1.117.604 1.213.424.29-.53-.816-1.314-1.013-1.937-.198-.624 1.642-2.366 1.549-3.236-.08-.748-2.707-2.568-3.748-3.586C16.428 6.374 14.308 2.394 12.13.215zm.175 6.038a2.95 2.95 0 0 1 2.943 2.942 2.95 2.95 0 0 1-2.943 2.943A2.95 2.95 0 0 1 9.148 8.98a2.95 2.95 0 0 1 2.942-2.942zM8.685 7.983a3.515 3.515 0 0 0-.145.997c0 1.951 1.6 3.55 3.55 3.55 1.95 0 3.55-1.598 3.55-3.55 0-.329-.046-.648-.132-.951.334.095.64.208.915.336a42.699 42.699 0 0 1 2.042 5.829c.678 2.545 1.01 4.92.846 6.607-.082.844-.29 1.51-.606 1.94-.315.431-.713.651-1.315.651-.593 0-.932-.27-1.673-.61-.741-.338-1.825-.694-3.792-.758-1.974-.064-3.073.293-3.821.669-.375.188-.659.373-.911.5s-.466.2-.752.2c-.53 0-.876-.209-1.16-.64-.285-.43-.474-1.101-.545-1.948-.141-1.693.176-4.069.823-6.614a43.155 43.155 0 0 1 1.934-5.783c.348-.167.749-.31 1.192-.425zm-3.382 4.362a.216.216 0 0 1 .13.031c-.166.56-.323 1.116-.463 1.665a33.849 33.849 0 0 0-.547 2.555 3.9 3.9 0 0 0-.2-.39c-.58-1.012-.914-1.642-1.16-2.08.315-.24 1.679-1.755 2.24-1.781zm13.394.01c.562.027 1.926 1.543 2.24 1.783-.246.438-.58 1.068-1.16 2.08a4.428 4.428 0 0 0-.163.309 32.354 32.354 0 0 0-.562-2.49 40.579 40.579 0 0 0-.482-1.652.216.216 0 0 1 .127-.03z" },
  "latex": { title: "LaTeX", hex: "008080", category: "language", path: "M2.176 2.814c.233.42.476.78.73 1.09.247-.013 1.132.456 1.312.523.508.282 1.063.63 1.567.966.505.337.96.662 1.272.9.156.12.278.218.352.286a.483.483 0 01.078.082.08.08 0 01.01.021.06.06 0 01-.004.047.057.057 0 01-.04.03.077.077 0 01-.028 0c-.057 0-.203-.163-.497-.415a23.474 23.474 0 00-2.759-1.827c-.504-.28-.956-.542-1.264-.613a2.322 2.322 0 00-.36-.025 2.706 2.706 0 00-.788.133c.494.414.91.716 1.28.949-.57-.182-1.182-.21-1.902.133.526.329.967.567 1.354.745 1.103.156 2.258.696 3.224 1.309.483.307.904.615 1.219.867.157.125.29.237.39.328.098.091.174.154.197.21.03.073-.019.104-.084.058-.032-.022-.088-.102-.184-.191a7.35 7.35 0 00-.384-.327c-.312-.25-.729-.552-1.209-.857-.893-.562-2.232-1.013-3.173-1.397-.602-.11-1.225-.06-1.906.39.449.2.837.349 1.182.463.812 0 1.892.365 2.935.922 1.042.556 2.04 1.214 2.523 1.774.066.077-.016.126-.074.07-.52-.495-1.463-1.204-2.498-1.756-.639-.337-2.153-1.01-2.886-1.01l.004.002c-.567.02-1.13.195-1.679.716.477.118.885.196 1.244.249-.44.088-.87.3-1.289.722.324.07.616.122.882.162-.328.159-.639.404-.923.78.373.03.703.042 1 .044-.36.166-.696.43-.996.85.533.027.98.025 1.364.003-.422.172-.812.464-1.145.968.662.01 1.188-.022 1.628-.076l-.006.002c.99-.073 2.297.127 2.962.847.052.057-.024.118-.072.074-.648-.58-1.493-.827-2.89-.921h-.002c-.543.149-1.046.446-1.46 1.074.536.008.982-.013 1.366-.05-.469.257-.873.644-1.139 1.306.483-.092.888-.19 1.237-.292-.363.265-.668.636-.873 1.194.324-.072.612-.146.871-.221a2.519 2.519 0 00-.513 1.095c.352-.13.655-.254.926-.377-.257.3-.453.681-.55 1.19.495-.199.899-.388 1.238-.568-.31.333-.543.76-.635 1.356a11.816 11.816 0 001.442-.744c-.433.362-.764.843-.879 1.587.788-.348 1.339-.663 1.767-.955-.184.372-.282.806-.235 1.348.762-.584 1.243-1.056 1.602-1.473-.024.269-.003.56.077.884.546-.939 1.089-1.212 1.65-1.526-.895.451-.762.79-.762 1.184.683-.72 1.635-1.482 1.927-1.96-.39.585-.547 1.14-.65 1.63-1.993 1.054-3.207 1.329-4.568 1.75.528.194 1.093.383.859.652l-.624.622c.399-.124.805-.3 1.158-.059-.035.327-.447.492-.8.683.621-.224.756-.172.92-.12.081.393-.203.603-.388.862 1.565-1.19 3.606-2.13 5.044-2.522 2.022-.681 4.63-1.389 5.339-3.115l.712-2.847-.004.004c-.111-.034-.246-.063-.35-.133a.651.651 0 01-.235-.297c-.252.065-.44.03-.56-.088-.117-.117-.167-.296-.203-.491-.203.041-.362.016-.467-.077-.116-.101-.17-.26-.198-.444l-.008-.039.037-.015a.842.842 0 00.302-.194.257.257 0 00.07-.225l-.006-.037.03-.016c.163-.093.345-.169.428-.28a.274.274 0 00.053-.21.88.88 0 00-.155-.357l-.027-.04.04-.027c.118-.09.244-.179.308-.26.032-.04.048-.076.047-.11 0-.033-.015-.07-.064-.117l-.098-.094.135.006c.213.01.395-.007.538-.053a.504.504 0 00.274-.197c-.007-.033-.02-.063-.02-.098a.484.484 0 01.967 0c0 .044-.015.084-.026.125.177.014.347.01.507-.06l.002.001.035-.013c.236-.085.334.045.72-.456-1.69-2.19-4.157-.635-4.977 1.622-.21.576-1.405.578-1.751 0-1.37-2.95-5.53-6.068-9.07-7.218zm.86 2.145c.906.293 1.913.782 2.77 1.328.43.273.813.543 1.114.779.301.236.566.473.62.575.054.102 0 .14-.082.06-.081-.078-.303-.32-.6-.553-.298-.234-.68-.505-1.106-.777-.775-.49-1.982-.958-2.716-1.412zm-1.7 2.7c1.116.014 2.35.447 3.434.997.541.275 1.023.567 1.395.83.372.263.672.524.734.657.061.134-.02.13-.087.055a4.401 4.401 0 00-.704-.626 11.47 11.47 0 00-1.385-.826C3.76 8.264 2.439 7.82 1.336 7.66zm14.916.772a.381.381 0 100 .762.381.381 0 000-.762zM1.7 8.478c.822.072 1.72.368 2.534.75 1.086.509 2.035 1.158 2.434 1.667.035.045-.014.131-.08.062-.428-.44-1.322-1.131-2.397-1.635-.913-.421-2.282-.87-3.262-.78.251-.03.497-.088.771-.064zm16.339.01c-.366.475-.53.423-.703.464.094.43.35.586.585.77l-.06.012c2.315-.447 4.186-.286 6.139-.236l-5.961-1.01zm-.178 1.246h-.002l-.004.016.006-.016zm-.625-.757c-.183.074-.373.076-.563.059a.477.477 0 01-.42.26.483.483 0 01-.435-.278.609.609 0 01-.274.188c-.139.045-.308.057-.493.055.02.035.054.068.055.104a.273.273 0 01-.069.174c-.073.092-.189.17-.295.248.087.141.137.26.149.362a.39.39 0 01-.07.284c-.106.14-.288.21-.439.293a.374.374 0 01-.09.268.89.89 0 01-.297.198c.027.156.074.283.154.354.086.076.211.103.425.047l.055-.014.01.055c.033.207.088.385.187.483.1.099.244.135.503.055l.049-.015.016.048c.05.142.12.223.209.282.087.06.247.112.358.147.798-.869 1.525-1.772 1.884-2.86-.225-.177-.506-.338-.609-.797zm-16.23.386c1.165-.08 2.283.196 3.202.626.92.43 1.658.939 1.974 1.307.075.087-.019.12-.072.072a8.187 8.187 0 00-1.947-1.29c-.904-.414-2.193-.644-3.157-.715zm.864.802c.61.02 1.24.155 1.806.352.756.262 1.421.614 1.747.98.045.05-.007.127-.074.069-.349-.304-.961-.693-1.706-.951-.574-.195-1.613-.369-2.268-.397.197-.022.292-.06.495-.053zm1.05 1.788c.423.034.886.133 1.341.407.043.026.049.136-.049.09-.856-.402-1.326-.49-2.457-.31.386-.128.74-.221 1.164-.187zm-.04.788c.4-.035.784-.002 1.297.204.044.018.08.126-.033.094-.857-.243-1.167-.328-2.287.104.28-.229.622-.366 1.023-.402zm1.285.687c.317-.023.635-.026.934.006.052.006.055.105-.006.102a7.87 7.87 0 00-1.837.115c-.243.046-.423.043-1.405.458.287-.233.794-.452 1.385-.56a8.91 8.91 0 01.93-.12zm1.28.49c.099.003.062.104.006.103-.728-.01-1.304.132-1.875.295a9.78 9.78 0 00-1.318.525c.283-.23.713-.457 1.291-.622.579-.166 1.248-.326 1.896-.302zm.528.398c.036-.005.105.084.018.1-.73.137-1.244.267-1.794.454-.216.074-.58.207-1.243.587.26-.269.656-.492 1.213-.68.558-.19 1.196-.37 1.806-.46zm.311.507c.075-.012.097.087.02.102-1.217.241-1.76.556-2.54 1.144.504-.523 1.297-1.051 2.52-1.246zm.595.448c.087-.013.11.087.021.1-.872.13-1.477.553-2.255 1.33.295-.493 1.004-1.24 2.234-1.43zm.372.39c.046-.006.114.073.023.1a2.634 2.634 0 00-.669.3c-.182.118-.3.2-.597.507.111-.245.296-.434.542-.59.247-.157.509-.293.7-.317z" },
  "react": { title: "React", hex: "61DAFB", category: "framework", path: "M14.23 12.004a2.236 2.236 0 0 1-2.235 2.236 2.236 2.236 0 0 1-2.236-2.236 2.236 2.236 0 0 1 2.235-2.236 2.236 2.236 0 0 1 2.236 2.236zm2.648-10.69c-1.346 0-3.107.96-4.888 2.622-1.78-1.653-3.542-2.602-4.887-2.602-.41 0-.783.093-1.106.278-1.375.793-1.683 3.264-.973 6.365C1.98 8.917 0 10.42 0 12.004c0 1.59 1.99 3.097 5.043 4.03-.704 3.113-.39 5.588.988 6.38.32.187.69.275 1.102.275 1.345 0 3.107-.96 4.888-2.624 1.78 1.654 3.542 2.603 4.887 2.603.41 0 .783-.09 1.106-.275 1.374-.792 1.683-3.263.973-6.365C22.02 15.096 24 13.59 24 12.004c0-1.59-1.99-3.097-5.043-4.032.704-3.11.39-5.587-.988-6.38-.318-.184-.688-.277-1.092-.278zm-.005 1.09v.006c.225 0 .406.044.558.127.666.382.955 1.835.73 3.704-.054.46-.142.945-.25 1.44-.96-.236-2.006-.417-3.107-.534-.66-.905-1.345-1.727-2.035-2.447 1.592-1.48 3.087-2.292 4.105-2.295zm-9.77.02c1.012 0 2.514.808 4.11 2.28-.686.72-1.37 1.537-2.02 2.442-1.107.117-2.154.298-3.113.538-.112-.49-.195-.964-.254-1.42-.23-1.868.054-3.32.714-3.707.19-.09.4-.127.563-.132zm4.882 3.05c.455.468.91.992 1.36 1.564-.44-.02-.89-.034-1.345-.034-.46 0-.915.01-1.36.034.44-.572.895-1.096 1.345-1.565zM12 8.1c.74 0 1.477.034 2.202.093.406.582.802 1.203 1.183 1.86.372.64.71 1.29 1.018 1.946-.308.655-.646 1.31-1.013 1.95-.38.66-.773 1.288-1.18 1.87-.728.063-1.466.098-2.21.098-.74 0-1.477-.035-2.202-.093-.406-.582-.802-1.204-1.183-1.86-.372-.64-.71-1.29-1.018-1.946.303-.657.646-1.313 1.013-1.954.38-.66.773-1.286 1.18-1.868.728-.064 1.466-.098 2.21-.098zm-3.635.254c-.24.377-.48.763-.704 1.16-.225.39-.435.782-.635 1.174-.265-.656-.49-1.31-.676-1.947.64-.15 1.315-.283 2.015-.386zm7.26 0c.695.103 1.365.23 2.006.387-.18.632-.405 1.282-.66 1.933-.2-.39-.41-.783-.64-1.174-.225-.392-.465-.774-.705-1.146zm3.063.675c.484.15.944.317 1.375.498 1.732.74 2.852 1.708 2.852 2.476-.005.768-1.125 1.74-2.857 2.475-.42.18-.88.342-1.355.493-.28-.958-.646-1.956-1.1-2.98.45-1.017.81-2.01 1.085-2.964zm-13.395.004c.278.96.645 1.957 1.1 2.98-.45 1.017-.812 2.01-1.086 2.964-.484-.15-.944-.318-1.37-.5-1.732-.737-2.852-1.706-2.852-2.474 0-.768 1.12-1.742 2.852-2.476.42-.18.88-.342 1.356-.494zm11.678 4.28c.265.657.49 1.312.676 1.948-.64.157-1.316.29-2.016.39.24-.375.48-.762.705-1.158.225-.39.435-.788.636-1.18zm-9.945.02c.2.392.41.783.64 1.175.23.39.465.772.705 1.143-.695-.102-1.365-.23-2.006-.386.18-.63.406-1.282.66-1.933zM17.92 16.32c.112.493.2.968.254 1.423.23 1.868-.054 3.32-.714 3.708-.147.09-.338.128-.563.128-1.012 0-2.514-.807-4.11-2.28.686-.72 1.37-1.536 2.02-2.44 1.107-.118 2.154-.3 3.113-.54zm-11.83.01c.96.234 2.006.415 3.107.532.66.905 1.345 1.727 2.035 2.446-1.595 1.483-3.092 2.295-4.11 2.295-.22-.005-.406-.05-.553-.132-.666-.38-.955-1.834-.73-3.703.054-.46.142-.944.25-1.438zm4.56.64c.44.02.89.034 1.345.034.46 0 .915-.01 1.36-.034-.44.572-.895 1.095-1.345 1.565-.455-.47-.91-.993-1.36-1.565z" },
  "nextdotjs": { title: "Next.js", hex: "000000", category: "framework", path: "M18.665 21.978C16.758 23.255 14.465 24 12 24 5.377 24 0 18.623 0 12S5.377 0 12 0s12 5.377 12 12c0 3.583-1.574 6.801-4.067 9.001L9.219 7.2H7.2v9.596h1.615V9.251l9.85 12.727Zm-3.332-8.533 1.6 2.061V7.2h-1.6v6.245Z" },
  "vuedotjs": { title: "Vue.js", hex: "4FC08D", category: "framework", path: "M24,1.61H14.06L12,5.16,9.94,1.61H0L12,22.39ZM12,14.08,5.16,2.23H9.59L12,6.41l2.41-4.18h4.43Z" },
  "nuxt": { title: "Nuxt", hex: "00DC82", category: "framework", path: "M13.4642 19.8295h8.9218c.2834 0 .5618-.0723.8072-.2098a1.5899 1.5899 0 0 0 .5908-.5732 1.5293 1.5293 0 0 0 .216-.783 1.529 1.529 0 0 0-.2167-.7828L17.7916 7.4142a1.5904 1.5904 0 0 0-.5907-.573 1.6524 1.6524 0 0 0-.807-.2099c-.2833 0-.5616.0724-.807.2098a1.5904 1.5904 0 0 0-.5907.5731L13.4642 9.99l-2.9954-5.0366a1.5913 1.5913 0 0 0-.591-.573 1.6533 1.6533 0 0 0-.8071-.2098c-.2834 0-.5617.0723-.8072.2097a1.5913 1.5913 0 0 0-.591.573L.2168 17.4808A1.5292 1.5292 0 0 0 0 18.2635c-.0001.2749.0744.545.216.783a1.59 1.59 0 0 0 .5908.5732c.2454.1375.5238.2098.8072.2098h5.6003c2.219 0 3.8554-.9454 4.9813-2.7899l2.7337-4.5922L16.3935 9.99l4.3944 7.382h-5.8586ZM7.123 17.3694l-3.9083-.0009 5.8586-9.8421 2.9232 4.921-1.9572 3.2892c-.7478 1.1967-1.5972 1.6328-2.9163 1.6328z" },
  "svelte": { title: "Svelte", hex: "FF3E00", category: "framework", path: "M10.354 21.125a4.44 4.44 0 0 1-4.765-1.767 4.109 4.109 0 0 1-.703-3.107 3.898 3.898 0 0 1 .134-.522l.105-.321.287.21a7.21 7.21 0 0 0 2.186 1.092l.208.063-.02.208a1.253 1.253 0 0 0 .226.83 1.337 1.337 0 0 0 1.435.533 1.231 1.231 0 0 0 .343-.15l5.59-3.562a1.164 1.164 0 0 0 .524-.778 1.242 1.242 0 0 0-.211-.937 1.338 1.338 0 0 0-1.435-.533 1.23 1.23 0 0 0-.343.15l-2.133 1.36a4.078 4.078 0 0 1-1.135.499 4.44 4.44 0 0 1-4.765-1.766 4.108 4.108 0 0 1-.702-3.108 3.855 3.855 0 0 1 1.742-2.582l5.589-3.563a4.072 4.072 0 0 1 1.135-.499 4.44 4.44 0 0 1 4.765 1.767 4.109 4.109 0 0 1 .703 3.107 3.943 3.943 0 0 1-.134.522l-.105.321-.286-.21a7.204 7.204 0 0 0-2.187-1.093l-.208-.063.02-.207a1.255 1.255 0 0 0-.226-.831 1.337 1.337 0 0 0-1.435-.532 1.231 1.231 0 0 0-.343.15L8.62 9.368a1.162 1.162 0 0 0-.524.778 1.24 1.24 0 0 0 .211.937 1.338 1.338 0 0 0 1.435.533 1.235 1.235 0 0 0 .344-.151l2.132-1.36a4.067 4.067 0 0 1 1.135-.498 4.44 4.44 0 0 1 4.765 1.766 4.108 4.108 0 0 1 .702 3.108 3.857 3.857 0 0 1-1.742 2.583l-5.589 3.562a4.072 4.072 0 0 1-1.135.499m10.358-17.95C18.484-.015 14.082-.96 10.9 1.068L5.31 4.63a6.412 6.412 0 0 0-2.896 4.295 6.753 6.753 0 0 0 .666 4.336 6.43 6.43 0 0 0-.96 2.396 6.833 6.833 0 0 0 1.168 5.167c2.229 3.19 6.63 4.135 9.812 2.108l5.59-3.562a6.41 6.41 0 0 0 2.896-4.295 6.756 6.756 0 0 0-.665-4.336 6.429 6.429 0 0 0 .958-2.396 6.831 6.831 0 0 0-1.167-5.168Z" },
  "angular": { title: "Angular", hex: "0F0F11", category: "framework", path: "M16.712 17.711H7.288l-1.204 2.916L12 24l5.916-3.373-1.204-2.916ZM14.692 0l7.832 16.855.814-12.856L14.692 0ZM9.308 0 .662 3.999l.814 12.856L9.308 0Zm-.405 13.93h6.198L12 6.396 8.903 13.93Z" },
  "solid": { title: "Solid", hex: "2C4F7C", category: "framework", path: "M11.558.788A9.082 9.082 0 0 0 9.776.99l-.453.15c-.906.303-1.656.755-2.1 1.348l-.301.452-2.035 3.528c.426-.387.974-.698 1.643-.894h.001l.613-.154h.001a8.82 8.82 0 0 1 1.777-.206c2.916-.053 6.033 1.148 8.423 2.36 2.317 1.175 3.888 2.32 3.987 2.39L24 5.518c-.082-.06-1.66-1.21-3.991-2.386-2.393-1.206-5.521-2.396-8.45-2.343zM8.924 5.366a8.634 8.634 0 0 0-1.745.203l-.606.151c-1.278.376-2.095 1.16-2.43 2.108-.334.948-.188 2.065.487 3.116.33.43.747.813 1.216 1.147L12.328 10h.001a6.943 6.943 0 0 1 6.013 1.013l2.844-.963c-.17-.124-1.663-1.2-3.91-2.34-2.379-1.206-5.479-2.396-8.352-2.344zm5.435 4.497a6.791 6.791 0 0 0-1.984.283L2.94 13.189 0 18.334l9.276-2.992a6.945 6.945 0 0 1 7.408 2.314v.001c.695.903.89 1.906.66 2.808l2.572-4.63c.595-1.041.45-2.225-.302-3.429a6.792 6.792 0 0 0-5.255-2.543zm-3.031 5.341a6.787 6.787 0 0 0-2.006.283L.008 18.492c.175.131 2.02 1.498 4.687 2.768 2.797 1.332 6.37 2.467 9.468 1.712l.454-.152h.002c1.278-.376 2.134-1.162 2.487-2.09.353-.93.207-2.004-.541-2.978a6.791 6.791 0 0 0-5.237-2.548z" },
  "astro": { title: "Astro", hex: "BC52EE", category: "framework", path: "M8.358 20.162c-1.186-1.07-1.532-3.316-1.038-4.944.856 1.026 2.043 1.352 3.272 1.535 1.897.283 3.76.177 5.522-.678.202-.098.388-.229.608-.36.166.473.209.95.151 1.437-.14 1.185-.738 2.1-1.688 2.794-.38.277-.782.525-1.175.787-1.205.804-1.531 1.747-1.078 3.119l.044.148a3.158 3.158 0 0 1-1.407-1.188 3.31 3.31 0 0 1-.544-1.815c-.004-.32-.004-.642-.048-.958-.106-.769-.472-1.113-1.161-1.133-.707-.02-1.267.411-1.415 1.09-.012.053-.028.104-.045.165h.002zm-5.961-4.445s3.24-1.575 6.49-1.575l2.451-7.565c.092-.366.36-.614.662-.614.302 0 .57.248.662.614l2.45 7.565c3.85 0 6.491 1.575 6.491 1.575L16.088.727C15.93.285 15.663 0 15.303 0H8.697c-.36 0-.615.285-.784.727l-5.516 14.99z" },
  "remix": { title: "Remix", hex: "000000", category: "framework", path: "M21.511 18.508c.216 2.773.216 4.073.216 5.492H15.31c0-.309.006-.592.011-.878.018-.892.036-1.821-.109-3.698-.19-2.747-1.374-3.358-3.55-3.358H1.574v-5h10.396c2.748 0 4.122-.835 4.122-3.049 0-1.946-1.374-3.125-4.122-3.125H1.573V0h11.541c6.221 0 9.313 2.938 9.313 7.632 0 3.511-2.176 5.8-5.114 6.182 2.48.497 3.93 1.909 4.198 4.694ZM1.573 24v-3.727h6.784c1.133 0 1.379.84 1.379 1.342V24Z" },
  "vite": { title: "Vite", hex: "9135FF", category: "framework", path: "M13.056 23.238a.57.57 0 0 1-1.02-.355v-5.202c0-.63-.512-1.143-1.144-1.143H5.148a.57.57 0 0 1-.464-.903l3.777-5.29c.54-.753 0-1.804-.93-1.804H.57a.574.574 0 0 1-.543-.746.6.6 0 0 1 .08-.157L5.008.78a.57.57 0 0 1 .467-.24h14.589a.57.57 0 0 1 .466.903l-3.778 5.29c-.54.755 0 1.806.93 1.806h5.745c.238 0 .424.138.513.322a.56.56 0 0 1-.063.603z" },
  "webpack": { title: "Webpack", hex: "8DD6F9", category: "framework", path: "M22.1987 18.498l-9.7699 5.5022v-4.2855l6.0872-3.3338 3.6826 2.117zm.6683-.6026V6.3884l-3.5752 2.0544v7.396zm-21.0657.6026l9.7699 5.5022v-4.2855L5.484 16.3809l-3.6826 2.117zm-.6683-.6026V6.3884l3.5751 2.0544v7.396zm.4183-12.2515l10.0199-5.644v4.1434L5.152 7.6586l-.0489.028zm20.8975 0l-10.02-5.644v4.1434l6.4192 3.5154.0489.028 3.5518-2.0427zm-10.8775 13.096l-6.0056-3.2873V8.9384l6.0054 3.4525v6.349zm.8575 0l6.0053-3.2873V8.9384l-6.0053 3.4525zM5.9724 8.1845l6.0287-3.3015L18.03 8.1845l-6.0288 3.4665z" },
  "esbuild": { title: "esbuild", hex: "FFCF00", category: "framework", path: "M12 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0zM6.718 5.282L13.436 12l-6.718 6.718-2.036-2.036L9.364 12 4.682 7.318zm7.2 0L20.636 12l-6.718 6.718-2.036-2.036L16.564 12l-4.682-4.682z" },
  "tailwindcss": { title: "Tailwind CSS", hex: "06B6D4", category: "framework", path: "M12.001,4.8c-3.2,0-5.2,1.6-6,4.8c1.2-1.6,2.6-2.2,4.2-1.8c0.913,0.228,1.565,0.89,2.288,1.624 C13.666,10.618,15.027,12,18.001,12c3.2,0,5.2-1.6,6-4.8c-1.2,1.6-2.6,2.2-4.2,1.8c-0.913-0.228-1.565-0.89-2.288-1.624 C16.337,6.182,14.976,4.8,12.001,4.8z M6.001,12c-3.2,0-5.2,1.6-6,4.8c1.2-1.6,2.6-2.2,4.2-1.8c0.913,0.228,1.565,0.89,2.288,1.624 c1.177,1.194,2.538,2.576,5.512,2.576c3.2,0,5.2-1.6,6-4.8c-1.2,1.6-2.6,2.2-4.2,1.8c-0.913-0.228-1.565-0.89-2.288-1.624 C10.337,13.382,8.976,12,6.001,12z" },
  "bootstrap": { title: "Bootstrap", hex: "7952B3", category: "framework", path: "M11.77 11.24H9.956V8.202h2.152c1.17 0 1.834.522 1.834 1.466 0 1.008-.773 1.572-2.174 1.572zm.324 1.206H9.957v3.348h2.231c1.459 0 2.232-.585 2.232-1.685s-.795-1.663-2.326-1.663zM24 11.39v1.218c-1.128.108-1.817.944-2.226 2.268-.407 1.319-.463 2.937-.42 4.186.045 1.3-.968 2.5-2.337 2.5H4.985c-1.37 0-2.383-1.2-2.337-2.5.043-1.249-.013-2.867-.42-4.186-.41-1.324-1.1-2.16-2.228-2.268V11.39c1.128-.108 1.819-.944 2.227-2.268.408-1.319.464-2.937.42-4.186-.045-1.3.968-2.5 2.338-2.5h14.032c1.37 0 2.382 1.2 2.337 2.5-.043 1.249.013 2.867.42 4.186.409 1.324 1.098 2.16 2.226 2.268zm-7.927 2.817c0-1.354-.953-2.333-2.368-2.488v-.057c1.04-.169 1.856-1.135 1.856-2.213 0-1.537-1.213-2.538-3.062-2.538h-4.16v10.172h4.181c2.218 0 3.553-1.086 3.553-2.876z" },
  "shadcnui": { title: "shadcn/ui", hex: "000000", category: "framework", path: "M22.219 11.784 11.784 22.219c-.407.407-.407 1.068 0 1.476.407.407 1.068.407 1.476 0L23.695 13.26c.407-.408.407-1.069 0-1.476-.408-.407-1.069-.407-1.476 0ZM20.132.305.305 20.132c-.407.407-.407 1.068 0 1.476.408.407 1.069.407 1.476 0L21.608 1.781c.407-.407.407-1.068 0-1.476-.408-.407-1.069-.407-1.476 0Z" },
  "redux": { title: "Redux", hex: "764ABC", category: "framework", path: "M16.634 16.504c.87-.075 1.543-.84 1.5-1.754-.047-.914-.796-1.648-1.709-1.648h-.061a1.71 1.71 0 00-1.648 1.769c.03.479.226.869.494 1.153-1.048 2.038-2.621 3.536-5.005 4.795-1.603.838-3.296 1.154-4.944.93-1.378-.195-2.456-.81-3.116-1.799-.988-1.499-1.078-3.116-.255-4.734.6-1.17 1.499-2.023 2.099-2.443a9.96 9.96 0 01-.42-1.543C-.868 14.408-.416 18.752.932 20.805c1.004 1.498 3.057 2.456 5.304 2.456.6 0 1.23-.044 1.843-.194 3.897-.749 6.848-3.086 8.541-6.532zm5.348-3.746c-2.32-2.728-5.738-4.226-9.634-4.226h-.51c-.253-.554-.837-.899-1.498-.899h-.045c-.943 0-1.678.81-1.647 1.753.03.898.794 1.648 1.708 1.648h.074a1.69 1.69 0 001.499-1.049h.555c2.309 0 4.495.674 6.488 1.992 1.527 1.005 2.622 2.323 3.237 3.897.538 1.288.509 2.547-.045 3.597-.855 1.647-2.294 2.517-4.196 2.517-1.199 0-2.367-.375-2.967-.644-.36.298-.96.793-1.394 1.093 1.318.598 2.652.943 3.94.943 2.922 0 5.094-1.647 5.919-3.236.898-1.798.824-4.824-1.47-7.416zM6.49 17.042c.03.899.793 1.648 1.708 1.648h.06a1.688 1.688 0 001.648-1.768c0-.9-.779-1.647-1.693-1.647h-.06c-.06 0-.15 0-.226.029-1.243-2.098-1.768-4.347-1.572-6.772.12-1.828.72-3.417 1.797-4.735.9-1.124 2.593-1.68 3.747-1.708 3.236-.061 4.585 3.971 4.689 5.574l1.498.45C17.741 3.197 14.686.62 11.764.62 9.02.62 6.49 2.613 5.47 5.535 4.077 9.43 4.991 13.177 6.7 16.174c-.15.195-.24.539-.21.868z" },
  "threedotjs": { title: "Three.js", hex: "000000", category: "framework", path: "M.38 0a.268.268 0 0 0-.256.332l2.894 11.716a.268.268 0 0 0 .01.04l2.89 11.708a.268.268 0 0 0 .447.128L23.802 7.15a.268.268 0 0 0-.112-.45l-5.784-1.667a.268.268 0 0 0-.123-.035L6.38 1.715a.268.268 0 0 0-.144-.04L.456.01A.268.268 0 0 0 .38 0zm.374.654L5.71 2.08 1.99 5.664zM6.61 2.34l4.864 1.4-3.65 3.515zm-.522.12l1.217 4.926-4.877-1.4zm6.28 1.538l4.878 1.404-3.662 3.53zm-.52.13l1.208 4.9-4.853-1.392zm6.3 1.534l4.947 1.424-3.715 3.574zm-.524.12l1.215 4.926-4.876-1.398zm-15.432.696l4.964 1.424-3.726 3.586zM8.047 8.15l4.877 1.4-3.66 3.527zm-.518.137l1.236 5.017-4.963-1.432zm6.274 1.535l4.965 1.425-3.73 3.586zm-.52.127l1.235 5.012-4.958-1.43zm-9.63 2.438l4.873 1.406-3.656 3.523zm5.854 1.687l4.863 1.403-3.648 3.51zm-.54.04l1.214 4.927-4.875-1.4zm-3.896 4.02l5.037 1.442-3.782 3.638z" },
  "d3": { title: "D3", hex: "F9A03C", category: "framework", path: "M13.312 12C13.312 5.718 8.22.625 1.937.625H0v5h1.938c3.521 0 6.375 2.854 6.375 6.375s-2.854 6.375-6.375 6.375H0v5h1.938c6.281 0 11.374-5.093 11.374-11.375zM24 7.563C24 3.731 20.893.625 17.062.625h-8a13.4154 13.4154 0 0 1 4.686 5h3.314c1.069 0 1.938.868 1.938 1.938 0 1.07-.869 1.938-1.938 1.938h-1.938c.313 1.652.313 3.348 0 5h1.938c1.068 0 1.938.867 1.938 1.938s-.869 1.938-1.938 1.938h-3.314a13.4154 13.4154 0 0 1-4.686 5h8c1.621 0 3.191-.568 4.438-1.605 2.943-2.45 3.346-6.824.895-9.77A6.9459 6.9459 0 0 0 24 7.563z" },
  "jquery": { title: "jQuery", hex: "0769AD", category: "framework", path: "M1.525 5.87c-2.126 3.054-1.862 7.026-.237 10.269.037.079.078.154.118.229.023.052.049.1.077.15.013.027.031.056.047.082.026.052.054.102.081.152l.157.266c.03.049.057.097.09.146.056.094.12.187.178.281.026.04.05.078.079.117a6.368 6.368 0 00.31.445c.078.107.156.211.24.315.027.038.058.076.086.115l.22.269c.028.03.055.067.084.099.098.118.202.233.306.35l.005.006a3.134 3.134 0 00.425.44c.08.083.16.165.245.245l.101.097c.111.105.223.209.34.309.002 0 .003.002.005.003l.057.05c.102.089.205.178.31.26l.125.105c.085.068.174.133.26.2l.137.105c.093.07.192.139.287.207.035.025.07.05.106.073l.03.023.28.185.12.08c.148.094.294.184.44.272.041.02.084.044.123.068.108.062.22.125.329.183.06.034.122.063.184.094.075.042.153.083.234.125a.324.324 0 01.056.023c.033.015.064.031.096.047.12.06.245.118.375.175.024.01.05.02.076.034.144.063.289.123.438.182.034.01.07.027.105.04.135.051.274.103.411.152l.05.018c.154.052.305.102.46.15.036.01.073.023.111.033.16.048.314.105.474.137 10.273 1.872 13.258-6.177 13.258-6.177-2.508 3.266-6.958 4.127-11.174 3.169-.156-.036-.312-.086-.47-.132a13.539 13.539 0 01-.567-.182l-.062-.024c-.136-.046-.267-.097-.4-.148a1.615 1.615 0 00-.11-.04c-.148-.06-.29-.121-.433-.184-.031-.01-.057-.024-.088-.036a23.44 23.44 0 01-.362-.17 1.485 1.485 0 01-.106-.052c-.094-.044-.188-.095-.28-.143a3.947 3.947 0 01-.187-.096c-.114-.06-.227-.125-.34-.187-.034-.024-.073-.044-.112-.066a15.922 15.922 0 01-.439-.27 2.107 2.107 0 01-.118-.078 6.01 6.01 0 01-.312-.207c-.035-.023-.067-.048-.103-.073a9.553 9.553 0 01-.295-.212c-.042-.034-.087-.066-.132-.1-.088-.07-.177-.135-.265-.208l-.118-.095a10.593 10.593 0 01-.335-.28.258.258 0 00-.037-.031l-.347-.316-.1-.094c-.082-.084-.166-.164-.25-.246l-.098-.1a9.081 9.081 0 01-.309-.323l-.015-.016c-.106-.116-.21-.235-.313-.355-.027-.03-.053-.064-.08-.097l-.227-.277a21.275 21.275 0 01-.34-.449C2.152 11.79 1.306 7.384 3.177 3.771m4.943-.473c-1.54 2.211-1.454 5.169-.254 7.508a9.111 9.111 0 00.678 1.133c.23.33.484.721.793.988.107.122.223.24.344.36l.09.09c.114.11.232.217.35.325l.016.013a9.867 9.867 0 00.414.342c.034.023.063.05.096.073.14.108.282.212.428.316l.015.009c.062.045.128.086.198.13.028.018.06.042.09.06.106.068.21.132.318.197.017.007.032.016.048.023.09.055.188.108.282.157.033.02.065.035.1.054.066.033.132.068.197.102l.032.014c.135.067.273.129.408.19.034.014.063.025.092.039.111.048.224.094.336.137.05.017.097.037.144.052.102.038.21.073.31.108l.14.045c.147.045.295.104.449.13C22.164 17.206 24 11.098 24 11.098c-1.653 2.38-4.852 3.513-8.261 2.628a8.04 8.04 0 01-.449-.13c-.048-.014-.09-.029-.136-.043-.104-.036-.211-.07-.312-.109l-.144-.054c-.113-.045-.227-.087-.336-.135-.034-.015-.065-.025-.091-.04-.14-.063-.281-.125-.418-.192l-.206-.107-.119-.06a5.673 5.673 0 01-.265-.15.62.62 0 01-.062-.035c-.106-.066-.217-.13-.318-.198-.034-.019-.065-.042-.097-.062l-.208-.136c-.144-.1-.285-.208-.428-.313-.032-.029-.063-.053-.094-.079-1.499-1.178-2.681-2.79-3.242-4.613-.59-1.897-.46-4.023.56-5.75m4.292-.147c-.909 1.334-.996 2.99-.37 4.46.665 1.563 2.024 2.79 3.608 3.37.065.025.128.046.196.07l.088.027c.092.03.185.063.28.084 4.381.845 5.567-2.25 5.886-2.704-1.043 1.498-2.792 1.857-4.938 1.335a4.85 4.85 0 01-.516-.16 6.352 6.352 0 01-.618-.254 6.53 6.53 0 01-1.082-.66c-1.922-1.457-3.113-4.236-1.859-6.5" },
  "htmx": { title: "htmx", hex: "3366CC", category: "framework", path: "M0 13.01v-2l7.09-2.98.58 1.94-5.1 2.05 5.16 2.05-.63 1.9Zm16.37 1.03 5.18-2-5.16-2.09.65-1.88L24 10.95v2.12L17 16zm-2.85-9.98H16l-5.47 15.88H8.05Z" },
  "express": { title: "Express", hex: "0A0A0A", category: "framework", path: "M12.262 16.666h1.146l6.975-9.325H19.22zm9.778 1.441v.004l-4.334-5.706-.557.74 4.873 6.682H.945V4.173h9.505l5.026 6.7.574-.772-4.374-5.928h.003l-.719-.945H0v17.544h24zM10.917 8.705a3.8 3.8 0 0 0-1.292-1.183q-.796-.45-1.916-.45c-.746 0-1.37.14-1.906.424a3.76 3.76 0 0 0-1.31 1.12 4.9 4.9 0 0 0-.75 1.581 7.17 7.17 0 0 0 0 3.696c.148.567.402 1.101.75 1.573a3.5 3.5 0 0 0 1.31 1.066q.803.39 1.906.389 1.77 0 2.739-.868.966-.867 1.328-2.457h-1.139q-.271 1.084-.977 1.734-.704.651-1.952.65-.812 0-1.392-.342a3.1 3.1 0 0 1-.957-.869 3.5 3.5 0 0 1-.551-1.182 5 5 0 0 1-.17-1.133 9 9 0 0 0-.015-.286 4.5 4.5 0 0 1 .015-.829c.047-.418.147-.83.296-1.223A3.7 3.7 0 0 1 5.54 9.05a2.9 2.9 0 0 1 .922-.742q.541-.28 1.246-.28c.47 0 .869.093 1.23.28q.541.281.922.742.379.461.587 1.057t.225 1.246H5.625l.004.957h6.182a7.3 7.3 0 0 0-.18-1.924 4.9 4.9 0 0 0-.715-1.68z" },
  "nestjs": { title: "NestJS", hex: "E0234E", category: "framework", path: "M14.131.047c-.173 0-.334.037-.483.087.316.21.49.49.576.806.007.043.019.074.025.117a.681.681 0 0 1 .013.112c.024.545-.143.614-.26.936-.18.415-.13.861.086 1.22a.74.74 0 0 0 .074.137c-.235-1.568 1.073-1.803 1.314-2.293.019-.428-.334-.713-.613-.911a1.37 1.37 0 0 0-.732-.21zM16.102.4c-.024.143-.006.106-.012.18-.006.05-.006.112-.012.161-.013.05-.025.1-.044.149-.012.05-.03.1-.05.149l-.067.142c-.02.025-.031.05-.05.075l-.037.055a2.152 2.152 0 0 1-.093.124c-.037.038-.068.081-.112.112v.006c-.037.031-.074.068-.118.1-.13.099-.278.173-.415.266-.043.03-.087.056-.124.093a.906.906 0 0 0-.118.099c-.043.037-.074.074-.111.118-.031.037-.068.08-.093.124a1.582 1.582 0 0 0-.087.13c-.025.05-.043.093-.068.142-.019.05-.037.093-.05.143a2.007 2.007 0 0 0-.043.155c-.006.025-.006.056-.012.08-.007.025-.007.05-.013.075 0 .05-.006.105-.006.155 0 .037 0 .074.006.111 0 .05.006.1.019.155.006.05.018.1.03.15.02.049.032.098.05.148.013.03.031.062.044.087l-1.426-.552c-.241-.068-.477-.13-.719-.186l-.39-.093c-.372-.074-.75-.13-1.128-.167-.013 0-.019-.006-.031-.006A11.082 11.082 0 0 0 8.9 2.855c-.378.025-.756.074-1.134.136a12.45 12.45 0 0 0-.837.174l-.279.074c-.092.037-.18.08-.266.118l-.205.093c-.012.006-.024.006-.03.012-.063.031-.118.056-.174.087a2.738 2.738 0 0 0-.236.118c-.043.018-.086.043-.124.062a.559.559 0 0 1-.055.03c-.056.032-.112.063-.162.094a1.56 1.56 0 0 0-.148.093c-.044.03-.087.055-.124.086-.006.007-.013.007-.019.013-.037.025-.08.056-.118.087l-.012.012-.093.074c-.012.007-.025.019-.037.025-.031.025-.062.056-.093.08-.006.013-.019.02-.025.025-.037.038-.074.069-.111.106-.007 0-.007.006-.013.012a1.742 1.742 0 0 0-.111.106c-.007.006-.007.012-.013.012a1.454 1.454 0 0 0-.093.1c-.012.012-.03.024-.043.036a1.374 1.374 0 0 1-.106.112c-.006.012-.018.019-.024.03-.05.05-.093.1-.143.15l-.018.018c-.1.106-.205.211-.317.304-.111.1-.229.192-.347.273a3.777 3.777 0 0 1-.762.421c-.13.056-.267.106-.403.149-.26.056-.527.161-.756.18-.05 0-.105.012-.155.018l-.155.037-.149.056c-.05.019-.099.044-.148.068-.044.031-.093.056-.137.087a1.011 1.011 0 0 0-.124.106c-.043.03-.087.074-.124.111-.037.043-.074.08-.105.124-.031.05-.068.093-.093.143a1.092 1.092 0 0 0-.087.142c-.025.056-.05.106-.068.161-.019.05-.037.106-.056.161-.012.05-.025.1-.03.15 0 .005-.007.012-.007.018-.012.056-.012.13-.019.167C.006 7.95 0 7.986 0 8.03a.657.657 0 0 0 .074.31v.006c.019.037.044.075.069.112.024.037.05.074.08.111.031.031.068.069.106.1a.906.906 0 0 0 .117.099c.149.13.186.173.378.272.031.019.062.031.1.05.006 0 .012.006.018.006 0 .013 0 .019.006.031a1.272 1.272 0 0 0 .08.298c.02.037.032.074.05.111.007.013.013.025.02.031.024.05.049.093.073.137l.093.13c.031.037.069.08.106.118.037.037.074.068.118.105 0 0 .006.006.012.006.037.031.074.062.112.087a.986.986 0 0 0 .136.08c.043.025.093.05.142.069a.73.73 0 0 0 .124.043c.007.006.013.006.025.012.025.007.056.013.08.019-.018.335-.024.65.026.762.055.124.328-.254.6-.688-.036.428-.061.93 0 1.079.069.155.44-.329.763-.862 4.395-1.016 8.405 2.02 8.826 6.31-.08-.67-.905-1.041-1.283-.948-.186.458-.502 1.047-1.01 1.413.043-.41.025-.83-.062-1.24a4.009 4.009 0 0 1-.769 1.562c-.588.043-1.177-.242-1.487-.67-.025-.018-.031-.055-.05-.08-.018-.043-.037-.087-.05-.13a.515.515 0 0 1-.037-.13c-.006-.044-.006-.087-.006-.137v-.093a.992.992 0 0 1 .031-.13c.013-.043.025-.086.044-.13.024-.043.043-.087.074-.13.105-.298.105-.54-.087-.682a.706.706 0 0 0-.118-.062c-.024-.006-.055-.018-.08-.025l-.05-.018a.847.847 0 0 0-.13-.031.472.472 0 0 0-.13-.019 1.01 1.01 0 0 0-.136-.012c-.031 0-.062.006-.093.006a.484.484 0 0 0-.137.019c-.043.006-.086.012-.13.024a1.068 1.068 0 0 0-.13.044c-.043.018-.08.037-.124.056-.037.018-.074.043-.118.062-1.444.942-.582 3.148.403 3.787-.372.068-.75.148-.855.229l-.013.012c.267.161.546.298.837.416.397.13.818.247 1.004.297v.006a5.996 5.996 0 0 0 1.562.112c2.746-.192 4.996-2.281 5.405-5.033l.037.161c.019.112.043.23.056.347v.006c.012.056.018.112.025.162v.024c.006.056.012.112.012.162.006.068.012.136.012.204v.1c0 .03.007.067.007.098 0 .038-.007.075-.007.112v.087c0 .043-.006.08-.006.124 0 .025 0 .05-.006.08 0 .044-.006.087-.006.137-.006.018-.006.037-.006.055l-.02.143c0 .019 0 .037-.005.056-.007.062-.019.118-.025.18v.012l-.037.174v.018l-.037.167c0 .007-.007.02-.007.025a1.663 1.663 0 0 1-.043.168v.018c-.019.062-.037.118-.05.174-.006.006-.006.012-.006.012l-.056.186c-.024.062-.043.118-.068.18-.025.062-.043.124-.068.18-.025.062-.05.117-.074.18h-.007c-.024.055-.05.117-.08.173a.302.302 0 0 1-.019.043c-.006.006-.006.013-.012.019a5.867 5.867 0 0 1-1.742 2.082c-.05.031-.099.069-.149.106-.012.012-.03.018-.043.03a2.603 2.603 0 0 1-.136.094l.018.037h.007l.26-.037h.006c.161-.025.322-.056.483-.087.044-.006.093-.019.137-.031l.087-.019c.043-.006.086-.018.13-.024.037-.013.074-.02.111-.031.62-.15 1.221-.354 1.798-.595a9.926 9.926 0 0 1-3.85 3.142c.714-.05 1.426-.167 2.114-.366a9.903 9.903 0 0 0 5.857-4.68 9.893 9.893 0 0 1-1.667 3.986 9.758 9.758 0 0 0 1.655-1.376 9.824 9.824 0 0 0 2.61-5.268c.21.98.272 1.99.18 2.987 4.474-6.241.371-12.712-1.346-14.416-.006-.013-.012-.019-.012-.031-.006.006-.006.006-.006.012 0-.006 0-.006-.007-.012 0 .074-.006.148-.012.223a8.34 8.34 0 0 1-.062.415c-.03.136-.068.273-.105.41-.044.13-.093.266-.15.396a5.322 5.322 0 0 1-.185.378 4.735 4.735 0 0 1-.477.688c-.093.111-.192.21-.292.31a3.994 3.994 0 0 1-.18.155l-.142.124a3.459 3.459 0 0 1-.347.241 4.295 4.295 0 0 1-.366.211c-.13.062-.26.118-.39.174a4.364 4.364 0 0 1-.818.223c-.143.025-.285.037-.422.05a4.914 4.914 0 0 1-.297.012 4.66 4.66 0 0 1-.422-.025 3.137 3.137 0 0 1-.421-.062 3.136 3.136 0 0 1-.415-.105h-.007c.137-.013.273-.025.41-.05a4.493 4.493 0 0 0 .818-.223c.136-.05.266-.112.39-.174.13-.062.248-.13.372-.204.118-.08.235-.161.347-.248.112-.087.217-.18.316-.279.105-.093.198-.198.291-.304.093-.111.18-.223.26-.334.013-.019.026-.044.038-.062.062-.1.124-.199.18-.298a4.272 4.272 0 0 0 .334-.775c.044-.13.075-.266.106-.403.025-.142.05-.278.062-.415.012-.142.025-.285.025-.421 0-.1-.007-.199-.013-.298a6.726 6.726 0 0 0-.05-.415 4.493 4.493 0 0 0-.092-.415c-.044-.13-.087-.267-.137-.397-.05-.13-.111-.26-.173-.384-.069-.124-.137-.248-.211-.366a6.843 6.843 0 0 0-.248-.34c-.093-.106-.186-.212-.285-.317a3.878 3.878 0 0 0-.161-.155c-.28-.217-.57-.421-.862-.607a1.154 1.154 0 0 0-.124-.062 2.415 2.415 0 0 0-.589-.26Z" },
  "fastify": { title: "Fastify", hex: "000000", category: "framework", path: "M23.245 6.49L24 4.533l-.031-.121-7.473 1.967c.797-1.153.523-2.078.523-2.078s-2.387 1.524-4.193 1.485c-1.804-.04-2.387-.52-5.155.362-2.768.882-3.551 3.59-4.351 4.173-.804.583-3.32 2.477-3.32 2.477l.006.034 2.27-.724s-.622.585-1.945 2.37l-.062-.057.002.011s1.064 1.626 2.107 1.324a2.14 2.14 0 0 0 .353-.147c.419.234.967.463 1.572.525 0 0-.41-.475-.752-1.017l.238-.154.865.318-.096-.812c.003-.003.006-.003.008-.006l.849.311-.105-.738a5.65 5.65 0 0 1 .322-.158l.885-3.345 3.662-2.497-.291.733c-.741 1.826-2.135 2.256-2.135 2.256l-.582.22c-.433.512-.614.637-.764 2.353.348-.088.682-.107.984-.028 1.564.421 2.107 2.307 1.685 2.827-.104.13-.356.354-.673.617H7.77l-.008.514-.065.051h-.645l-.009.504-.17.127c-.607.011-1.373-.518-1.373-.518 0 .481.401 1.225.401 1.225l.07-.034-.061.045s1.625 1.083 2.646.681c.91-.356 3.263-2.213 5.296-3.093l6.15-1.62.811-2.1-4.688 1.235v-1.889l5.5-1.448.811-2.1-6.31 1.662V8.367zm-11.163 4l1.459-.384.02.074-.455 1.179-1.513.398zm.503 2.526l-1.512.398.489-1.266 1.459-.385.02.074zm1.971-.424l-1.513.398.49-1.266 1.459-.385.02.073Z" },
  "hono": { title: "Hono", hex: "E36002", category: "framework", path: "M12.445.002a45.529 45.529 0 0 0-5.252 8.146 8.595 8.595 0 0 1-.555-.53 27.796 27.796 0 0 0-1.205-1.542 8.762 8.762 0 0 0-1.251 2.12 20.743 20.743 0 0 0-1.448 5.88 8.867 8.867 0 0 0 .338 3.468c1.312 3.48 3.794 5.593 7.445 6.337 3.055.438 5.755-.333 8.097-2.312 2.677-2.59 3.359-5.634 2.047-9.132a33.287 33.287 0 0 0-2.988-5.59A91.34 91.34 0 0 0 12.615.053a.216.216 0 0 0-.17-.051Zm-.336 3.906a50.93 50.93 0 0 1 4.794 6.552c.448.767.817 1.57 1.108 2.41.606 2.386-.044 4.354-1.951 5.904-1.845 1.298-3.87 1.683-6.072 1.156-2.376-.737-3.75-2.335-4.121-4.794a5.107 5.107 0 0 1 .242-2.266c.358-.908.79-1.774 1.3-2.601l1.446-2.121a397.33 397.33 0 0 0 3.254-4.24Z" },
  "django": { title: "Django", hex: "092E20", category: "framework", path: "M11.146 0h3.924v18.166c-2.013.382-3.491.535-5.096.535-4.791 0-7.288-2.166-7.288-6.32 0-4.002 2.65-6.6 6.753-6.6.637 0 1.121.05 1.707.203zm0 9.143a3.894 3.894 0 00-1.325-.204c-1.988 0-3.134 1.223-3.134 3.365 0 2.09 1.096 3.236 3.109 3.236.433 0 .79-.025 1.35-.102V9.142zM21.314 6.06v9.098c0 3.134-.229 4.638-.917 5.937-.637 1.249-1.478 2.039-3.211 2.905l-3.644-1.733c1.733-.815 2.574-1.53 3.109-2.625.561-1.121.739-2.421.739-5.835V6.059h3.924zM17.39.021h3.924v4.026H17.39z" },
  "flask": { title: "Flask", hex: "3BABC3", category: "framework", path: "M10.773 2.878c-.013 1.434.322 4.624.445 5.734l-8.558 3.83c-.56-.959-.98-2.304-1.237-3.38l-.06.027c-.205.09-.406.053-.494-.088l-.011-.018-.82-1.506c-.058-.105-.05-.252.024-.392a.78.78 0 0 1 .358-.331l9.824-4.207c.146-.064.299-.063.4.004.106.062.127.128.13.327Zm.68 7c.523 1.97.675 2.412.832 2.818l-7.263 3.7a19.35 19.35 0 0 1-1.81-2.83l8.24-3.689Zm12.432 8.786h.003c.283.402-.047.657-.153.698l-.947.37c.037.125.035.319-.217.414l-.736.287c-.229.09-.398-.059-.42-.2l-.025-.125c-4.427 1.784-7.94 1.685-10.696.647-1.981-.745-3.576-1.983-4.846-3.379l6.948-3.54c.721 1.431 1.586 2.454 2.509 3.178 2.086 1.638 4.415 1.712 5.793 1.563l-.047-.233c-.015-.077.007-.135.086-.165l.734-.288a.302.302 0 0 1 .342.086l.748-.288a.306.306 0 0 1 .341.086l.583.89Z" },
  "fastapi": { title: "FastAPI", hex: "009688", category: "framework", path: "M12 .0387C5.3729.0384.0003 5.3931 0 11.9988c-.001 6.6066 5.372 11.9628 12 11.9625 6.628.0003 12.001-5.3559 12-11.9625-.0003-6.6057-5.3729-11.9604-12-11.96m-.829 5.4153h7.55l-7.5805 5.3284h5.1828L5.279 18.5436q2.9466-6.5444 5.892-13.0896" },
  "rubyonrails": { title: "Ruby on Rails", hex: "D30001", category: "framework", path: "M.741 19.365h8.36s-1.598-7.291 3.693-10.243l.134-.066c1.286-.637 4.907-2.431 10.702 1.854.19-.159.37-.286.37-.286s-5.503-5.492-11.63-4.878c-3.079.275-6.867 3.079-9.09 6.783C1.058 16.233.741 19.365.741 19.365Zm8.804-.783a10.682 10.682 0 0 1-.127-1.333l1.143.412c.063.498.159.963.254 1.376l-1.27-.455Zm-7.799-4.317L.529 13.82c-.201.455-.423.984-.529 1.27l1.217.444c.137-.359.36-.878.529-1.269Zm7.831.296.857.677c.042-.413.116-.825.222-1.238l-.762-.603c-.137.391-.233.783-.317 1.164Zm2.042-2.646-.508-.762c.191-.243.413-.486.656-.709l.476.72a5.958 5.958 0 0 0-.624.751ZM4.19 8.878l.752.656c-.254.265-.498.551-.72.836l-.815-.698c.244-.265.508-.529.783-.794Zm9.799 1.027-.243-.73c.265-.117.571-.233.931-.339l.233.698a6.82 6.82 0 0 0-.921.371Zm3.122-.656.042-.667c.339.021.688.064 1.048.138l-.042.656a5.859 5.859 0 0 0-1.048-.127ZM8.942 6.392l-.476-.731c-.265.138-.54.286-.826.455l.487.741c.275-.169.54-.328.815-.465Zm9.217-.053.042-.709c-.095-.053-.36-.18-1.026-.371l-.043.699c.349.116.688.243 1.027.381ZM13.238 5.28h.106l-.212-.645c-.328 0-.666.021-1.016.063l.201.625a8.87 8.87 0 0 1 .921-.043Z" },
  "laravel": { title: "Laravel", hex: "FF2D20", category: "framework", path: "M23.642 5.43a.364.364 0 01.014.1v5.149c0 .135-.073.26-.189.326l-4.323 2.49v4.934a.378.378 0 01-.188.326L9.93 23.949a.316.316 0 01-.066.027c-.008.002-.016.008-.024.01a.348.348 0 01-.192 0c-.011-.002-.02-.008-.03-.012-.02-.008-.042-.014-.062-.025L.533 18.755a.376.376 0 01-.189-.326V2.974c0-.033.005-.066.014-.098.003-.012.01-.02.014-.032a.369.369 0 01.023-.058c.004-.013.015-.022.023-.033l.033-.045c.012-.01.025-.018.037-.027.014-.012.027-.024.041-.034H.53L5.043.05a.375.375 0 01.375 0L9.93 2.647h.002c.015.01.027.021.04.033l.038.027c.013.014.02.03.033.045.008.011.02.021.025.033.01.02.017.038.024.058.003.011.01.021.013.032.01.031.014.064.014.098v9.652l3.76-2.164V5.527c0-.033.004-.066.013-.098.003-.01.01-.02.013-.032a.487.487 0 01.024-.059c.007-.012.018-.02.025-.033.012-.015.021-.03.033-.043.012-.012.025-.02.037-.028.014-.01.026-.023.041-.032h.001l4.513-2.598a.375.375 0 01.375 0l4.513 2.598c.016.01.027.021.042.031.012.01.025.018.036.028.013.014.022.03.034.044.008.012.019.021.024.033.011.02.018.04.024.06.006.01.012.021.015.032zm-.74 5.032V6.179l-1.578.908-2.182 1.256v4.283zm-4.51 7.75v-4.287l-2.147 1.225-6.126 3.498v4.325zM1.093 3.624v14.588l8.273 4.761v-4.325l-4.322-2.445-.002-.003H5.04c-.014-.01-.025-.021-.04-.031-.011-.01-.024-.018-.035-.027l-.001-.002c-.013-.012-.021-.025-.031-.04-.01-.011-.021-.022-.028-.036h-.002c-.008-.014-.013-.031-.02-.047-.006-.016-.014-.027-.018-.043a.49.49 0 01-.008-.057c-.002-.014-.006-.027-.006-.041V5.789l-2.18-1.257zM5.23.81L1.47 2.974l3.76 2.164 3.758-2.164zm1.956 13.505l2.182-1.256V3.624l-1.58.91-2.182 1.255v9.435zm11.581-10.95l-3.76 2.163 3.76 2.163 3.759-2.164zm-.376 4.978L16.21 7.087 14.63 6.18v4.283l2.182 1.256 1.58.908zm-8.65 9.654l5.514-3.148 2.756-1.572-3.757-2.163-4.323 2.489-3.941 2.27z" },
  "spring": { title: "Spring", hex: "6DB33F", category: "framework", path: "M21.8537 1.4158a10.4504 10.4504 0 0 1-1.284 2.2471A11.9666 11.9666 0 1 0 3.8518 20.7757l.4445.3951a11.9543 11.9543 0 0 0 19.6316-8.2971c.3457-3.0126-.568-6.8649-2.0743-11.458zM5.5805 20.8745a1.0174 1.0174 0 1 1-.1482-1.4323 1.0396 1.0396 0 0 1 .1482 1.4323zm16.1991-3.5806c-2.9385 3.9263-9.2601 2.5928-13.2852 2.7904 0 0-.7161.0494-1.4323.1481 0 0 .2717-.1234.6174-.2469 2.8398-.9877 4.1732-1.1853 5.9018-2.0743 3.2349-1.6545 6.4698-5.2844 7.1118-9.0379-1.2347 3.6053-4.9881 6.7167-8.3959 7.9761-2.3459.8643-6.5685 1.7039-6.5685 1.7039l-.1729-.0988c-2.8645-1.4076-2.9632-7.6304 2.2718-9.6306 2.2966-.889 4.4696-.395 6.9637-.9877 2.6422-.6174 5.7043-2.5929 6.939-5.1857 1.3828 4.1732 3.062 10.643.0493 14.6434z" },
  "springboot": { title: "Spring Boot", hex: "6DB33F", category: "framework", path: "m23.693 10.7058-4.73-8.1844c-.4094-.7106-1.4166-1.2942-2.2402-1.2942H7.2725c-.819 0-1.8308.5836-2.2402 1.2942L.307 10.7058c-.4095.7106-.4095 1.873 0 2.5837l4.7252 8.189c.4094.7107 1.4166 1.2943 2.2402 1.2943h9.455c.819 0 1.826-.5836 2.2402-1.2942l4.7252-8.189c.4095-.7107.4095-1.8732 0-2.5838zM10.9763 5.7547c0-.5365.4377-.9742.9742-.9742s.9742.4377.9742.9742v5.8217c0 .5366-.4377.9742-.9742.9742s-.9742-.4376-.9742-.9742zm.9742 12.4294c-3.6427 0-6.6077-2.965-6.6077-6.6077.0047-2.0896.993-4.0521 2.6685-5.304a.8657.8657 0 0 1 1.2142.1788.8657.8657 0 0 1-.1788 1.2143c-2.1602 1.6048-2.612 4.6592-1.0072 6.8194 1.6049 2.1603 4.6593 2.612 6.8195 1.0072 1.2378-.9177 1.9673-2.372 1.9673-3.9157a4.8972 4.8972 0 0 0-1.9861-3.925c-.386-.2824-.466-.8284-.1836-1.2143.2824-.386.8283-.466 1.2143-.1835 1.6895 1.2471 2.6826 3.2238 2.6873 5.3228 0 3.6474-2.965 6.6077-6.6077 6.6077z" },
  "dotnet": { title: ".NET", hex: "512BD4", category: "framework", path: "M24 8.77h-2.468v7.565h-1.425V8.77h-2.462V7.53H24zm-6.852 7.565h-4.821V7.53h4.63v1.24h-3.205v2.494h2.953v1.234h-2.953v2.604h3.396zm-6.708 0H8.882L4.78 9.863a2.896 2.896 0 0 1-.258-.51h-.036c.032.189.048.592.048 1.21v5.772H3.157V7.53h1.659l3.965 6.32c.167.261.275.442.323.54h.024c-.04-.233-.06-.629-.06-1.185V7.529h1.372zm-8.703-.693a.868.829 0 0 1-.869.829.868.829 0 0 1-.868-.83.868.829 0 0 1 .868-.828.868.829 0 0 1 .869.829Z" },
  "blazor": { title: "Blazor", hex: "512BD4", category: "framework", path: "M23.8337 8.1013a13.9123 13.9123 0 0 1-13.6424 11.72 10.1053 10.1053 0 0 1-1.994-.121 6.111 6.111 0 0 1-5.0824-5.7607 5.9344 5.9344 0 0 1 11.867-.0838c.025.9835-.4011 1.8464-1.277 1.8713-.9356 0-1.3742-.6677-1.3742-1.5674v-2.5001a1.5313 1.5313 0 0 0-1.5196-1.5328H8.7152a3.6481 3.6481 0 1 0 2.6948 6.0794l.0733-.1093.0734.1213a2.5807 2.5807 0 0 0 2.2007 1.0479 2.9088 2.9088 0 0 0 2.6947-3.0406 7.912 7.912 0 0 0-.217-1.9324 7.4043 7.4043 0 0 0-14.6395 1.6033 7.4971 7.4971 0 0 0 7.307 7.4043s.549.05 1.1677.0357a15.8029 15.8029 0 0 0 8.4747-2.5283c.036-.025.0719.025.048.0614a12.4392 12.4392 0 0 1-9.6901 3.9625A8.7442 8.7442 0 0 1 .003 13.8603a9.049 9.049 0 0 1 3.6349-7.2471 8.8634 8.8634 0 0 1 5.229-1.7262h2.813a7.9145 7.9145 0 0 0 5.8386-2.5777.1093.1093 0 0 1 .0594-.034.1115.1115 0 0 1 .1195.0522.113.113 0 0 1 .0155.0672 7.9345 7.9345 0 0 1-1.2274 3.5493.1075.1075 0 0 0-.0132.0609.1098.1098 0 0 0 .0724.0945.109.109 0 0 0 .0619.0033 8.5054 8.5054 0 0 0 5.9134-4.876.1554.1554 0 0 1 .0546-.0527.1497.1497 0 0 1 .147 0 .1535.1535 0 0 1 .0546.0527 10.779 10.779 0 0 1 1.0575 6.8746zm-14.9383 3.527a2.188 2.188 0 1 0 2.1877 2.1878v-2.0425a.1577.1577 0 0 0-.1497-.1497Z" },
  "graphql": { title: "GraphQL", hex: "E10098", category: "framework", path: "M12.002 0a2.138 2.138 0 1 0 0 4.277 2.138 2.138 0 1 0 0-4.277zm8.54 4.931a2.138 2.138 0 1 0 0 4.277 2.138 2.138 0 1 0 0-4.277zm0 9.862a2.138 2.138 0 1 0 0 4.277 2.138 2.138 0 1 0 0-4.277zm-8.54 4.931a2.138 2.138 0 1 0 0 4.276 2.138 2.138 0 1 0 0-4.276zm-8.542-4.93a2.138 2.138 0 1 0 0 4.276 2.138 2.138 0 1 0 0-4.277zm0-9.863a2.138 2.138 0 1 0 0 4.277 2.138 2.138 0 1 0 0-4.277zm8.542-3.378L2.953 6.777v10.448l9.049 5.224 9.047-5.224V6.777zm0 1.601 7.66 13.27H4.34zm-1.387.371L3.97 15.037V7.363zm2.774 0 6.646 3.838v7.674zM5.355 17.44h13.293l-6.646 3.836z" },
  "trpc": { title: "tRPC", hex: "2596BE", category: "framework", path: "M24 12c0 6.62-5.38 12-12 12S0 18.62 0 12 5.38 0 12 0s12 5.38 12 12ZM1.21 12A10.78 10.78 0 0 0 12 22.79 10.78 10.78 0 0 0 22.79 12 10.78 10.78 0 0 0 12 1.21 10.78 10.78 0 0 0 1.21 12Zm10.915-6.086 2.162 1.248a.25.25 0 0 1 .125.217v1.103l2.473 1.428a.25.25 0 0 1 .125.217v2.355l.955.551a.25.25 0 0 1 .125.217v2.496a.25.25 0 0 1-.125.217l-2.162 1.248a.25.25 0 0 1-.25 0l-.956-.552-2.472 1.427a.25.25 0 0 1-.25 0l-2.472-1.427-.956.552a.25.25 0 0 1-.25 0l-2.162-1.248a.25.25 0 0 1-.125-.217V13.25a.25.25 0 0 1 .125-.217l.955-.551v-2.355a.25.25 0 0 1 .125-.217l2.473-1.428V7.38a.25.25 0 0 1 .125-.217l2.162-1.248a.25.25 0 0 1 .25 0Zm1.268 10.049a.25.25 0 0 1-.125-.217V13.25a.25.25 0 0 1 .125-.217l2.16-1.248a.25.25 0 0 1 .25 0l.707.408v-1.922l-2.098-1.21v.814a.25.25 0 0 1-.125.217l-2.162 1.248a.25.25 0 0 1-.25 0l-2.162-1.248a.25.25 0 0 1-.125-.217V9.06L7.49 10.271v1.922l.707-.408a.25.25 0 0 1 .25 0l2.16 1.248a.25.25 0 0 1 .125.217v2.496a.25.25 0 0 1-.125.217l-.705.408L12 17.582l2.098-1.211ZM10.088 9.73l1.662.96V8.766l-1.662-.955Zm3.824 0V7.811l-1.662.955v1.924ZM12 6.418l-1.66.96 1.66.954 1.66-.954Zm-5.59 9.184 1.66.958v-1.921l-1.66-.956Zm3.822 0v-1.92l-1.662.957v1.923Zm-1.91-3.311-1.662.96 1.661.955 1.66-.956Zm5.446 3.31 1.66.96v-1.922l-1.66-.956Zm3.822 0v-1.918l-1.662.956v1.922Zm-1.912-3.31-1.66.96 1.66.955 1.66-.956Z" },
  "prisma": { title: "Prisma", hex: "2D3748", category: "framework", path: "M21.8068 18.2848L13.5528.7565c-.207-.4382-.639-.7273-1.1286-.7541-.5023-.0293-.9523.213-1.2062.6253L2.266 15.1271c-.2773.4518-.2718 1.0091.0158 1.4555l4.3759 6.7786c.2608.4046.7127.6388 1.1823.6388.1332 0 .267-.0188.3987-.0577l12.7019-3.7568c.3891-.1151.7072-.3904.8737-.7553s.1633-.7828-.0075-1.1454zm-1.8481.7519L9.1814 22.2242c-.3292.0975-.6448-.1873-.5756-.5194l3.8501-18.4386c.072-.3448.5486-.3996.699-.0803l7.1288 15.138c.1344.2856-.019.6224-.325.7128z" },
  "drizzle": { title: "Drizzle", hex: "C5F74F", category: "framework", path: "M5.353 11.823a1.036 1.036 0 0 0-.395-1.422 1.063 1.063 0 0 0-1.437.399L.138 16.702a1.035 1.035 0 0 0 .395 1.422 1.063 1.063 0 0 0 1.437-.398l3.383-5.903Zm11.216 0a1.036 1.036 0 0 0-.394-1.422 1.064 1.064 0 0 0-1.438.399l-3.382 5.902a1.036 1.036 0 0 0 .394 1.422c.506.283 1.15.104 1.438-.398l3.382-5.903Zm7.293-4.525a1.036 1.036 0 0 0-.395-1.422 1.062 1.062 0 0 0-1.437.399l-3.383 5.902a1.036 1.036 0 0 0 .395 1.422 1.063 1.063 0 0 0 1.437-.399l3.383-5.902Zm-11.219 0a1.035 1.035 0 0 0-.394-1.422 1.064 1.064 0 0 0-1.438.398l-3.382 5.903a1.036 1.036 0 0 0 .394 1.422c.506.282 1.15.104 1.438-.399l3.382-5.902Z" },
  "flutter": { title: "Flutter", hex: "02569B", category: "framework", path: "M14.314 0L2.3 12 6 15.7 21.684.013h-7.357zm.014 11.072L7.857 17.53l6.47 6.47H21.7l-6.46-6.468 6.46-6.46h-7.37z" },
  "electron": { title: "Electron", hex: "47848F", category: "framework", path: "M12.0111 0c-.85 0-1.5392.6891-1.5392 1.5392 0 .8501.6891 1.5393 1.5392 1.5393.595 0 1.11-.338 1.3662-.832 2.2208 1.2675 3.847 5.4728 3.847 10.3623 0 2.0715-.2891 4.056-.825 5.7685a.3215.3215 0 0 0 .2107.403.322.322 0 0 0 .4033-.2111c.5558-1.7763.8542-3.8251.8542-5.9604 0-5.1927-1.7717-9.686-4.3206-11.0027.001-.0223.0035-.0443.0035-.0669 0-.85-.6891-1.5392-1.5393-1.5392zm0 .6432a.896.896 0 1 1 0 1.792.896.896 0 1 1 0-1.792zm-5.486 4.3052c-2.067.0074-3.6473.6646-4.3885 1.9485-.7375 1.2774-.5267 2.971.5113 4.7813a.3217.3217 0 0 0 .558-.32C2.271 9.7274 2.089 8.266 2.6938 7.2185c.821-1.422 3.033-1.9552 5.9321-1.4271a.3216.3216 0 0 0 .1153-.6329c-.784-.1428-1.5271-.2125-2.216-.21zm11.0522.0176a.3216.3216 0 0 0-.0084.6432c1.8337.0239 3.1556.5956 3.7502 1.6256.8192 1.419.1798 3.5947-1.7182 5.837a.322.322 0 0 0 .0377.4535.3215.3215 0 0 0 .4532-.0377c2.0535-2.426 2.7708-4.8661 1.7845-6.5744-.7257-1.257-2.26-1.9207-4.299-1.9472zm-2.6984.2924a.3225.3225 0 0 0-.0647.0072c-1.8568.3979-3.8333 1.1755-5.7314 2.2714-4.5699 2.6384-7.5924 6.4948-7.3601 9.3717-.4726.2628-.7928.7664-.7928 1.3455 0 .85.6892 1.5392 1.5393 1.5392.85 0 1.5392-.6891 1.5392-1.5392 0-.8501-.6891-1.5393-1.5392-1.5393-.038 0-.0754.003-.1128.0057-.1002-2.5597 2.7434-6.1412 7.048-8.6265 1.8413-1.063 3.7551-1.8163 5.5445-2.1997a.3217.3217 0 0 0-.07-.636zm-2.8787 6.2364a1.1192 1.1192 0 0 0-.2243.0255c-.6012.1301-.983.7225-.8533 1.3238.1302.6012.7226.9832 1.3238.8533.6012-.1302.9832-.7226.8533-1.3238-.1139-.526-.5816-.8844-1.0995-.8788zM4.532 13.341a.321.321 0 0 0-.2318.0835.3214.3214 0 0 0-.0214.4542c1.2682 1.3936 2.9157 2.701 4.7946 3.7857 4.4146 2.5489 9.1056 3.2849 11.5608 1.8392a1.53 1.53 0 0 0 .8966.2899c.8501 0 1.5392-.6891 1.5392-1.5392 0-.8501-.689-1.5393-1.5392-1.5393-.85 0-1.5392.6892-1.5392 1.5393 0 .276.0737.5344.201.7584-2.2448 1.214-6.631.5002-10.7976-1.9054-1.8228-1.0524-3.418-2.3181-4.6404-3.6614a.3206.3206 0 0 0-.2226-.1049zm-2.0628 4.0172a.896.896 0 1 1 0 1.792.896.896 0 1 1 0-1.792zm19.0616 0a.896.896 0 1 1 0 1.792.891.891 0 0 1-.5864-.2194c-.0025-.004-.0039-.0083-.0066-.0123a.3195.3195 0 0 0-.0957-.0914.896.896 0 0 1 .6887-1.4689zm-14.0045 1.368a.3215.3215 0 0 0-.3207.4296C8.2793 22.154 10.036 24 12.0111 24c1.4406 0 2.7735-.9822 3.8128-2.711a.3215.3215 0 0 0-.11-.4413.3219.3219 0 0 0-.4415.11c-.934 1.5537-2.0812 2.399-3.2613 2.399-1.6407 0-3.2075-1.6465-4.2-4.4179a.3216.3216 0 0 0-.2848-.2126z" },
  "tauri": { title: "Tauri", hex: "24C8D8", category: "framework", path: "M13.912 0a8.72 8.72 0 0 0-8.308 6.139c1.05-.515 2.18-.845 3.342-.976 2.415-3.363 7.4-3.412 9.88-.097 2.48 3.315 1.025 8.084-2.883 9.45a6.131 6.131 0 0 1-.3 2.762 8.72 8.72 0 0 0 3.01-1.225A8.72 8.72 0 0 0 13.913 0zm.082 6.451a2.284 2.284 0 1 0-.15 4.566 2.284 2.284 0 0 0 .15-4.566zm-5.629.27a8.72 8.72 0 0 0-3.031 1.235 8.72 8.72 0 1 0 13.06 9.9131 10.173 10.174 0 0 1-3.343.965 6.125 6.125 0 1 1-7.028-9.343 6.114 6.115 0 0 1 .342-2.772zm1.713 6.27a2.284 2.284 0 0 0-2.284 2.283 2.284 2.284 0 0 0 2.284 2.284 2.284 2.284 0 0 0 2.284-2.284 2.284 2.284 0 0 0-2.284-2.284z" },
  "expo": { title: "Expo", hex: "1C2024", category: "framework", path: "M0 20.084c.043.53.23 1.063.718 1.778.58.849 1.576 1.315 2.303.567.49-.505 5.794-9.776 8.35-13.29a.761.761 0 011.248 0c2.556 3.514 7.86 12.785 8.35 13.29.727.748 1.723.282 2.303-.567.57-.835.728-1.42.728-2.046 0-.426-8.26-15.798-9.092-17.078-.8-1.23-1.044-1.498-2.397-1.542h-1.032c-1.353.044-1.597.311-2.398 1.542C8.267 3.991.33 18.758 0 19.77Z" },
  "nodedotjs": { title: "Node.js", hex: "5FA04E", category: "runtime", path: "M11.998,24c-0.321,0-0.641-0.084-0.922-0.247l-2.936-1.737c-0.438-0.245-0.224-0.332-0.08-0.383 c0.585-0.203,0.703-0.25,1.328-0.604c0.065-0.037,0.151-0.023,0.218,0.017l2.256,1.339c0.082,0.045,0.197,0.045,0.272,0l8.795-5.076 c0.082-0.047,0.134-0.141,0.134-0.238V6.921c0-0.099-0.053-0.192-0.137-0.242l-8.791-5.072c-0.081-0.047-0.189-0.047-0.271,0 L3.075,6.68C2.99,6.729,2.936,6.825,2.936,6.921v10.15c0,0.097,0.054,0.189,0.139,0.235l2.409,1.392 c1.307,0.654,2.108-0.116,2.108-0.89V7.787c0-0.142,0.114-0.253,0.256-0.253h1.115c0.139,0,0.255,0.112,0.255,0.253v10.021 c0,1.745-0.95,2.745-2.604,2.745c-0.508,0-0.909,0-2.026-0.551L2.28,18.675c-0.57-0.329-0.922-0.945-0.922-1.604V6.921 c0-0.659,0.353-1.275,0.922-1.603l8.795-5.082c0.557-0.315,1.296-0.315,1.848,0l8.794,5.082c0.57,0.329,0.924,0.944,0.924,1.603 v10.15c0,0.659-0.354,1.273-0.924,1.604l-8.794,5.078C12.643,23.916,12.324,24,11.998,24z M19.099,13.993 c0-1.9-1.284-2.406-3.987-2.763c-2.731-0.361-3.009-0.548-3.009-1.187c0-0.528,0.235-1.233,2.258-1.233 c1.807,0,2.473,0.389,2.747,1.607c0.024,0.115,0.129,0.199,0.247,0.199h1.141c0.071,0,0.138-0.031,0.186-0.081 c0.048-0.054,0.074-0.123,0.067-0.196c-0.177-2.098-1.571-3.076-4.388-3.076c-2.508,0-4.004,1.058-4.004,2.833 c0,1.925,1.488,2.457,3.895,2.695c2.88,0.282,3.103,0.703,3.103,1.269c0,0.983-0.789,1.402-2.642,1.402 c-2.327,0-2.839-0.584-3.011-1.742c-0.02-0.124-0.126-0.215-0.253-0.215h-1.137c-0.141,0-0.254,0.112-0.254,0.253 c0,1.482,0.806,3.248,4.655,3.248C17.501,17.007,19.099,15.91,19.099,13.993z" },
  "deno": { title: "Deno", hex: "000000", category: "runtime", path: "M1.105 18.02A11.9 11.9 0 0 1 0 12.985q0-.698.078-1.376a12 12 0 0 1 .231-1.34A12 12 0 0 1 4.025 4.02a12 12 0 0 1 5.46-2.771 12 12 0 0 1 3.428-.23c1.452.112 2.825.477 4.077 1.05a12 12 0 0 1 2.78 1.774 12.02 12.02 0 0 1 4.053 7.078A12 12 0 0 1 24 12.985q0 .454-.036.914a12 12 0 0 1-.728 3.305 12 12 0 0 1-2.38 3.875c-1.33 1.357-3.02 1.962-4.43 1.936a4.4 4.4 0 0 1-2.724-1.024c-.99-.853-1.391-1.83-1.53-2.919a5 5 0 0 1 .128-1.518c.105-.38.37-1.116.76-1.437-.455-.197-1.04-.624-1.226-.829-.045-.05-.04-.13 0-.183a.155.155 0 0 1 .177-.053c.392.134.869.267 1.372.35.66.111 1.484.25 2.317.292 2.03.1 4.153-.813 4.812-2.627s.403-3.609-1.96-4.685-3.454-2.356-5.363-3.128c-1.247-.505-2.636-.205-4.06.582-3.838 2.121-7.277 8.822-5.69 15.032a.191.191 0 0 1-.315.19 12 12 0 0 1-1.25-1.634 12 12 0 0 1-.769-1.404M11.57 6.087c.649-.051 1.214.501 1.31 1.236.13.979-.228 1.99-1.41 2.013-1.01.02-1.315-.997-1.248-1.614.066-.616.574-1.575 1.35-1.635" },
  "bun": { title: "Bun", hex: "000000", category: "runtime", path: "M12 22.596c6.628 0 12-4.338 12-9.688 0-3.318-2.057-6.248-5.219-7.986-1.286-.715-2.297-1.357-3.139-1.89C14.058 2.025 13.08 1.404 12 1.404c-1.097 0-2.334.785-3.966 1.821a49.92 49.92 0 0 1-2.816 1.697C2.057 6.66 0 9.59 0 12.908c0 5.35 5.372 9.687 12 9.687v.001ZM10.599 4.715c.334-.759.503-1.58.498-2.409 0-.145.202-.187.23-.029.658 2.783-.902 4.162-2.057 4.624-.124.048-.199-.121-.103-.209a5.763 5.763 0 0 0 1.432-1.977Zm2.058-.102a5.82 5.82 0 0 0-.782-2.306v-.016c-.069-.123.086-.263.185-.172 1.962 2.111 1.307 4.067.556 5.051-.082.103-.23-.003-.189-.126a5.85 5.85 0 0 0 .23-2.431Zm1.776-.561a5.727 5.727 0 0 0-1.612-1.806v-.014c-.112-.085-.024-.274.114-.218 2.595 1.087 2.774 3.18 2.459 4.407a.116.116 0 0 1-.049.071.11.11 0 0 1-.153-.026.122.122 0 0 1-.022-.083 5.891 5.891 0 0 0-.737-2.331Zm-5.087.561c-.617.546-1.282.76-2.063 1-.117 0-.195-.078-.156-.181 1.752-.909 2.376-1.649 2.999-2.778 0 0 .155-.118.188.085 0 .304-.349 1.329-.968 1.874Zm4.945 11.237a2.957 2.957 0 0 1-.937 1.553c-.346.346-.8.565-1.286.62a2.178 2.178 0 0 1-1.327-.62 2.955 2.955 0 0 1-.925-1.553.244.244 0 0 1 .064-.198.234.234 0 0 1 .193-.069h3.965a.226.226 0 0 1 .19.07c.05.053.073.125.063.197Zm-5.458-2.176a1.862 1.862 0 0 1-2.384-.245 1.98 1.98 0 0 1-.233-2.447c.207-.319.503-.566.848-.713a1.84 1.84 0 0 1 1.092-.11c.366.075.703.261.967.531a1.98 1.98 0 0 1 .408 2.114 1.931 1.931 0 0 1-.698.869v.001Zm8.495.005a1.86 1.86 0 0 1-2.381-.253 1.964 1.964 0 0 1-.547-1.366c0-.384.11-.76.32-1.079.207-.319.503-.567.849-.713a1.844 1.844 0 0 1 1.093-.108c.367.076.704.262.968.534a1.98 1.98 0 0 1 .4 2.117 1.932 1.932 0 0 1-.702.868Z" },
  "nuget": { title: "NuGet", hex: "004880", category: "runtime", path: "M1.998.342a1.997 1.997 0 1 0 0 3.995 1.997 1.997 0 0 0 0-3.995zm9.18 4.34a6.156 6.156 0 0 0-6.153 6.155v6.667c0 3.4 2.756 6.154 6.154 6.154h6.667c3.4 0 6.154-2.755 6.154-6.154v-6.667a6.154 6.154 0 0 0-6.154-6.155zm-1.477 2.8a2.496 2.496 0 1 1 0 4.993 2.496 2.496 0 0 1 0-4.993zm7.968 6.16a3.996 3.996 0 1 1-.002 7.992 3.996 3.996 0 0 1 .002-7.992z" },
  "npm": { title: "npm", hex: "CB3837", category: "runtime", path: "M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z" },
  "pnpm": { title: "pnpm", hex: "F69220", category: "runtime", path: "M0 0v7.5h7.5V0zm8.25 0v7.5h7.498V0zm8.25 0v7.5H24V0zM2 2h3.5v3.5H2zm8.25 0h3.498v3.5H10.25zm8.25 0H22v3.5h-3.5zM8.25 8.25v7.5h7.498v-7.5zm8.25 0v7.5H24v-7.5zm2 2H22v3.5h-3.5zM0 16.5V24h7.5v-7.5zm8.25 0V24h7.498v-7.5zm8.25 0V24H24v-7.5z" },
  "yarn": { title: "Yarn", hex: "2C8EBB", category: "runtime", path: "M12 0C5.375 0 0 5.375 0 12s5.375 12 12 12 12-5.375 12-12S18.625 0 12 0zm.768 4.105c.183 0 .363.053.525.157.125.083.287.185.755 1.154.31-.088.468-.042.551-.019.204.056.366.19.463.375.477.917.542 2.553.334 3.605-.241 1.232-.755 2.029-1.131 2.576.324.329.778.899 1.117 1.825.278.774.31 1.478.273 2.015a5.51 5.51 0 0 0 .602-.329c.593-.366 1.487-.917 2.553-.931.714-.009 1.269.445 1.353 1.103a1.23 1.23 0 0 1-.945 1.362c-.649.158-.95.278-1.821.843-1.232.797-2.539 1.242-3.012 1.39a1.686 1.686 0 0 1-.704.343c-.737.181-3.266.315-3.466.315h-.046c-.783 0-1.214-.241-1.45-.491-.658.329-1.51.19-2.122-.134a1.078 1.078 0 0 1-.58-1.153 1.243 1.243 0 0 1-.153-.195c-.162-.25-.528-.936-.454-1.946.056-.723.556-1.367.88-1.71a5.522 5.522 0 0 1 .408-2.256c.306-.727.885-1.348 1.32-1.737-.32-.537-.644-1.367-.329-2.21.227-.602.412-.936.82-1.08h-.005c.199-.074.389-.153.486-.259a3.418 3.418 0 0 1 2.298-1.103c.037-.093.079-.185.125-.283.31-.658.639-1.029 1.024-1.168a.94.94 0 0 1 .328-.06zm.006.7c-.507.016-1.001 1.519-1.001 1.519s-1.27-.204-2.266.871c-.199.218-.468.334-.746.44-.079.028-.176.023-.417.672-.371.991.625 2.094.625 2.094s-1.186.839-1.626 1.881c-.486 1.144-.338 2.261-.338 2.261s-.843.732-.899 1.487c-.051.663.139 1.2.343 1.515.227.343.51.176.51.176s-.561.653-.037.931c.477.25 1.283.394 1.71-.037.31-.31.371-1.001.486-1.283.028-.065.12.111.209.199.097.093.264.195.264.195s-.755.324-.445 1.066c.102.246.468.403 1.066.398.222-.005 2.664-.139 3.313-.296.375-.088.505-.283.505-.283s1.566-.431 2.998-1.357c.917-.598 1.293-.76 2.034-.936.612-.148.57-1.098-.241-1.084-.839.009-1.575.44-2.196.825-1.163.718-1.742.672-1.742.672l-.018-.032c-.079-.13.371-1.293-.134-2.678-.547-1.515-1.413-1.881-1.344-1.997.297-.5 1.038-1.297 1.334-2.78.176-.899.13-2.377-.269-3.151-.074-.144-.732.241-.732.241s-.616-1.371-.788-1.483a.271.271 0 0 0-.157-.046z" },
  "postgresql": { title: "PostgreSQL", hex: "4169E1", category: "data", path: "M23.5594 14.7228a.5269.5269 0 0 0-.0563-.1191c-.139-.2632-.4768-.3418-1.0074-.2321-1.6533.3411-2.2935.1312-2.5256-.0191 1.342-2.0482 2.445-4.522 3.0411-6.8297.2714-1.0507.7982-3.5237.1222-4.7316a1.5641 1.5641 0 0 0-.1509-.235C21.6931.9086 19.8007.0248 17.5099.0005c-1.4947-.0158-2.7705.3461-3.1161.4794a9.449 9.449 0 0 0-.5159-.0816 8.044 8.044 0 0 0-1.3114-.1278c-1.1822-.0184-2.2038.2642-3.0498.8406-.8573-.3211-4.7888-1.645-7.2219.0788C.9359 2.1526.3086 3.8733.4302 6.3043c.0409.818.5069 3.334 1.2423 5.7436.4598 1.5065.9387 2.7019 1.4334 3.582.553.9942 1.1259 1.5933 1.7143 1.7895.4474.1491 1.1327.1441 1.8581-.7279.8012-.9635 1.5903-1.8258 1.9446-2.2069.4351.2355.9064.3625 1.39.3772a.0569.0569 0 0 0 .0004.0041 11.0312 11.0312 0 0 0-.2472.3054c-.3389.4302-.4094.5197-1.5002.7443-.3102.064-1.1344.2339-1.1464.8115-.0025.1224.0329.2309.0919.3268.2269.4231.9216.6097 1.015.6331 1.3345.3335 2.5044.092 3.3714-.6787-.017 2.231.0775 4.4174.3454 5.0874.2212.5529.7618 1.9045 2.4692 1.9043.2505 0 .5263-.0291.8296-.0941 1.7819-.3821 2.5557-1.1696 2.855-2.9059.1503-.8707.4016-2.8753.5388-4.1012.0169-.0703.0357-.1207.057-.1362.0007-.0005.0697-.0471.4272.0307a.3673.3673 0 0 0 .0443.0068l.2539.0223.0149.001c.8468.0384 1.9114-.1426 2.5312-.4308.6438-.2988 1.8057-1.0323 1.5951-1.6698zM2.371 11.8765c-.7435-2.4358-1.1779-4.8851-1.2123-5.5719-.1086-2.1714.4171-3.6829 1.5623-4.4927 1.8367-1.2986 4.8398-.5408 6.108-.13-.0032.0032-.0066.0061-.0098.0094-2.0238 2.044-1.9758 5.536-1.9708 5.7495-.0002.0823.0066.1989.0162.3593.0348.5873.0996 1.6804-.0735 2.9184-.1609 1.1504.1937 2.2764.9728 3.0892.0806.0841.1648.1631.2518.2374-.3468.3714-1.1004 1.1926-1.9025 2.1576-.5677.6825-.9597.5517-1.0886.5087-.3919-.1307-.813-.5871-1.2381-1.3223-.4796-.839-.9635-2.0317-1.4155-3.5126zm6.0072 5.0871c-.1711-.0428-.3271-.1132-.4322-.1772.0889-.0394.2374-.0902.4833-.1409 1.2833-.2641 1.4815-.4506 1.9143-1.0002.0992-.126.2116-.2687.3673-.4426a.3549.3549 0 0 0 .0737-.1298c.1708-.1513.2724-.1099.4369-.0417.156.0646.3078.26.3695.4752.0291.1016.0619.2945-.0452.4444-.9043 1.2658-2.2216 1.2494-3.1676 1.0128zm2.094-3.988-.0525.141c-.133.3566-.2567.6881-.3334 1.003-.6674-.0021-1.3168-.2872-1.8105-.8024-.6279-.6551-.9131-1.5664-.7825-2.5004.1828-1.3079.1153-2.4468.079-3.0586-.005-.0857-.0095-.1607-.0122-.2199.2957-.2621 1.6659-.9962 2.6429-.7724.4459.1022.7176.4057.8305.928.5846 2.7038.0774 3.8307-.3302 4.7363-.084.1866-.1633.3629-.2311.5454zm7.3637 4.5725c-.0169.1768-.0358.376-.0618.5959l-.146.4383a.3547.3547 0 0 0-.0182.1077c-.0059.4747-.054.6489-.115.8693-.0634.2292-.1353.4891-.1794 1.0575-.11 1.4143-.8782 2.2267-2.4172 2.5565-1.5155.3251-1.7843-.4968-2.0212-1.2217a6.5824 6.5824 0 0 0-.0769-.2266c-.2154-.5858-.1911-1.4119-.1574-2.5551.0165-.5612-.0249-1.9013-.3302-2.6462.0044-.2932.0106-.5909.019-.8918a.3529.3529 0 0 0-.0153-.1126 1.4927 1.4927 0 0 0-.0439-.208c-.1226-.4283-.4213-.7866-.7797-.9351-.1424-.059-.4038-.1672-.7178-.0869.067-.276.1831-.5875.309-.9249l.0529-.142c.0595-.16.134-.3257.213-.5012.4265-.9476 1.0106-2.2453.3766-5.1772-.2374-1.0981-1.0304-1.6343-2.2324-1.5098-.7207.0746-1.3799.3654-1.7088.5321a5.6716 5.6716 0 0 0-.1958.1041c.0918-1.1064.4386-3.1741 1.7357-4.4823a4.0306 4.0306 0 0 1 .3033-.276.3532.3532 0 0 0 .1447-.0644c.7524-.5706 1.6945-.8506 2.802-.8325.4091.0067.8017.0339 1.1742.081 1.939.3544 3.2439 1.4468 4.0359 2.3827.8143.9623 1.2552 1.9315 1.4312 2.4543-1.3232-.1346-2.2234.1268-2.6797.779-.9926 1.4189.543 4.1729 1.2811 5.4964.1353.2426.2522.4522.2889.5413.2403.5825.5515.9713.7787 1.2552.0696.087.1372.1714.1885.245-.4008.1155-1.1208.3825-1.0552 1.717-.0123.1563-.0423.4469-.0834.8148-.0461.2077-.0702.4603-.0994.7662zm.8905-1.6211c-.0405-.8316.2691-.9185.5967-1.0105a2.8566 2.8566 0 0 0 .135-.0406 1.202 1.202 0 0 0 .1342.103c.5703.3765 1.5823.4213 3.0068.1344-.2016.1769-.5189.3994-.9533.6011-.4098.1903-1.0957.333-1.7473.3636-.7197.0336-1.0859-.0807-1.1721-.151zm.5695-9.2712c-.0059.3508-.0542.6692-.1054 1.0017-.055.3576-.112.7274-.1264 1.1762-.0142.4368.0404.8909.0932 1.3301.1066.887.216 1.8003-.2075 2.7014a3.5272 3.5272 0 0 1-.1876-.3856c-.0527-.1276-.1669-.3326-.3251-.6162-.6156-1.1041-2.0574-3.6896-1.3193-4.7446.3795-.5427 1.3408-.5661 2.1781-.463zm.2284 7.0137a12.3762 12.3762 0 0 0-.0853-.1074l-.0355-.0444c.7262-1.1995.5842-2.3862.4578-3.4385-.0519-.4318-.1009-.8396-.0885-1.2226.0129-.4061.0666-.7543.1185-1.0911.0639-.415.1288-.8443.1109-1.3505.0134-.0531.0188-.1158.0118-.1902-.0457-.4855-.5999-1.938-1.7294-3.253-.6076-.7073-1.4896-1.4972-2.6889-2.0395.5251-.1066 1.2328-.2035 2.0244-.1859 2.0515.0456 3.6746.8135 4.8242 2.2824a.908.908 0 0 1 .0667.1002c.7231 1.3556-.2762 6.2751-2.9867 10.5405zm-8.8166-6.1162c-.025.1794-.3089.4225-.6211.4225a.5821.5821 0 0 1-.0809-.0056c-.1873-.026-.3765-.144-.5059-.3156-.0458-.0605-.1203-.178-.1055-.2844.0055-.0401.0261-.0985.0925-.1488.1182-.0894.3518-.1226.6096-.0867.3163.0441.6426.1938.6113.4186zm7.9305-.4114c.0111.0792-.049.201-.1531.3102-.0683.0717-.212.1961-.4079.2232a.5456.5456 0 0 1-.075.0052c-.2935 0-.5414-.2344-.5607-.3717-.024-.1765.2641-.3106.5611-.352.297-.0414.6111.0088.6356.1851z" },
  "mysql": { title: "MySQL", hex: "4479A1", category: "data", path: "M16.405 5.501c-.115 0-.193.014-.274.033v.013h.014c.054.104.146.18.214.273.054.107.1.214.154.32l.014-.015c.094-.066.14-.172.14-.333-.04-.047-.046-.094-.08-.14-.04-.067-.126-.1-.18-.153zM5.77 18.695h-.927a50.854 50.854 0 00-.27-4.41h-.008l-1.41 4.41H2.45l-1.4-4.41h-.01a72.892 72.892 0 00-.195 4.41H0c.055-1.966.192-3.81.41-5.53h1.15l1.335 4.064h.008l1.347-4.064h1.095c.242 2.015.384 3.86.428 5.53zm4.017-4.08c-.378 2.045-.876 3.533-1.492 4.46-.482.716-1.01 1.073-1.583 1.073-.153 0-.34-.046-.566-.138v-.494c.11.017.24.026.386.026.268 0 .483-.075.647-.222.197-.18.295-.382.295-.605 0-.155-.077-.47-.23-.944L6.23 14.615h.91l.727 2.36c.164.536.233.91.205 1.123.4-1.064.678-2.227.835-3.483zm12.325 4.08h-2.63v-5.53h.885v4.85h1.745zm-3.32.135l-1.016-.5c.09-.076.177-.158.255-.25.433-.506.648-1.258.648-2.253 0-1.83-.718-2.746-2.155-2.746-.704 0-1.254.232-1.65.697-.43.508-.646 1.256-.646 2.245 0 .972.19 1.686.574 2.14.35.41.877.615 1.583.615.264 0 .506-.033.725-.098l1.325.772.36-.622zM15.5 17.588c-.225-.36-.337-.94-.337-1.736 0-1.393.424-2.09 1.27-2.09.443 0 .77.167.977.5.224.362.336.936.336 1.723 0 1.404-.424 2.108-1.27 2.108-.445 0-.77-.167-.978-.5zm-1.658-.425c0 .47-.172.856-.516 1.156-.344.3-.803.45-1.384.45-.543 0-1.064-.172-1.573-.515l.237-.476c.438.22.833.328 1.19.328.332 0 .593-.073.783-.22a.754.754 0 00.3-.615c0-.33-.23-.61-.648-.845-.388-.213-1.163-.657-1.163-.657-.422-.307-.632-.636-.632-1.177 0-.45.157-.81.47-1.085.315-.278.72-.415 1.22-.415.512 0 .98.136 1.4.41l-.213.476a2.726 2.726 0 00-1.064-.23c-.283 0-.502.068-.654.206a.685.685 0 00-.248.524c0 .328.234.61.666.85.393.215 1.187.67 1.187.67.433.305.648.63.648 1.168zm9.382-5.852c-.535-.014-.95.04-1.297.188-.1.04-.26.04-.274.167.055.053.063.14.11.214.08.134.218.313.346.407.14.11.28.216.427.31.26.16.555.255.81.416.145.094.293.213.44.313.073.05.12.14.214.172v-.02c-.046-.06-.06-.147-.105-.214-.067-.067-.134-.127-.2-.193a3.223 3.223 0 00-.695-.675c-.214-.146-.682-.35-.77-.595l-.013-.014c.146-.013.32-.066.46-.106.227-.06.435-.047.67-.106.106-.027.213-.06.32-.094v-.06c-.12-.12-.21-.283-.334-.395a8.867 8.867 0 00-1.104-.823c-.21-.134-.476-.22-.697-.334-.08-.04-.214-.06-.26-.127-.12-.146-.19-.34-.275-.514a17.69 17.69 0 01-.547-1.163c-.12-.262-.193-.523-.34-.763-.69-1.137-1.437-1.826-2.586-2.5-.247-.14-.543-.2-.856-.274-.167-.008-.334-.02-.5-.027-.11-.047-.216-.174-.31-.235-.38-.24-1.364-.76-1.644-.072-.18.434.267.862.422 1.082.115.153.26.328.34.5.047.116.06.235.107.356.106.294.207.622.347.897.073.14.153.287.247.413.054.073.146.107.167.227-.094.136-.1.334-.154.5-.24.757-.146 1.693.194 2.25.107.166.362.534.703.393.3-.12.234-.5.32-.835.02-.08.007-.133.048-.187v.015c.094.188.188.367.274.555.206.328.566.668.867.895.16.12.287.328.487.402v-.02h-.015c-.043-.058-.1-.086-.154-.133a3.445 3.445 0 01-.35-.4 8.76 8.76 0 01-.747-1.218c-.11-.21-.202-.436-.29-.643-.04-.08-.04-.2-.107-.24-.1.146-.247.273-.32.453-.127.288-.14.642-.188 1.01-.027.007-.014 0-.027.014-.214-.052-.287-.274-.367-.46-.2-.475-.233-1.238-.06-1.785.047-.14.247-.582.167-.716-.042-.127-.174-.2-.247-.303a2.478 2.478 0 01-.24-.427c-.16-.374-.24-.788-.414-1.162-.08-.173-.22-.354-.334-.513-.127-.18-.267-.307-.368-.52-.033-.073-.08-.194-.027-.274.014-.054.042-.075.094-.09.088-.072.335.022.422.062.247.1.455.194.662.334.094.066.195.193.315.226h.14c.214.047.455.014.655.073.355.114.675.28.962.46a5.953 5.953 0 012.085 2.286c.08.154.115.295.188.455.14.33.313.663.455.982.14.315.275.636.476.897.1.14.502.213.682.286.133.06.34.115.46.188.23.14.454.3.67.454.11.076.443.243.463.378z" },
  "mariadb": { title: "MariaDB", hex: "003545", category: "data", path: "M23.157 4.412c-.676.284-.79.31-1.673.372-.65.045-.757.057-1.212.209-.75.246-1.395.75-2.02 1.59-.296.398-1.249 1.913-1.249 1.988 0 .057-.65.998-.915 1.32-.574.713-1.08 1.079-2.14 1.59-.77.36-1.224.524-4.102 1.477-1.073.353-2.133.738-2.367.864-.852.449-1.515 1.036-2.203 1.938-1.003 1.32-.972 1.313-3.042.947a12.264 12.264 0 00-.675-.063c-.644-.05-1.023.044-1.332.334L0 17.193l.177.088c.094.05.353.234.561.398.215.17.461.347.55.391.088.044.17.088.183.101.012.013-.089.17-.228.353-.435.581-.593.871-.574 1.048.019.164.032.17.43.17.517-.006.826-.056 1.261-.208.65-.233 2.058-.94 2.784-1.4.776-.5 1.717-.998 1.956-1.042.082-.02.354-.07.594-.114.58-.107 1.464-.095 2.587.05.108.013.373.045.6.064.227.025.43.057.454.076.026.012.474.037.998.056.934.026 1.104.007 1.3-.189.126-.133.385-.631.498-.985.209-.643.417-.921.366-.492-.113.966-.322 1.692-.713 2.411-.259.499-.663 1.092-.934 1.395-.322.347-.315.36.088.315.619-.063 1.471-.397 2.096-.82.827-.562 1.647-1.691 2.19-3.03.107-.27.22-.22.183.083-.013.094-.038.315-.057.498l-.031.328.353-.202c.833-.48 1.414-1.262 2.127-2.884.227-.518.877-2.922 1.073-3.976a9.64 9.64 0 01.271-1.042c.127-.429.196-.555.48-.858.183-.19.625-.555.978-.808.72-.505.953-.75 1.187-1.205.208-.417.284-1.13.132-1.357-.132-.202-.284-.196-.763.006Z" },
  "sqlite": { title: "SQLite", hex: "003B57", category: "data", path: "M21.678.521c-1.032-.92-2.28-.55-3.513.544a8.71 8.71 0 0 0-.547.535c-2.109 2.237-4.066 6.38-4.674 9.544.237.48.422 1.093.544 1.561a13.044 13.044 0 0 1 .164.703s-.019-.071-.096-.296l-.05-.146a1.689 1.689 0 0 0-.033-.08c-.138-.32-.518-.995-.686-1.289-.143.423-.27.818-.376 1.176.484.884.778 2.4.778 2.4s-.025-.099-.147-.442c-.107-.303-.644-1.244-.772-1.464-.217.804-.304 1.346-.226 1.478.152.256.296.698.422 1.186.286 1.1.485 2.44.485 2.44l.017.224a22.41 22.41 0 0 0 .056 2.748c.095 1.146.273 2.13.5 2.657l.155-.084c-.334-1.038-.47-2.399-.41-3.967.09-2.398.642-5.29 1.661-8.304 1.723-4.55 4.113-8.201 6.3-9.945-1.993 1.8-4.692 7.63-5.5 9.788-.904 2.416-1.545 4.684-1.931 6.857.666-2.037 2.821-2.912 2.821-2.912s1.057-1.304 2.292-3.166c-.74.169-1.955.458-2.362.629-.6.251-.762.337-.762.337s1.945-1.184 3.613-1.72C21.695 7.9 24.195 2.767 21.678.521m-18.573.543A1.842 1.842 0 0 0 1.27 2.9v16.608a1.84 1.84 0 0 0 1.835 1.834h9.418a22.953 22.953 0 0 1-.052-2.707c-.006-.062-.011-.141-.016-.2a27.01 27.01 0 0 0-.473-2.378c-.121-.47-.275-.898-.369-1.057-.116-.197-.098-.31-.097-.432 0-.12.015-.245.037-.386a9.98 9.98 0 0 1 .234-1.045l.217-.028c-.017-.035-.014-.065-.031-.097l-.041-.381a32.8 32.8 0 0 1 .382-1.194l.2-.019c-.008-.016-.01-.038-.018-.053l-.043-.316c.63-3.28 2.587-7.443 4.8-9.791.066-.069.133-.128.198-.194Z" },
  "mongodb": { title: "MongoDB", hex: "47A248", category: "data", path: "M17.193 9.555c-1.264-5.58-4.252-7.414-4.573-8.115-.28-.394-.53-.954-.735-1.44-.036.495-.055.685-.523 1.184-.723.566-4.438 3.682-4.74 10.02-.282 5.912 4.27 9.435 4.888 9.884l.07.05A73.49 73.49 0 0111.91 24h.481c.114-1.032.284-2.056.51-3.07.417-.296.604-.463.85-.693a11.342 11.342 0 003.639-8.464c.01-.814-.103-1.662-.197-2.218zm-5.336 8.195s0-8.291.275-8.29c.213 0 .49 10.695.49 10.695-.381-.045-.765-1.76-.765-2.405z" },
  "redis": { title: "Redis", hex: "FF4438", category: "data", path: "M22.71 13.145c-1.66 2.092-3.452 4.483-7.038 4.483-3.203 0-4.397-2.825-4.48-5.12.701 1.484 2.073 2.685 4.214 2.63 4.117-.133 6.94-3.852 6.94-7.239 0-4.05-3.022-6.972-8.268-6.972-3.752 0-8.4 1.428-11.455 3.685C2.59 6.937 3.885 9.958 4.35 9.626c2.648-1.904 4.748-3.13 6.784-3.744C8.12 9.244.886 17.05 0 18.425c.1 1.261 1.66 4.648 2.424 4.648.232 0 .431-.133.664-.365a100.49 100.49 0 0 0 5.54-6.765c.222 3.104 1.748 6.898 6.014 6.898 3.819 0 7.604-2.756 9.33-8.965.2-.764-.73-1.361-1.261-.73zm-4.349-5.013c0 1.959-1.926 2.922-3.685 2.922-.941 0-1.664-.247-2.235-.568 1.051-1.592 2.092-3.225 3.21-4.973 1.972.334 2.71 1.43 2.71 2.619z" },
  "supabase": { title: "Supabase", hex: "3FCF8E", category: "data", path: "M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z" },
  "firebase": { title: "Firebase", hex: "DD2C00", category: "data", path: "M19.455 8.369c-.538-.748-1.778-2.285-3.681-4.569-.826-.991-1.535-1.832-1.884-2.245a146 146 0 0 0-.488-.576l-.207-.245-.113-.133-.022-.032-.01-.005L12.57 0l-.609.488c-1.555 1.246-2.828 2.851-3.681 4.64-.523 1.064-.864 2.105-1.043 3.176-.047.241-.088.489-.121.738-.209-.017-.421-.028-.632-.033-.018-.001-.035-.002-.059-.003a7.46 7.46 0 0 0-2.28.274l-.317.089-.163.286c-.765 1.342-1.198 2.869-1.252 4.416-.07 2.01.477 3.954 1.583 5.625 1.082 1.633 2.61 2.882 4.42 3.611l.236.095.071.025.003-.001a9.59 9.59 0 0 0 2.941.568q.171.006.342.006c1.273 0 2.513-.249 3.69-.742l.008.004.313-.145a9.63 9.63 0 0 0 3.927-3.335c1.01-1.49 1.577-3.234 1.641-5.042.075-2.161-.643-4.304-2.133-6.371m-7.083 6.695c.328 1.244.264 2.44-.191 3.558-1.135-1.12-1.967-2.352-2.475-3.665-.543-1.404-.87-2.74-.974-3.975.48.157.922.366 1.315.622 1.132.737 1.914 1.902 2.325 3.461zm.207 6.022c.482.368.99.712 1.513 1.028-.771.21-1.565.302-2.369.273a8 8 0 0 1-.373-.022c.458-.394.869-.823 1.228-1.279zm1.347-6.431c-.516-1.957-1.527-3.437-3.002-4.398-.647-.421-1.385-.741-2.194-.95.011-.134.026-.268.043-.4.014-.113.03-.216.046-.313.133-.689.332-1.37.589-2.025.099-.25.206-.499.321-.74l.004-.008c.177-.358.376-.719.61-1.105l.092-.152-.003-.001c.544-.851 1.197-1.627 1.942-2.311l.288.341c.672.796 1.304 1.548 1.878 2.237 1.291 1.549 2.966 3.583 3.612 4.48 1.277 1.771 1.893 3.579 1.83 5.375-.049 1.395-.461 2.755-1.195 3.933-.694 1.116-1.661 2.05-2.8 2.708-.636-.318-1.559-.839-2.539-1.599.79-1.575.952-3.28.479-5.072zm-2.575 5.397c-.725.939-1.587 1.55-2.09 1.856-.081-.029-.163-.06-.243-.093l-.065-.026c-1.49-.616-2.747-1.656-3.635-3.01-.907-1.384-1.356-2.993-1.298-4.653.041-1.19.338-2.327.882-3.379.316-.07.638-.114.96-.131l.084-.002c.162-.003.324-.003.478 0 .227.011.454.035.677.07.073 1.513.445 3.145 1.105 4.852.637 1.644 1.694 3.162 3.144 4.515z" },
  "neo4j": { title: "Neo4j", hex: "4581C3", category: "data", path: "M9.629 13.227c-.593 0-1.139.2-1.58.533l-2.892-1.976a2.61 2.61 0 0 0 .101-.711 2.633 2.633 0 0 0-2.629-2.629A2.632 2.632 0 0 0 0 11.073a2.632 2.632 0 0 0 2.629 2.629c.593 0 1.139-.2 1.579-.533L7.1 15.145c-.063.226-.1.465-.1.711 0 .247.037.484.1.711l-2.892 1.976a2.608 2.608 0 0 0-1.579-.533A2.632 2.632 0 0 0 0 20.639a2.632 2.632 0 0 0 2.629 2.629 2.632 2.632 0 0 0 2.629-2.629c0-.247-.037-.485-.101-.711l2.892-1.976c.441.333.987.533 1.58.533a2.633 2.633 0 0 0 2.629-2.629c0-1.45-1.18-2.629-2.629-2.629ZM16.112.732c-4.72 0-7.888 2.748-7.888 8.082v3.802a3.525 3.525 0 0 1 3.071.008v-3.81c0-3.459 1.907-5.237 4.817-5.237s4.817 1.778 4.817 5.237v8.309H24V8.814C24 3.448 20.832.732 16.112.732Z" },
  "duckdb": { title: "DuckDB", hex: "FFF000", category: "data", path: "M12 0C5.363 0 0 5.363 0 12s5.363 12 12 12 12-5.363 12-12S18.637 0 12 0zM9.502 7.03a4.974 4.974 0 0 1 4.97 4.97 4.974 4.974 0 0 1-4.97 4.97A4.974 4.974 0 0 1 4.532 12a4.974 4.974 0 0 1 4.97-4.97zm6.563 3.183h2.351c.98 0 1.787.782 1.787 1.762s-.807 1.789-1.787 1.789h-2.351v-3.551z" },
  "elasticsearch": { title: "Elasticsearch", hex: "005571", category: "data", path: "M13.394 0C8.683 0 4.609 2.716 2.644 6.667h15.641a4.77 4.77 0 0 0 3.073-1.11c.446-.375.864-.785 1.247-1.243l.001-.002A11.974 11.974 0 0 0 13.394 0zM1.804 8.889a12.009 12.009 0 0 0 0 6.222h14.7a3.111 3.111 0 1 0 0-6.222zm.84 8.444C4.61 21.283 8.684 24 13.395 24c3.701 0 7.011-1.677 9.212-4.312l-.001-.002a9.958 9.958 0 0 0-1.247-1.243 4.77 4.77 0 0 0-3.073-1.11z" },
  "apachekafka": { title: "Apache Kafka", hex: "231F20", category: "data", path: "M9.71 2.136a1.43 1.43 0 0 0-2.047 0h-.007a1.48 1.48 0 0 0-.421 1.042c0 .41.161.777.422 1.039l.007.007c.257.264.616.426 1.019.426.404 0 .766-.162 1.027-.426l.003-.007c.261-.262.421-.629.421-1.039 0-.408-.159-.777-.421-1.042H9.71zM8.683 22.295c.404 0 .766-.167 1.027-.429l.003-.008c.261-.261.421-.631.421-1.036 0-.41-.159-.778-.421-1.044H9.71a1.42 1.42 0 0 0-1.027-.432 1.4 1.4 0 0 0-1.02.432h-.007c-.26.266-.422.634-.422 1.044 0 .406.161.775.422 1.036l.007.008c.258.262.617.429 1.02.429zm7.89-4.462c.359-.096.683-.33.882-.684l.027-.052a1.47 1.47 0 0 0 .114-1.067 1.454 1.454 0 0 0-.675-.896l-.021-.014a1.425 1.425 0 0 0-1.078-.132c-.36.091-.684.335-.881.686-.2.349-.241.75-.146 1.119.099.363.33.691.675.896h.002c.346.203.737.239 1.101.144zm-6.405-7.342a2.083 2.083 0 0 0-1.485-.627c-.58 0-1.103.242-1.482.627-.378.385-.612.916-.612 1.507s.233 1.124.612 1.514a2.08 2.08 0 0 0 2.967 0c.379-.39.612-.923.612-1.514s-.233-1.122-.612-1.507zm-.835-2.51c.843.141 1.6.552 2.178 1.144h.004c.092.093.182.196.265.299l1.446-.851a3.176 3.176 0 0 1-.047-1.808 3.149 3.149 0 0 1 1.456-1.926l.025-.016a3.062 3.062 0 0 1 2.345-.306c.77.21 1.465.721 1.898 1.482v.002c.431.757.518 1.626.313 2.408a3.145 3.145 0 0 1-1.456 1.928l-.198.118h-.02a3.095 3.095 0 0 1-2.154.201 3.127 3.127 0 0 1-1.514-.944l-1.444.848a4.162 4.162 0 0 1 0 2.879l1.444.846c.413-.47.939-.789 1.514-.944a3.041 3.041 0 0 1 2.371.319l.048.023v.002a3.17 3.17 0 0 1 1.408 1.906 3.215 3.215 0 0 1-.313 2.405l-.026.053-.003-.005a3.147 3.147 0 0 1-1.867 1.436 3.096 3.096 0 0 1-2.371-.318v-.006a3.156 3.156 0 0 1-1.456-1.927 3.175 3.175 0 0 1 .047-1.805l-1.446-.848a3.905 3.905 0 0 1-.265.294l-.004.005a3.938 3.938 0 0 1-2.178 1.138v1.699a3.09 3.09 0 0 1 1.56.862l.002.004c.565.572.914 1.368.914 2.243 0 .873-.35 1.664-.914 2.239l-.002.009a3.1 3.1 0 0 1-2.21.931 3.1 3.1 0 0 1-2.206-.93h-.002v-.009a3.186 3.186 0 0 1-.916-2.239c0-.875.35-1.672.916-2.243v-.004h.002a3.1 3.1 0 0 1 1.558-.862v-1.699a3.926 3.926 0 0 1-2.176-1.138l-.006-.005a4.098 4.098 0 0 1-1.173-2.874c0-1.122.452-2.136 1.173-2.872h.006a3.947 3.947 0 0 1 2.176-1.144V6.289a3.137 3.137 0 0 1-1.558-.864h-.002v-.004a3.192 3.192 0 0 1-.916-2.243c0-.871.35-1.669.916-2.243l.002-.002A3.084 3.084 0 0 1 8.683 0c.861 0 1.641.355 2.21.932v.002h.002c.565.574.914 1.372.914 2.243 0 .876-.35 1.667-.914 2.243l-.002.005a3.142 3.142 0 0 1-1.56.864v1.692zm8.121-1.129l-.012-.019a1.452 1.452 0 0 0-.87-.668 1.43 1.43 0 0 0-1.103.146h.002c-.347.2-.58.529-.677.896-.095.365-.054.768.146 1.119l.007.009c.2.347.519.579.874.673.357.103.755.059 1.098-.144l.019-.009a1.47 1.47 0 0 0 .657-.885 1.493 1.493 0 0 0-.141-1.118" },
  "rabbitmq": { title: "RabbitMQ", hex: "FF6600", category: "data", path: "M23.035 9.601h-7.677a.956.956 0 01-.962-.962V.962a.956.956 0 00-.962-.956H10.56a.956.956 0 00-.962.956V8.64a.956.956 0 01-.962.962H5.762a.956.956 0 01-.961-.962V.962A.956.956 0 003.839 0H.959a.956.956 0 00-.956.962v22.076A.956.956 0 00.965 24h22.07a.956.956 0 00.962-.962V10.58a.956.956 0 00-.962-.98zm-3.86 8.152a1.437 1.437 0 01-1.437 1.443h-1.924a1.437 1.437 0 01-1.436-1.443v-1.917a1.437 1.437 0 011.436-1.443h1.924a1.437 1.437 0 011.437 1.443z" },
  "databricks": { title: "Databricks", hex: "FF3621", category: "data", path: "M.95 14.184L12 20.403l9.919-5.55v2.21L12 22.662l-10.484-5.96-.565.308v.77L12 24l11.05-6.218v-4.317l-.515-.309L12 19.118l-9.867-5.653v-2.21L12 16.805l11.05-6.218V6.32l-.515-.308L12 11.974 2.647 6.681 12 1.388l7.76 4.368.668-.411v-.566L12 0 .95 6.27v.72L12 13.207l9.919-5.55v2.26L12 15.52 1.516 9.56l-.565.308Z" },
  "apachespark": { title: "Apache Spark", hex: "E25A1C", category: "data", path: "M10.812 0c-.425.013-.845.215-1.196.605a3.593 3.593 0 00-.493.722c-.355.667-.425 1.415-.556 2.143a551.9 551.9 0 00-.726 4.087c-.027.16-.096.227-.244.273C5.83 8.386 4.06 8.94 2.3 9.514c-.387.125-.773.289-1.114.506-1.042.665-1.196 1.753-.415 2.71.346.422.79.715 1.284.936 1.1.49 2.202.976 3.3 1.47.019.01.036.013.053.019h-.004l1.306.535c0 .023.002.045 0 .073-.2 2.03-.39 4.063-.58 6.095-.04.419-.012.831.134 1.23.317.87 1.065 1.148 1.881.701.372-.204.666-.497.937-.818 1.372-1.623 2.746-3.244 4.113-4.872.111-.133.205-.15.363-.098.349.117.697.231 1.045.347h.001c.02.012.045.02.073.03l.142.042c1.248.416 2.68.775 3.929 1.19.4.132.622.164 1.045.098.311-.048.592-.062.828-.236.602-.33.995-.957.988-1.682-.005-.427-.154-.813-.35-1.186-.82-1.556-1.637-3.113-2.461-4.666-.078-.148-.076-.243.037-.375 1.381-1.615 2.756-3.236 4.133-4.855.272-.32.513-.658.653-1.058.308-.878-.09-1.57-1-1.741a2.783 2.783 0 00-1.235.069c-1.974.521-3.947 1.041-5.918 1.57-.175.047-.26.015-.355-.144a353.08 353.08 0 00-2.421-4.018 4.61 4.61 0 00-.652-.849c-.371-.37-.802-.549-1.227-.536zm.172 3.703a.592.592 0 01.189.211c.87 1.446 1.742 2.89 2.609 4.338.07.118.135.16.277.121 1.525-.41 3.052-.813 4.579-1.217.367-.098.735-.193 1.103-.289a.399.399 0 01-.1.2c-1.259 1.48-2.516 2.962-3.779 4.438-.11.13-.12.22-.04.37.937 1.803 1.768 3.309 2.498 4.76l-3.696-1.019c-.538-.18-1.077-.358-1.615-.539-.163-.055-.25-.03-.36.1-1.248 1.488-2.504 2.97-3.759 4.454a.398.398 0 01-.18.132c.035-.378.068-.757.104-1.136.149-1.572.297-3.144.451-4.716-.03-.318.117-.405-.322-.545-1.493-.593-3.346-1.321-4.816-1.905a.595.595 0 01.24-.134c1.797-.57 3.595-1.14 5.394-1.705.127-.04.199-.092.211-.233.013-.148.05-.294.076-.441.241-1.363.483-2.726.726-4.088.068-.386.14-.771.21-1.157z" },
  "snowflake": { title: "Snowflake", hex: "29B5E8", category: "data", path: "M24 3.459c0 .646-.418 1.18-1.141 1.18-.723 0-1.142-.534-1.142-1.18 0-.647.419-1.18 1.142-1.18.723 0 1.141.533 1.141 1.18zm-.228 0c0-.533-.38-.951-.913-.951s-.913.38-.913.95c0 .533.38.952.913.952.57 0 .913-.419.913-.951zm-1.37-.533h.495c.266 0 .456.152.456.38 0 .153-.076.229-.19.305l.19.266v.038h-.266l-.19-.266h-.229v.266h-.266zm.495.228h-.229v.267h.229c.114 0 .152-.038.152-.114.038-.077-.038-.153-.152-.153zM7.602 12.4c.038-.151.076-.304.076-.456 0-.114-.038-.228-.038-.342-.114-.343-.304-.647-.646-.838l-4.87-2.777c-.685-.38-1.56-.152-1.94.533-.381.685-.153 1.56.532 1.94l2.701 1.56-2.701 1.56c-.685.38-.913 1.256-.533 1.94.38.685 1.256.914 1.94.533l4.832-2.777c.343-.267.571-.533.647-.876zm1.332 2.626c-.266-.038-.57.038-.837.19l-4.832 2.777c-.685.38-.913 1.256-.532 1.94.38.686 1.255.914 1.94.533l2.701-1.56v3.12c0 .8.647 1.408 1.446 1.408.799 0 1.407-.647 1.407-1.408v-5.592c0-.761-.57-1.37-1.293-1.408zm4.946-6.088c.266.038.57-.038.837-.19l4.832-2.777c.685-.38.913-1.256.532-1.94-.38-.686-1.255-.914-1.94-.533l-2.701 1.56V1.975c0-.799-.647-1.408-1.446-1.408-.799 0-1.446.609-1.446 1.408V7.53c0 .76.609 1.37 1.332 1.407zM3.265 5.97l4.832 2.777c.266.152.533.19.837.19.723-.038 1.331-.684 1.331-1.407V1.975c0-.799-.646-1.408-1.407-1.408-.799 0-1.446.647-1.446 1.408v3.12l-2.701-1.56c-.685-.38-1.56-.152-1.94.533-.419.646-.19 1.521.494 1.902zm9.093 6.011a.412.412 0 00-.114-.266l-.57-.571a.346.346 0 00-.267-.114.412.412 0 00-.266.114l-.571.57a.411.411 0 00-.114.267c0 .076.038.19.114.267l.57.57a.345.345 0 00.267.114c.076 0 .19-.038.266-.114l.571-.57a.412.412 0 00.114-.267zm1.598.533L11.94 14.53c-.039.038-.153.114-.229.114h-.608a.411.411 0 01-.267-.114L8.82 12.514a.408.408 0 01-.076-.229v-.608c0-.076.038-.19.114-.267l2.016-2.016a.41.41 0 01.267-.114h.608a.41.41 0 01.267.114l2.016 2.016a.347.347 0 01.114.267v.608c-.076.077-.114.19-.19.229zm5.593 5.44l-4.832-2.777c-.266-.152-.57-.19-.837-.152-.723.038-1.332.684-1.332 1.408v5.554c0 .8.647 1.408 1.408 1.408.799 0 1.446-.647 1.446-1.408v-3.12l2.7 1.56c.686.38 1.561.152 1.941-.533.419-.646.19-1.521-.494-1.94zm2.549-7.533l-2.701 1.56 2.7 1.56c.686.38.914 1.256.533 1.94-.38.685-1.255.913-1.94.533l-4.832-2.778a1.644 1.644 0 01-.647-.798c-.037-.153-.076-.305-.076-.457 0-.114.039-.228.039-.342.114-.343.342-.647.646-.837l4.832-2.778c.685-.38 1.56-.152 1.94.533.457.609.19 1.484-.494 1.864" },
  "apacheairflow": { title: "Apache Airflow", hex: "017CEE", category: "data", path: "M17.195 16.822l4.002-4.102C23.55 10.308 23.934 5.154 24 .43a.396.396 0 0 0-.246-.373.392.392 0 0 0-.437.09l-6.495 6.658-4.102-4.003C10.309.45 5.154.066.43 0H.423a.397.397 0 0 0-.277.683l6.658 6.494-4.003 4.103C.45 13.692.065 18.846 0 23.57a.398.398 0 0 0 .683.282l6.494-6.657 3.934 3.837.17.165c2.41 2.353 7.565 2.737 12.288 2.803h.006a.397.397 0 0 0 .277-.683l-6.657-6.495zm-.409-9.476c.04.115.05.24.031.344-.17.96-1.593 2.538-4.304 3.87a.597.597 0 0 0-.08-.079c1.432-3.155 1.828-5.61 1.175-7.322l3.058 2.984.12.203zm-.131 9.44a.73.73 0 0 1-.347.031c-.96-.171-2.537-1.594-3.87-4.307a.656.656 0 0 0 .08-.078l-.001.001c3.155 1.432 5.61 1.83 7.324 1.174l-2.969 3.043M23.568.392a.05.05 0 0 1 .052-.011c.018.006.03.024.029.043-.065 4.655-.437 9.726-2.703 12.05-1.53 1.565-4.326 1.419-8.283-.377.006-.037.021-.07.02-.108 0-.044-.017-.082-.026-.123 2.83-1.39 4.315-3.037 4.506-4.115.057-.322-.009-.542-.102-.688l6.507-6.67V.392zM.393.43A.045.045 0 0 1 .382.38C.39.36.403.343.425.35c4.655.065 9.727.438 12.05 2.703l.002.002c1.56 1.527 1.415 4.323-.379 8.28-.033-.005-.062-.02-.097-.02h-.008c-.045.001-.084.019-.126.027-1.39-2.83-3.037-4.314-4.115-4.506-.323-.057-.542.01-.688.103L.393.43zm11.94 11.563a.331.331 0 0 1-.327.335H12a.332.332 0 0 1-.004-.661c.172.016.333.144.335.326h.002zm-5.12 4.661a.722.722 0 0 1-.03-.345c.17-.96 1.595-2.54 4.309-3.873.013.016.019.035.033.05.013.012.03.017.044.028-1.434 3.158-1.83 5.613-1.177 7.326l-3.041-2.967m-.006-9.659a.735.735 0 0 1 .345-.031c.961.17 2.54 1.594 3.871 4.306a.597.597 0 0 0-.079.08c-2.167-.983-4.007-1.484-5.498-1.484-.68 0-1.289.103-1.825.308L7.128 7.35M.43 23.607c-.018.018-.038.015-.052.01-.019-.007-.028-.021-.028-.043.065-4.654.437-9.725 2.703-12.049 1.527-1.565 4.325-1.419 8.286.378-.006.035-.02.067-.02.104 0 .043.018.083.026.124-2.831 1.391-4.317 3.04-4.51 4.117-.057.322.01.542.103.688L.43 23.607zm23.144.042c-4.655-.065-9.726-.437-12.05-2.703l-.005-.006c-1.56-1.526-1.412-4.322.383-8.279.033.005.064.02.098.02h.009c.043 0 .08-.018.122-.027 1.39 2.832 3.036 4.317 4.115 4.51.083.014.16.021.23.021a.776.776 0 0 0 .45-.133l6.68 6.516c.02.02.016.04.01.052a.042.042 0 0 1-.042.029z" },
  "pytorch": { title: "PyTorch", hex: "EE4C2C", category: "ai", path: "M12.005 0L4.952 7.053a9.865 9.865 0 000 14.022 9.866 9.866 0 0014.022 0c3.984-3.9 3.986-10.205.085-14.023l-1.744 1.743c2.904 2.905 2.904 7.634 0 10.538s-7.634 2.904-10.538 0-2.904-7.634 0-10.538l4.647-4.646.582-.665zm3.568 3.899a1.327 1.327 0 00-1.327 1.327 1.327 1.327 0 001.327 1.328A1.327 1.327 0 0016.9 5.226 1.327 1.327 0 0015.573 3.9z" },
  "tensorflow": { title: "TensorFlow", hex: "FF6F00", category: "ai", path: "M1.292 5.856L11.54 0v24l-4.095-2.378V7.603l-6.168 3.564.015-5.31zm21.43 5.311l-.014-5.31L12.46 0v24l4.095-2.378V14.87l3.092 1.788-.018-4.618-3.074-1.756V7.603l6.168 3.564z" },
  "scikitlearn": { title: "scikit-learn", hex: "F7931E", category: "ai", path: "M15.601 5.53c-1.91.035-3.981.91-5.63 2.56-2.93 2.93-2.083 8.53-1.088 9.525.805.804 6.595 1.843 9.526-1.088a9.74 9.74 0 0 0 .584-.643c.043-.292.205-.66.489-1.106a1.848 1.848 0 0 1-.537.176c-.144.265-.37.55-.676.855-.354.335-.607.554-.76.656a.795.795 0 0 1-.437.152c-.35 0-.514-.308-.494-.924-.22.316-.425.549-.612.7a.914.914 0 0 1-.578.224c-.194 0-.36-.09-.496-.273a1.03 1.03 0 0 1-.193-.507 4.016 4.016 0 0 1-.726.583c-.224.132-.47.197-.74.197-.3 0-.543-.096-.727-.288a.978.978 0 0 1-.257-.524v.004c-.3.276-.564.48-.79.611a1.295 1.295 0 0 1-.649.197.693.693 0 0 1-.571-.275c-.145-.183-.218-.43-.218-.739 0-.464.101-1.02.302-1.67.201-.65.445-1.25.733-1.797l.842-.312a.21.21 0 0 1 .06-.013c.063 0 .116.047.157.14.04.095.061.221.061.38 0 .451-.104.888-.312 1.31-.207.422-.532.873-.974 1.352-.018.23-.027.388-.027.474 0 .193.036.345.106.458.071.113.165.169.282.169a.71.71 0 0 0 .382-.13c.132-.084.333-.26.602-.523.028-.418.187-.798.482-1.142.324-.38.685-.569 1.08-.569.206 0 .37.054.494.16a.524.524 0 0 1 .186.417c0 .458-.486.829-1.459 1.114.088.43.32.646.693.646a.807.807 0 0 0 .417-.117c.129-.076.321-.243.575-.497.032-.252.118-.495.259-.728.182-.3.416-.544.701-.73.285-.185.537-.278.756-.278.276 0 .47.127.58.381l.677-.374h.186l-.292.971c-.15.488-.226.823-.226 1.004 0 .19.067.285.202.285.086 0 .181-.045.285-.137.104-.092.25-.232.437-.42v.001c.143-.155.274-.32.392-.494-.19-.084-.285-.21-.285-.375 0-.17.058-.352.174-.545.116-.194.275-.29.479-.29.172 0 .258.088.258.265 0 .139-.05.338-.149.596.367-.04.687-.32.961-.842l.228-.01c1.059-2.438.828-5.075-.83-6.732-1.019-1.02-2.408-1.5-3.895-1.471zm4.725 8.203a8.938 8.938 0 0 1-1.333 2.151 1.09 1.09 0 0 0-.012.147c0 .168.047.309.14.423.092.113.206.17.34.17.296 0 .714-.264 1.254-.787-.001.04-.003.08-.003.121 0 .146.012.368.036.666l.733-.172c0-.2.003-.357.01-.474.01-.157.033-.33.066-.517.02-.11.07-.216.152-.315l.186-.216a5.276 5.276 0 0 1 .378-.397c.062-.055.116-.099.162-.13a.26.26 0 0 1 .123-.046c.055 0 .083.035.083.106 0 .07-.052.236-.156.497-.194.486-.292.848-.292 1.084 0 .175.046.314.136.418a.45.45 0 0 0 .358.155c.365 0 .803-.269 1.313-.808v-.381c-.361.426-.623.64-.784.64-.109 0-.163-.067-.163-.2 0-.1.065-.316.195-.65.19-.486.285-.836.285-1.048a.464.464 0 0 0-.112-.319.36.36 0 0 0-.282-.127c-.165 0-.354.077-.567.233-.213.156-.5.436-.863.84.053-.262.165-.622.335-1.08l-.809.156a6.54 6.54 0 0 0-.399 1.074c-.04.156-.07.316-.092.48a7.447 7.447 0 0 1-.49.45.38.38 0 0 1-.229.08.208.208 0 0 1-.174-.082.352.352 0 0 1-.064-.222c0-.1.019-.214.056-.343.038-.13.12-.373.249-.731l.308-.849zm-17.21-2.927c-.863-.016-1.67.263-2.261.854-1.352 1.352-1.07 3.827.631 5.527 1.7 1.701 4.95 1.21 5.527.632.467-.466 1.07-3.827-.631-5.527-.957-.957-2.158-1.465-3.267-1.486zm12.285.358h.166v.21H15.4zm.427 0h.166v.865l.46-.455h.195l-.364.362.428.684h-.198l-.357-.575-.164.166v.41h-.166zm1.016 0h.166v.21h-.166zm.481.122h.166v.288h.172v.135h-.172v.717c0 .037.006.062.02.075.012.013.037.02.074.02a.23.23 0 0 0 .078-.01v.141a.802.802 0 0 1-.136.014.23.23 0 0 1-.15-.043.15.15 0 0 1-.052-.123v-.79h-.141v-.136h.141zm-3.562.258c.081 0 .15.012.207.038.057.024.1.061.13.11s.045.106.045.173h-.176c-.006-.111-.075-.167-.208-.167a.285.285 0 0 0-.164.041.134.134 0 0 0-.06.117c0 .035.015.065.045.088.03.024.08.044.15.06l.16.039a.47.47 0 0 1 .224.105c.047.046.07.108.07.186a.3.3 0 0 1-.052.175.327.327 0 0 1-.152.116.585.585 0 0 1-.226.041c-.136 0-.24-.03-.309-.088-.069-.059-.105-.149-.109-.269h.176c.004.037.01.065.017.084a.166.166 0 0 0 .034.054c.044.043.112.065.204.065a.31.31 0 0 0 .177-.045.139.139 0 0 0 .067-.119.116.116 0 0 0-.038-.09.287.287 0 0 0-.124-.055l-.156-.038a1.248 1.248 0 0 1-.159-.05.359.359 0 0 1-.098-.061.22.22 0 0 1-.058-.083.32.32 0 0 1-.016-.108c0-.096.036-.174.109-.232a.45.45 0 0 1 .29-.087zm1.035 0a.46.46 0 0 1 .202.043.351.351 0 0 1 .187.212.577.577 0 0 1 .023.126h-.168a.256.256 0 0 0-.078-.168.242.242 0 0 0-.17-.06.248.248 0 0 0-.155.05.306.306 0 0 0-.1.144.662.662 0 0 0-.034.224.58.58 0 0 0 .035.214.299.299 0 0 0 .101.135.261.261 0 0 0 .157.048c.142 0 .227-.084.256-.252h.167a.519.519 0 0 1-.065.22.35.35 0 0 1-.146.138.464.464 0 0 1-.216.048.448.448 0 0 1-.246-.066.441.441 0 0 1-.161-.192.703.703 0 0 1-.057-.293c0-.085.01-.163.032-.233a.522.522 0 0 1 .095-.182.403.403 0 0 1 .15-.117.453.453 0 0 1 .191-.04zm.603.03h.166v1.046H15.4zm1.443 0h.166v1.046h-.166zm-5.05.618c-.08 0-.2.204-.356.611-.155.407-.308.977-.459 1.71.281-.312.509-.662.683-1.05.175-.387.262-.72.262-.999a.455.455 0 0 0-.036-.197c-.025-.05-.056-.075-.093-.075zm4.662 1.797c-.221 0-.431.188-.629.563-.197.376-.296.722-.296 1.038 0 .12.029.216.088.29a.273.273 0 0 0 .223.111c.221 0 .43-.188.625-.565.196-.377.294-.725.294-1.043a.457.457 0 0 0-.083-.29.269.269 0 0 0-.222-.104zm-2.848.007c-.146 0-.285.11-.417.333-.133.222-.2.51-.2.866.566-.159.849-.452.849-.881 0-.212-.077-.318-.232-.318Z" },
  "numpy": { title: "NumPy", hex: "013243", category: "ai", path: "M10.315 4.876L6.3048 2.8517l-4.401 2.1965 4.1186 2.0683zm1.8381.9277l4.2045 2.1223-4.3622 2.1906-4.125-2.0718zm5.6153-2.9213l4.3193 2.1658-3.863 1.9402-4.2131-2.1252zm-1.859-.9329L12.021 0 8.1742 1.9193l4.0068 2.0208zm-3.0401 16.7443V24l4.7107-2.3507-.0053-5.3085zm4.7037-4.2057l-.0052-5.2528-4.6985 2.3356v5.2546zm5.6553-.9845v5.327l-4.0178 2.0052-.0029-5.3028zm0-1.8626V6.4214l-4.0253 2.001.0034 5.2633zM11.2062 11.571L8.0333 9.9756v6.895s-3.8804-8.2564-4.2399-8.998c-.0463-.0957-.2371-.2007-.2858-.2262C2.8118 7.2812.773 6.2485.773 6.2485V18.43l2.8204 1.5076v-6.3674s3.8392 7.3775 3.878 7.458c.0389.0807.4245.8582.8362 1.1314.5485.363 2.8992 1.7766 2.8992 1.7766z" },
  "pandas": { title: "pandas", hex: "150458", category: "ai", path: "M16.922 0h2.623v18.104h-2.623zm-4.126 12.94h2.623v2.57h-2.623zm0-7.037h2.623v5.446h-2.623zm0 11.197h2.623v5.446h-2.623zM4.456 5.896h2.622V24H4.455zm4.213 2.559h2.623v2.57H8.67zm0 4.151h2.623v5.447H8.67zm0-11.187h2.623v5.446H8.67Z" },
  "jupyter": { title: "Jupyter", hex: "F37626", category: "ai", path: "M7.157 22.201A1.784 1.799 0 0 1 5.374 24a1.784 1.799 0 0 1-1.784-1.799 1.784 1.799 0 0 1 1.784-1.799 1.784 1.799 0 0 1 1.783 1.799zM20.582 1.427a1.415 1.427 0 0 1-1.415 1.428 1.415 1.427 0 0 1-1.416-1.428A1.415 1.427 0 0 1 19.167 0a1.415 1.427 0 0 1 1.415 1.427zM4.992 3.336A1.047 1.056 0 0 1 3.946 4.39a1.047 1.056 0 0 1-1.047-1.055A1.047 1.056 0 0 1 3.946 2.28a1.047 1.056 0 0 1 1.046 1.056zm7.336 1.517c3.769 0 7.06 1.38 8.768 3.424a9.363 9.363 0 0 0-3.393-4.547 9.238 9.238 0 0 0-5.377-1.728A9.238 9.238 0 0 0 6.95 3.73a9.363 9.363 0 0 0-3.394 4.547c1.713-2.04 5.004-3.424 8.772-3.424zm.001 13.295c-3.768 0-7.06-1.381-8.768-3.425a9.363 9.363 0 0 0 3.394 4.547A9.238 9.238 0 0 0 12.33 21a9.238 9.238 0 0 0 5.377-1.729 9.363 9.363 0 0 0 3.393-4.547c-1.712 2.044-5.003 3.425-8.772 3.425Z" },
  "opencv": { title: "OpenCV", hex: "5C3EE8", category: "ai", path: "M11.8992.8525C8.735.8525 6.17 3.4175 6.17 6.5817c0 2.102 1.1321 3.9398 2.8198 4.9366l1.6412-2.7849c.0411-.0699.0176-.1593-.0495-.2048-.6233-.4227-1.0328-1.137-1.0328-1.947 0-1.298 1.0524-2.3504 2.3505-2.3504 1.2981 0 2.3505 1.0524 2.3505 2.3505 0 .8098-.4095 1.5242-1.0328 1.947-.0671.0454-.0907.1348-.0495.2047l1.6414 2.785c1.6878-.9969 2.8199-2.8346 2.8199-4.9367 0-3.1642-2.5653-5.7292-5.7295-5.7292zm-6.17 10.8366C2.565 11.6891 0 14.2541 0 17.4183c0 3.1642 2.565 5.7292 5.7292 5.7292 3.1798 0 5.8074-2.6995 5.7275-5.8762H8.2313c-.0847 0-.1513.0717-.1519.1564-.0082 1.266-1.0644 2.3411-2.3502 2.3411-1.2981 0-2.3505-1.0524-2.3505-2.3505 0-1.2982 1.0524-2.3505 2.3505-2.3505.34 0 .663.0724.9547.2022.0713.0318.1566.0077.1962-.0595l1.6464-2.7935c-.8273-.4636-1.7815-.7279-2.7973-.7279zm15.4424.7614l-1.6366 2.7878c-.041.07-.0172.1594.05.2048.624.4217 1.0348 1.1354 1.0363 1.9452.0022 1.298-1.0483 2.352-2.3465 2.3542-1.298.0023-2.3523-1.0482-2.3545-2.3462-.0015-.8098.4068-1.5248 1.0294-1.9486.067-.0457.0905-.1353.0492-.2051l-1.6464-2.7818c-1.6859.9998-2.8146 2.8394-2.811 4.9415.0056 3.1641 2.575 5.7248 5.7393 5.7192 3.1641-.0054 5.7246-2.575 5.7192-5.7392-.0037-2.1022-1.139-3.938-2.8284-4.9318z" },
  "huggingface": { title: "Hugging Face", hex: "FFD21E", category: "ai", path: "M12.025 1.13c-5.77 0-10.449 4.647-10.449 10.378 0 1.112.178 2.181.503 3.185.064-.222.203-.444.416-.577a.96.96 0 0 1 .524-.15c.293 0 .584.124.84.284.278.173.48.408.71.694.226.282.458.611.684.951v-.014c.017-.324.106-.622.264-.874s.403-.487.762-.543c.3-.047.596.06.787.203s.31.313.4.467c.15.257.212.468.233.542.01.026.653 1.552 1.657 2.54.616.605 1.01 1.223 1.082 1.912.055.537-.096 1.059-.38 1.572.637.121 1.294.187 1.967.187.657 0 1.298-.063 1.921-.178-.287-.517-.44-1.041-.384-1.581.07-.69.465-1.307 1.081-1.913 1.004-.987 1.647-2.513 1.657-2.539.021-.074.083-.285.233-.542.09-.154.208-.323.4-.467a1.08 1.08 0 0 1 .787-.203c.359.056.604.29.762.543s.247.55.265.874v.015c.225-.34.457-.67.683-.952.23-.286.432-.52.71-.694.257-.16.547-.284.84-.285a.97.97 0 0 1 .524.151c.228.143.373.388.43.625l.006.04a10.3 10.3 0 0 0 .534-3.273c0-5.731-4.678-10.378-10.449-10.378M8.327 6.583a1.5 1.5 0 0 1 .713.174 1.487 1.487 0 0 1 .617 2.013c-.183.343-.762-.214-1.102-.094-.38.134-.532.914-.917.71a1.487 1.487 0 0 1 .69-2.803m7.486 0a1.487 1.487 0 0 1 .689 2.803c-.385.204-.536-.576-.916-.71-.34-.12-.92.437-1.103.094a1.487 1.487 0 0 1 .617-2.013 1.5 1.5 0 0 1 .713-.174m-10.68 1.55a.96.96 0 1 1 0 1.921.96.96 0 0 1 0-1.92m13.838 0a.96.96 0 1 1 0 1.92.96.96 0 0 1 0-1.92M8.489 11.458c.588.01 1.965 1.157 3.572 1.164 1.607-.007 2.984-1.155 3.572-1.164.196-.003.305.12.305.454 0 .886-.424 2.328-1.563 3.202-.22-.756-1.396-1.366-1.63-1.32q-.011.001-.02.006l-.044.026-.01.008-.03.024q-.018.017-.035.036l-.032.04a1 1 0 0 0-.058.09l-.014.025q-.049.088-.11.19a1 1 0 0 1-.083.116 1.2 1.2 0 0 1-.173.18q-.035.029-.075.058a1.3 1.3 0 0 1-.251-.243 1 1 0 0 1-.076-.107c-.124-.193-.177-.363-.337-.444-.034-.016-.104-.008-.2.022q-.094.03-.216.087-.06.028-.125.063l-.13.074q-.067.04-.136.086a3 3 0 0 0-.135.096 3 3 0 0 0-.26.219 2 2 0 0 0-.12.121 2 2 0 0 0-.106.128l-.002.002a2 2 0 0 0-.09.132l-.001.001a1.2 1.2 0 0 0-.105.212q-.013.036-.024.073c-1.139-.875-1.563-2.317-1.563-3.203 0-.334.109-.457.305-.454m.836 10.354c.824-1.19.766-2.082-.365-3.194-1.13-1.112-1.789-2.738-1.789-2.738s-.246-.945-.806-.858-.97 1.499.202 2.362c1.173.864-.233 1.45-.685.64-.45-.812-1.683-2.896-2.322-3.295s-1.089-.175-.938.647 2.822 2.813 2.562 3.244-1.176-.506-1.176-.506-2.866-2.567-3.49-1.898.473 1.23 2.037 2.16c1.564.932 1.686 1.178 1.464 1.53s-3.675-2.511-4-1.297c-.323 1.214 3.524 1.567 3.287 2.405-.238.839-2.71-1.587-3.216-.642-.506.946 3.49 2.056 3.522 2.064 1.29.33 4.568 1.028 5.713-.624m5.349 0c-.824-1.19-.766-2.082.365-3.194 1.13-1.112 1.789-2.738 1.789-2.738s.246-.945.806-.858.97 1.499-.202 2.362c-1.173.864.233 1.45.685.64.451-.812 1.683-2.896 2.322-3.295s1.089-.175.938.647-2.822 2.813-2.562 3.244 1.176-.506 1.176-.506 2.866-2.567 3.49-1.898-.473 1.23-2.037 2.16c-1.564.932-1.686 1.178-1.464 1.53s3.675-2.511 4-1.297c.323 1.214-3.524 1.567-3.287 2.405.238.839 2.71-1.587 3.216-.642.506.946-3.49 2.056-3.522 2.064-1.29.33-4.568 1.028-5.713-.624" },
  "anthropic": { title: "Anthropic", hex: "191919", category: "ai", path: "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" },
  "claude": { title: "Claude", hex: "D97757", category: "ai", path: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" },
  "langchain": { title: "LangChain", hex: "7FC8FF", category: "ai", path: "M13.796 0a6.93 6.93 0 0 0-4.91 2.019L5.451 5.455l3.273 3.27 3.432-3.432a2.284 2.284 0 0 1 3.277 0 2.28 2.28 0 0 1 0 3.275L12 12.001l3.273 3.273 3.433-3.435c2.692-2.692 2.692-7.127 0-9.82A6.92 6.92 0 0 0 13.796 0m-5.07 8.728-3.433 3.434c-2.692 2.693-2.692 7.126 0 9.819A6.92 6.92 0 0 0 10.203 24a6.93 6.93 0 0 0 4.911-2.02l3.432-3.432-3.271-3.272-3.433 3.433a2.284 2.284 0 0 1-3.277 0 2.28 2.28 0 0 1 0-3.276L12 12z" },
  "ollama": { title: "Ollama", hex: "000000", category: "ai", path: "M16.361 10.26a.894.894 0 0 0-.558.47l-.072.148.001.207c0 .193.004.217.059.353.076.193.152.312.291.448.24.238.51.3.872.205a.86.86 0 0 0 .517-.436.752.752 0 0 0 .08-.498c-.064-.453-.33-.782-.724-.897a1.06 1.06 0 0 0-.466 0zm-9.203.005c-.305.096-.533.32-.65.639a1.187 1.187 0 0 0-.06.52c.057.309.31.59.598.667.362.095.632.033.872-.205.14-.136.215-.255.291-.448.055-.136.059-.16.059-.353l.001-.207-.072-.148a.894.894 0 0 0-.565-.472 1.02 1.02 0 0 0-.474.007Zm4.184 2c-.131.071-.223.25-.195.383.031.143.157.288.353.407.105.063.112.072.117.136.004.038-.01.146-.029.243-.02.094-.036.194-.036.222.002.074.07.195.143.253.064.052.076.054.255.059.164.005.198.001.264-.03.169-.082.212-.234.15-.525-.052-.243-.042-.28.087-.355.137-.08.281-.219.324-.314a.365.365 0 0 0-.175-.48.394.394 0 0 0-.181-.033c-.126 0-.207.03-.355.124l-.085.053-.053-.032c-.219-.13-.259-.145-.391-.143a.396.396 0 0 0-.193.032zm.39-2.195c-.373.036-.475.05-.654.086-.291.06-.68.195-.951.328-.94.46-1.589 1.226-1.787 2.114-.04.176-.045.234-.045.53 0 .294.005.357.043.524.264 1.16 1.332 2.017 2.714 2.173.3.033 1.596.033 1.896 0 1.11-.125 2.064-.727 2.493-1.571.114-.226.169-.372.22-.602.039-.167.044-.23.044-.523 0-.297-.005-.355-.045-.531-.288-1.29-1.539-2.304-3.072-2.497a6.873 6.873 0 0 0-.855-.031zm.645.937a3.283 3.283 0 0 1 1.44.514c.223.148.537.458.671.662.166.251.26.508.303.82.02.143.01.251-.043.482-.08.345-.332.705-.672.957a3.115 3.115 0 0 1-.689.348c-.382.122-.632.144-1.525.138-.582-.006-.686-.01-.853-.042-.57-.107-1.022-.334-1.35-.68-.264-.28-.385-.535-.45-.946-.03-.192.025-.509.137-.776.136-.326.488-.73.836-.963.403-.269.934-.46 1.422-.512.187-.02.586-.02.773-.002zm-5.503-11a1.653 1.653 0 0 0-.683.298C5.617.74 5.173 1.666 4.985 2.819c-.07.436-.119 1.04-.119 1.503 0 .544.064 1.24.155 1.721.02.107.031.202.023.208a8.12 8.12 0 0 1-.187.152 5.324 5.324 0 0 0-.949 1.02 5.49 5.49 0 0 0-.94 2.339 6.625 6.625 0 0 0-.023 1.357c.091.78.325 1.438.727 2.04l.13.195-.037.064c-.269.452-.498 1.105-.605 1.732-.084.496-.095.629-.095 1.294 0 .67.009.803.088 1.266.095.555.288 1.143.503 1.534.071.128.243.393.264.407.007.003-.014.067-.046.141a7.405 7.405 0 0 0-.548 1.873c-.062.417-.071.552-.071.991 0 .56.031.832.148 1.279L3.42 24h1.478l-.05-.091c-.297-.552-.325-1.575-.068-2.597.117-.472.25-.819.498-1.296l.148-.29v-.177c0-.165-.003-.184-.057-.293a.915.915 0 0 0-.194-.25 1.74 1.74 0 0 1-.385-.543c-.424-.92-.506-2.286-.208-3.451.124-.486.329-.918.544-1.154a.787.787 0 0 0 .223-.531c0-.195-.07-.355-.224-.522a3.136 3.136 0 0 1-.817-1.729c-.14-.96.114-2.005.69-2.834.563-.814 1.353-1.336 2.237-1.475.199-.033.57-.028.776.01.226.04.367.028.512-.041.179-.085.268-.19.374-.431.093-.215.165-.333.36-.576.234-.29.46-.489.822-.729.413-.27.884-.467 1.352-.561.17-.035.25-.04.569-.04.319 0 .398.005.569.04a4.07 4.07 0 0 1 1.914.997c.117.109.398.457.488.602.034.057.095.177.132.267.105.241.195.346.374.43.14.068.286.082.503.045.343-.058.607-.053.943.016 1.144.23 2.14 1.173 2.581 2.437.385 1.108.276 2.267-.296 3.153-.097.15-.193.27-.333.419-.301.322-.301.722-.001 1.053.493.539.801 1.866.708 3.036-.062.772-.26 1.463-.533 1.854a2.096 2.096 0 0 1-.224.258.916.916 0 0 0-.194.25c-.054.109-.057.128-.057.293v.178l.148.29c.248.476.38.823.498 1.295.253 1.008.231 2.01-.059 2.581a.845.845 0 0 0-.044.098c0 .006.329.009.732.009h.73l.02-.074.036-.134c.019-.076.057-.3.088-.516.029-.217.029-1.016 0-1.258-.11-.875-.295-1.57-.597-2.226-.032-.074-.053-.138-.046-.141.008-.005.057-.074.108-.152.376-.569.607-1.284.724-2.228.031-.26.031-1.378 0-1.628-.083-.645-.182-1.082-.348-1.525a6.083 6.083 0 0 0-.329-.7l-.038-.064.131-.194c.402-.604.636-1.262.727-2.04a6.625 6.625 0 0 0-.024-1.358 5.512 5.512 0 0 0-.939-2.339 5.325 5.325 0 0 0-.95-1.02 8.097 8.097 0 0 1-.186-.152.692.692 0 0 1 .023-.208c.208-1.087.201-2.443-.017-3.503-.19-.924-.535-1.658-.98-2.082-.354-.338-.716-.482-1.15-.455-.996.059-1.8 1.205-2.116 3.01a6.805 6.805 0 0 0-.097.726c0 .036-.007.066-.015.066a.96.96 0 0 1-.149-.078A4.857 4.857 0 0 0 12 3.03c-.832 0-1.687.243-2.456.698a.958.958 0 0 1-.148.078c-.008 0-.015-.03-.015-.066a6.71 6.71 0 0 0-.097-.725C8.997 1.392 8.337.319 7.46.048a2.096 2.096 0 0 0-.585-.041Zm.293 1.402c.248.197.523.759.682 1.388.03.113.06.244.069.292.007.047.026.152.041.233.067.365.098.76.102 1.24l.002.475-.12.175-.118.178h-.278c-.324 0-.646.041-.954.124l-.238.06c-.033.007-.038-.003-.057-.144a8.438 8.438 0 0 1 .016-2.323c.124-.788.413-1.501.696-1.711.067-.05.079-.049.157.013zm9.825-.012c.17.126.358.46.498.888.28.854.36 2.028.212 3.145-.019.14-.024.151-.057.144l-.238-.06a3.693 3.693 0 0 0-.954-.124h-.278l-.119-.178-.119-.175.002-.474c.004-.669.066-1.19.214-1.772.157-.623.434-1.185.68-1.382.078-.062.09-.063.159-.012z" },
  "githubcopilot": { title: "GitHub Copilot", hex: "000000", category: "ai", path: "M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z" },
  "googlecloud": { title: "Google Cloud", hex: "4285F4", category: "cloud", path: "M12.19 2.38a9.344 9.344 0 0 0-9.234 6.893c.053-.02-.055.013 0 0-3.875 2.551-3.922 8.11-.247 10.941l.006-.007-.007.03a6.717 6.717 0 0 0 4.077 1.356h5.173l.03.03h5.192c6.687.053 9.376-8.605 3.835-12.35a9.365 9.365 0 0 0-2.821-4.552l-.043.043.006-.05A9.344 9.344 0 0 0 12.19 2.38zm-.358 4.146c1.244-.04 2.518.368 3.486 1.15a5.186 5.186 0 0 1 1.862 4.078v.518c3.53-.07 3.53 5.262 0 5.193h-5.193l-.008.009v-.04H6.785a2.59 2.59 0 0 1-1.067-.23h.001a2.597 2.597 0 1 1 3.437-3.437l3.013-3.012A6.747 6.747 0 0 0 8.11 8.24c.018-.01.04-.026.054-.023a5.186 5.186 0 0 1 3.67-1.69z" },
  "cloudflare": { title: "Cloudflare", hex: "F38020", category: "cloud", path: "M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727" },
  "vercel": { title: "Vercel", hex: "000000", category: "cloud", path: "m12 1.608 12 20.784H0Z" },
  "netlify": { title: "Netlify", hex: "00C7B7", category: "cloud", path: "M6.49 19.04h-.23L5.13 17.9v-.23l1.73-1.71h1.2l.15.15v1.2L6.5 19.04ZM5.13 6.31V6.1l1.13-1.13h.23L8.2 6.68v1.2l-.15.15h-1.2L5.13 6.31Zm9.96 9.09h-1.65l-.14-.13v-3.83c0-.68-.27-1.2-1.1-1.23-.42 0-.9 0-1.43.02l-.07.08v4.96l-.14.14H8.9l-.13-.14V8.73l.13-.14h3.7a2.6 2.6 0 0 1 2.61 2.6v4.08l-.13.14Zm-8.37-2.44H.14L0 12.82v-1.64l.14-.14h6.58l.14.14v1.64l-.14.14Zm17.14 0h-6.58l-.14-.14v-1.64l.14-.14h6.58l.14.14v1.64l-.14.14ZM11.05 6.55V1.64l.14-.14h1.65l.14.14v4.9l-.14.14h-1.65l-.14-.13Zm0 15.81v-4.9l.14-.14h1.65l.14.13v4.91l-.14.14h-1.65l-.14-.14Z" },
  "digitalocean": { title: "DigitalOcean", hex: "0080FF", category: "cloud", path: "M12.04 0C5.408-.02.005 5.37.005 11.992h4.638c0-4.923 4.882-8.731 10.064-6.855a6.95 6.95 0 014.147 4.148c1.889 5.177-1.924 10.055-6.84 10.064v-4.61H7.391v4.623h4.61V24c7.86 0 13.967-7.588 11.397-15.83-1.115-3.59-3.985-6.446-7.575-7.575A12.8 12.8 0 0012.039 0zM7.39 19.362H3.828v3.564H7.39zm-3.563 0v-2.978H.85v2.978z" },
  "flydotio": { title: "Fly.io", hex: "24175B", category: "cloud", path: "M11.987 0c-2.45-.01-5.002.925-6.541 2.897-1.17 1.502-1.664 3.474-1.49 5.356.29 2.112 1.476 3.96 2.676 5.672a41.5 41.5 0 0 0 4.216 4.831c-1.063.832-1.943 2.286-1.357 3.644.821 2.32 4.665 2.05 5.122-.372.39-1.288-.694-2.533-1.428-3.309 2.388-2.431 4.706-5.036 6.17-8.145.595-1.32.902-2.802.614-4.24-.28-2.341-1.823-4.473-3.967-5.46C14.76.266 13.364.016 11.987 0m-.236 1.577v15.534C9.881 13.483 7.724 9.266 8.73 5.069c.35-1.539 1.253-3.309 3.02-3.492m1.996.04c1.534.357 3.031 1.096 3.906 2.48 1.3 1.93 1.318 4.55.1 6.521-1.268 2.395-3.06 4.463-4.916 6.415 1.472-2.974 3.074-6.106 3.182-9.5-.043-2.08-.438-4.612-2.272-5.916M11.97 20.103c.848.342 1.597 1.983.153 2.173-.664.15-1.367-.599-.995-1.222.213-.355.488-.73.842-.95" },
  "docker": { title: "Docker", hex: "2496ED", category: "devops", path: "M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.082.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z" },
  "kubernetes": { title: "Kubernetes", hex: "326CE5", category: "devops", path: "M10.204 14.35l.007.01-.999 2.413a5.171 5.171 0 0 1-2.075-2.597l2.578-.437.004.005a.44.44 0 0 1 .484.606zm-.833-2.129a.44.44 0 0 0 .173-.756l.002-.011L7.585 9.7a5.143 5.143 0 0 0-.73 3.255l2.514-.725.002-.009zm1.145-1.98a.44.44 0 0 0 .699-.337l.01-.005.15-2.62a5.144 5.144 0 0 0-3.01 1.442l2.147 1.523.004-.002zm.76 2.75l.723.349.722-.347.18-.78-.5-.623h-.804l-.5.623.179.779zm1.5-3.095a.44.44 0 0 0 .7.336l.008.003 2.134-1.513a5.188 5.188 0 0 0-2.992-1.442l.148 2.615.002.001zm10.876 5.97l-5.773 7.181a1.6 1.6 0 0 1-1.248.594l-9.261.003a1.6 1.6 0 0 1-1.247-.596l-5.776-7.18a1.583 1.583 0 0 1-.307-1.34L2.1 5.573c.108-.47.425-.864.863-1.073L11.305.513a1.606 1.606 0 0 1 1.385 0l8.345 3.985c.438.209.755.604.863 1.073l2.062 8.955c.108.47-.005.963-.308 1.34zm-3.289-2.057c-.042-.01-.103-.026-.145-.034-.174-.033-.315-.025-.479-.038-.35-.037-.638-.067-.895-.148-.105-.04-.18-.165-.216-.216l-.201-.059a6.45 6.45 0 0 0-.105-2.332 6.465 6.465 0 0 0-.936-2.163c.052-.047.15-.133.177-.159.008-.09.001-.183.094-.282.197-.185.444-.338.743-.522.142-.084.273-.137.415-.242.032-.024.076-.062.11-.089.24-.191.295-.52.123-.736-.172-.216-.506-.236-.745-.045-.034.027-.08.062-.111.088-.134.116-.217.23-.33.35-.246.25-.45.458-.673.609-.097.056-.239.037-.303.033l-.19.135a6.545 6.545 0 0 0-4.146-2.003l-.012-.223c-.065-.062-.143-.115-.163-.25-.022-.268.015-.557.057-.905.023-.163.061-.298.068-.475.001-.04-.001-.099-.001-.142 0-.306-.224-.555-.5-.555-.275 0-.499.249-.499.555l.001.014c0 .041-.002.092 0 .128.006.177.044.312.067.475.042.348.078.637.056.906a.545.545 0 0 1-.162.258l-.012.211a6.424 6.424 0 0 0-4.166 2.003 8.373 8.373 0 0 1-.18-.128c-.09.012-.18.04-.297-.029-.223-.15-.427-.358-.673-.608-.113-.12-.195-.234-.329-.349-.03-.026-.077-.062-.111-.088a.594.594 0 0 0-.348-.132.481.481 0 0 0-.398.176c-.172.216-.117.546.123.737l.007.005.104.083c.142.105.272.159.414.242.299.185.546.338.743.522.076.082.09.226.1.288l.16.143a6.462 6.462 0 0 0-1.02 4.506l-.208.06c-.055.072-.133.184-.215.217-.257.081-.546.11-.895.147-.164.014-.305.006-.48.039-.037.007-.09.02-.133.03l-.004.002-.007.002c-.295.071-.484.342-.423.608.061.267.349.429.645.365l.007-.001.01-.003.129-.029c.17-.046.294-.113.448-.172.33-.118.604-.217.87-.256.112-.009.23.069.288.101l.217-.037a6.5 6.5 0 0 0 2.88 3.596l-.09.218c.033.084.069.199.044.282-.097.252-.263.517-.452.813-.091.136-.185.242-.268.399-.02.037-.045.095-.064.134-.128.275-.034.591.213.71.248.12.556-.007.69-.282v-.002c.02-.039.046-.09.062-.127.07-.162.094-.301.144-.458.132-.332.205-.68.387-.897.05-.06.13-.082.215-.105l.113-.205a6.453 6.453 0 0 0 4.609.012l.106.192c.086.028.18.042.256.155.136.232.229.507.342.84.05.156.074.295.145.457.016.037.043.09.062.129.133.276.442.402.69.282.247-.118.341-.435.213-.71-.02-.039-.045-.096-.065-.134-.083-.156-.177-.261-.268-.398-.19-.296-.346-.541-.443-.793-.04-.13.007-.21.038-.294-.018-.022-.059-.144-.083-.202a6.499 6.499 0 0 0 2.88-3.622c.064.01.176.03.213.038.075-.05.144-.114.28-.104.266.039.54.138.87.256.154.06.277.128.448.173.036.01.088.019.13.028l.009.003.007.001c.297.064.584-.098.645-.365.06-.266-.128-.537-.423-.608zM16.4 9.701l-1.95 1.746v.005a.44.44 0 0 0 .173.757l.003.01 2.526.728a5.199 5.199 0 0 0-.108-1.674A5.208 5.208 0 0 0 16.4 9.7zm-4.013 5.325a.437.437 0 0 0-.404-.232.44.44 0 0 0-.372.233h-.002l-1.268 2.292a5.164 5.164 0 0 0 3.326.003l-1.27-2.296h-.01zm1.888-1.293a.44.44 0 0 0-.27.036.44.44 0 0 0-.214.572l-.003.004 1.01 2.438a5.15 5.15 0 0 0 2.081-2.615l-2.6-.44-.004.005z" },
  "helm": { title: "Helm", hex: "0F1689", category: "devops", path: "M12.337 0c-.475 0-.861 1.016-.861 2.269 0 .527.069 1.011.183 1.396a8.514 8.514 0 0 0-3.961 1.22 5.229 5.229 0 0 0-.595-1.093c-.606-.866-1.34-1.436-1.79-1.43a.381.381 0 0 0-.217.066c-.39.273-.123 1.326.596 2.353.267.381.559.705.84.948a8.683 8.683 0 0 0-1.528 1.716h1.734a7.179 7.179 0 0 1 5.381-2.421 7.18 7.18 0 0 1 5.382 2.42h1.733a8.687 8.687 0 0 0-1.32-1.53c.35-.249.735-.643 1.078-1.133.719-1.027.986-2.08.596-2.353a.382.382 0 0 0-.217-.065c-.45-.007-1.184.563-1.79 1.43a4.897 4.897 0 0 0-.676 1.325 8.52 8.52 0 0 0-3.899-1.42c.12-.39.193-.887.193-1.429 0-1.253-.386-2.269-.862-2.269zM1.624 9.443v5.162h1.358v-1.968h1.64v1.968h1.357V9.443H4.62v1.838H2.98V9.443zm5.912 0v5.162h3.21v-1.108H8.893v-.95h1.64v-1.142h-1.64v-.84h1.853V9.443zm4.698 0v5.162h3.218v-1.362h-1.86v-3.8zm4.706 0v5.162h1.364v-2.643l1.357 1.225 1.35-1.232v2.65h1.365V9.443h-.614l-2.1 1.914-2.109-1.914zm-11.82 7.28a8.688 8.688 0 0 0 1.412 1.548 5.206 5.206 0 0 0-.841.948c-.719 1.027-.985 2.08-.596 2.353.39.273 1.289-.338 2.007-1.364a5.23 5.23 0 0 0 .595-1.092 8.514 8.514 0 0 0 3.961 1.219 5.01 5.01 0 0 0-.183 1.396c0 1.253.386 2.269.861 2.269.476 0 .862-1.016.862-2.269 0-.542-.072-1.04-.193-1.43a8.52 8.52 0 0 0 3.9-1.42c.121.4.352.865.675 1.327.719 1.026 1.617 1.637 2.007 1.364.39-.273.123-1.326-.596-2.353-.343-.49-.727-.885-1.077-1.135a8.69 8.69 0 0 0 1.202-1.36h-1.771a7.174 7.174 0 0 1-5.227 2.252 7.174 7.174 0 0 1-5.226-2.252z" },
  "terraform": { title: "Terraform", hex: "844FBA", category: "devops", path: "M1.44 0v7.575l6.561 3.79V3.787zm21.12 4.227l-6.561 3.791v7.574l6.56-3.787zM8.72 4.23v7.575l6.561 3.787V8.018zm0 8.405v7.575L15.28 24v-7.578z" },
  "ansible": { title: "Ansible", hex: "EE0000", category: "devops", path: "M10.617 11.473l4.686 3.695-3.102-7.662zM12 0C5.371 0 0 5.371 0 12s5.371 12 12 12 12-5.371 12-12S18.629 0 12 0zm5.797 17.305c-.011.471-.403.842-.875.83-.236 0-.416-.09-.664-.293l-6.19-5-2.079 5.203H6.191L11.438 5.44c.124-.314.427-.52.764-.506.326-.014.63.189.742.506l4.774 11.494c.045.111.08.234.08.348-.001.009-.001.009-.001.023z" },
  "nginx": { title: "NGINX", hex: "009639", category: "devops", path: "M12 0L1.605 6v12L12 24l10.395-6V6L12 0zm6 16.59c0 .705-.646 1.29-1.529 1.29-.631 0-1.351-.255-1.801-.81l-6-7.141v6.66c0 .721-.57 1.29-1.274 1.29H7.32c-.721 0-1.29-.6-1.29-1.29V7.41c0-.705.63-1.29 1.5-1.29.646 0 1.38.255 1.83.81l5.97 7.141V7.41c0-.721.6-1.29 1.29-1.29h.075c.72 0 1.29.6 1.29 1.29v9.18H18z" },
  "githubactions": { title: "GitHub Actions", hex: "2088FF", category: "devops", path: "M10.984 13.836a.5.5 0 0 1-.353-.146l-.745-.743a.5.5 0 1 1 .706-.708l.392.391 1.181-1.18a.5.5 0 0 1 .708.707l-1.535 1.533a.504.504 0 0 1-.354.146zm9.353-.147l1.534-1.532a.5.5 0 0 0-.707-.707l-1.181 1.18-.392-.391a.5.5 0 1 0-.706.708l.746.743a.497.497 0 0 0 .706-.001zM4.527 7.452l2.557-1.585A1 1 0 0 0 7.09 4.17L4.533 2.56A1 1 0 0 0 3 3.406v3.196a1.001 1.001 0 0 0 1.527.85zm2.03-2.436L4 6.602V3.406l2.557 1.61zM24 12.5c0 1.93-1.57 3.5-3.5 3.5a3.503 3.503 0 0 1-3.46-3h-2.08a3.503 3.503 0 0 1-3.46 3 3.502 3.502 0 0 1-3.46-3h-.558c-.972 0-1.85-.399-2.482-1.042V17c0 1.654 1.346 3 3 3h.04c.244-1.693 1.7-3 3.46-3 1.93 0 3.5 1.57 3.5 3.5S13.43 24 11.5 24a3.502 3.502 0 0 1-3.46-3H8c-2.206 0-4-1.794-4-4V9.899A5.008 5.008 0 0 1 0 5c0-2.757 2.243-5 5-5s5 2.243 5 5a5.005 5.005 0 0 1-4.952 4.998A2.482 2.482 0 0 0 7.482 12h.558c.244-1.693 1.7-3 3.46-3a3.502 3.502 0 0 1 3.46 3h2.08a3.503 3.503 0 0 1 3.46-3c1.93 0 3.5 1.57 3.5 3.5zm-15 8c0 1.378 1.122 2.5 2.5 2.5s2.5-1.122 2.5-2.5-1.122-2.5-2.5-2.5S9 19.122 9 20.5zM5 9c2.206 0 4-1.794 4-4S7.206 1 5 1 1 2.794 1 5s1.794 4 4 4zm9 3.5c0-1.378-1.122-2.5-2.5-2.5S9 11.122 9 12.5s1.122 2.5 2.5 2.5 2.5-1.122 2.5-2.5zm9 0c0-1.378-1.122-2.5-2.5-2.5S18 11.122 18 12.5s1.122 2.5 2.5 2.5 2.5-1.122 2.5-2.5zm-13 8a.5.5 0 1 0 1 0 .5.5 0 0 0-1 0zm2 0a.5.5 0 1 0 1 0 .5.5 0 0 0-1 0zm12 0c0 1.93-1.57 3.5-3.5 3.5a3.503 3.503 0 0 1-3.46-3.002c-.007.001-.013.005-.021.005l-.506.017h-.017a.5.5 0 0 1-.016-.999l.506-.017c.018-.002.035.006.052.007A3.503 3.503 0 0 1 20.5 17c1.93 0 3.5 1.57 3.5 3.5zm-1 0c0-1.378-1.122-2.5-2.5-2.5S18 19.122 18 20.5s1.122 2.5 2.5 2.5 2.5-1.122 2.5-2.5z" },
  "gitlab": { title: "GitLab", hex: "FC6D26", category: "devops", path: "m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z" },
  "jenkins": { title: "Jenkins", hex: "D24939", category: "devops", path: "M2.872 24h-.975a3.866 3.866 0 01-.07-.197c-.215-.666-.594-1.49-.692-2.154-.146-.984.78-1.039 1.374-1.465.915-.66 1.635-1.025 2.627-1.62.295-.179 1.182-.624 1.281-.829.201-.408-.345-.982-.49-1.3-.225-.507-.345-.937-.376-1.435-.824-.13-1.455-.627-1.844-1.185-.63-.925-1.066-2.635-.525-3.936.045-.103.254-.305.285-.463.06-.308-.105-.72-.12-1.048-.06-1.692.284-3.15 1.425-3.66.463-1.84 2.113-2.453 3.673-3.367.58-.342 1.224-.562 1.89-.807 2.372-.877 6.027-.712 7.994.783.836.633 2.176 1.97 2.656 2.939 1.262 2.555 1.17 6.825.287 9.934-.12.421-.29 1.032-.533 1.533-.168.35-.689 1.05-.625 1.36.064.314 1.19 1.17 1.432 1.395.434.422 1.26.975 1.324 1.5.07.557-.248 1.336-.41 1.875-.217.721-.436 1.441-.654 2.131H2.87zm11.104-3.54c-.545-.3-1.361-.622-2.065-.757-.87-.164-.78 1.188-.75 1.994.03.643.36 1.316.51 1.744.076.197.09.41.256.449.3.068 1.29-.326 1.575-.479.6-.328 1.064-.844 1.574-1.189.016-.17.016-.34.03-.508a2.648 2.648 0 00-1.095-.277c.314-.15.75-.15 1.035-.332l.016-.193c-.496-.03-.69-.254-1.021-.436zm7.454 2.935a17.78 17.78 0 00.465-1.752c.06-.287.215-.918.178-1.176-.059-.459-.684-.799-1.004-1.086-.584-.525-.95-.975-1.56-1.469-.249.375-.78.615-.983.914 1.447-.689 1.71 2.625 1.141 3.69.09.329.391.45.514.735l-.086.166h1.29c.013 0 .03 0 .044.014zm-6.634-.012c-.05-.074-.1-.135-.15-.209l-.301.195h.45zm2.77 0c.008-.209.018-.404.03-.598-.53.029-.825-.48-1.196-.527-.324-.045-.6.361-1.02.195-.095.105-.183.227-.284.316.154.18.295.375.424.584h.815c.014-.164.135-.285.3-.285.165 0 .284.121.284.27h.66zm2.116 0c-.314-.479-.947-.898-1.68-.555l-.03.541h1.71zm-8.51 0l-.104-.344c-.225-.72-.36-1.26-.405-1.68-.914-.436-1.875-.87-2.654-1.426-.15-.105-1.109-1.35-1.23-1.305-1.739.676-3.359 1.86-4.814 2.984.256.557.48 1.141.69 1.74h8.505zm8.265-2.113c-.029-.512-.164-1.56-.48-1.74-.66-.39-1.846.78-2.34.943.045.15.135.271.15.48.285-.074.645-.029.898.092-.299.03-.629.03-.824.164-.074.195.016.48-.029.764.69.197 1.5.303 2.385.332.164-.227.225-.645.211-1.082zm-4.08-.36c-.044.375.046.51.12.943 1.26.391 1.034-1.74-.135-.959zM8.76 19.5c-.45.457 1.27 1.082 1.814 1.115 0-.29.165-.564.135-.77-.65-.118-1.502-.042-1.945-.347zm5.565.215c0 .043-.061.03-.068.064.58.451 1.014.545 1.802.51.354-.262.67-.563 1.043-.807-.855.074-1.931.607-2.774.23zm3.42-17.726c-1.606-.906-4.35-1.591-6.076-.731-1.38.692-3.27 1.84-3.899 3.292.6 1.402-.166 2.686-.226 4.109-.018.757.36 1.42.391 2.242-.2.338-.825.38-1.26.356-.146-.729-.4-1.549-1.155-1.63-1.064-.116-1.845.764-1.89 1.683-.06 1.08.833 2.864 2.085 2.745.488-.046.608-.54 1.139-.54.285.57-.445.75-.523 1.154-.016.105.06.511.104.705.233.944.744 2.16 1.245 2.88.635.9 1.884 1.051 3.229 1.141.24-.525 1.125-.48 1.706-.346-.691-.27-1.336-.945-1.875-1.529-.615-.676-1.23-1.41-1.261-2.28 1.155 1.604 2.1 3 4.2 3.704 1.59.525 3.45-.254 4.664-1.109.51-.359.811-.93 1.17-1.439 1.35-1.936 1.98-4.71 1.846-7.394-.06-1.111-.06-2.221-.436-2.955-.389-.781-1.695-1.471-2.475-.781-.15-.764.63-1.23 1.545-.96-.66-.854-1.336-1.858-2.266-2.384zM13.58 14.896c.615 1.544 2.724 1.363 4.505 1.323-.084.194-.256.435-.465.515-.57.232-2.145.408-2.937-.012-.506-.27-.824-.873-1.102-1.227-.137-.172-.795-.608-.012-.609zm.164-.87c.893.464 2.52.517 3.731.48.066.267.066.593.068.913-1.55.08-3.386-.304-3.794-1.395h-.005zm6.675-.586c-.473.9-1.145 1.897-2.539 1.928-.023-.284-.045-.735 0-.904 1.064-.103 1.727-.646 2.543-1.017zm-.649-.667c-1.02.66-2.154 1.375-3.824 1.21-.351-.31-.485-1-.14-1.458.181.313.06.885.57.97.944.165 2.038-.579 2.73-.84.42-.713-.046-.976-.42-1.433-.782-.93-1.83-2.1-1.802-3.51.314-.224.346.346.391.45.404.96 1.424 2.175 2.174 3 .18.21.48.39.51.524.092.39-.254.854-.209 1.11zm-13.439-.675c-.314-.184-.393-.99-.768-1.01-.535-.03-.438 1.05-.436 1.68-.37-.33-.435-1.365-.164-1.89-.308-.15-.445.164-.618.284.22-1.59 2.34-.734 1.99.96zM4.713 5.995c-.685.756-.54 2.174-.459 3.188 1.244-.785 2.898.06 2.883 1.394.595-.016.223-.744.115-1.215-.353-1.528.592-3.187.041-4.59-1.064.084-1.939.52-2.578 1.215zm9.12 1.113c.307.562.404 1.148.84 1.57.195.19.574.424.387.95-.045.121-.365.391-.551.45-.674.195-2.254.03-1.721-.81.563.015 1.314.36 1.732-.045-.314-.524-.885-1.53-.674-2.13zm6.198-.013h.068c.33.668.6 1.375 1.004 1.965-.27.628-2.053 1.19-2.023.057.39-.17 1.05-.035 1.395-.25-.193-.556-.48-1.006-.434-1.771zm-6.927-1.617c-1.422-.33-2.131.592-2.56 1.553-.384-.094-.231-.615-.135-.883.255-.701 1.28-1.633 2.119-1.506.359.057.848.386.576.834zM9.642 1.593c-1.56.44-3.56 1.574-4.2 2.974.495-.07.84-.321 1.33-.351.186-.016.428.074.641.015.424-.104.78-1.065 1.102-1.41.31-.345.685-.496.94-.81.167-.09.409-.074.42-.33-.073-.075-.15-.135-.232-.105v.017z" },
  "argo": { title: "Argo", hex: "EF7B4D", category: "devops", path: "M12.581 0c.436.037.871.1 1.299.186 1.679.383 3.121 1.213 4.382 2.365 1.161 1.06 1.917 2.372 2.335 3.881.089.321.216.56.586.624.205.035.238.245.239.43.003.646.002 1.294.002 1.94l-.002 1.21c-.001.356-.116.479-.466.474-.211-.003-.293.119-.344.291-.146.489-.33.966-.552 1.426-.818 1.682-2.084 2.938-3.688 3.87-.077.045-.155.088-.233.131-.252.137-.258.146-.155.415.114.299.358.529.664.625.269.096.553.134.827.21a.672.672 0 0 1 .236.094c-.066.082-.156.067-.231.082-.36.073-.713.184-1.086.17a1.275 1.275 0 0 1-.438-.064c-.114-.045-.152-.006-.176.109a5.354 5.354 0 0 0-.084.92c-.015.617-.071 1.23-.112 1.844-.042.598-.018.651.558.842.281.094.563.187.842.286.069.024.15.038.192.117-.04.057-.098.035-.146.035-.493.003-.985.005-1.478.001-.524-.005-.806-.282-.845-.803-.055-.762-.12-1.524-.182-2.286a.947.947 0 0 0-.026-.12c-.079.455-.065.879-.084 1.298-.023.528-.008 1.057-.007 1.584 0 .27.086.388.335.483.359.135.711.295 1.114.262.141-.012.276.062.402.129.032.017.073.033.069.073-.004.043-.049.047-.084.045-.657-.019-1.317.065-1.972-.028-.323-.046-.533-.236-.631-.552-.094-.303-.114-.617-.137-.93-.046-.626-.078-1.253-.116-1.88a.222.222 0 0 0-.061-.171.282.282 0 0 0-.031.193c-.002.956-.002 1.911-.001 2.866 0 .388.123.575.494.708.481.172.976.298 1.47.423.11.028.225.047.242.192h-1.852c-.051-.01-.103-.022-.155-.03-.701-.1-1.001-.372-1.143-1.042l-.067-.331-.226-1.103c-.069.12-.118.25-.144.386-.083.399-.151.802-.243 1.2-.113.493-.444.763-.932.857l-.33.063H8.558c.057-.171.216-.185.355-.221.476-.127.96-.223 1.417-.409a.603.603 0 0 0 .397-.521c.058-.435.002-.865-.013-1.296a1.528 1.528 0 0 0-.078-.315.405.405 0 0 0-.071.207c-.026.296-.049.591-.075.886-.038.432-.273.716-.679.81a1.702 1.702 0 0 1-.37.045c-.557.003-1.115-.001-1.673-.005-.048 0-.109.019-.148-.065.178-.103.377-.168.582-.187a5.67 5.67 0 0 0 .939-.193c.42-.114.522-.249.512-.687-.023-.931-.091-1.86-.069-2.791.004-.184.001-.368.001-.551a2.387 2.387 0 0 0-.05.385 40.299 40.299 0 0 1-.186 2.623c-.052.513-.296.748-.804.805-.446.051-.889.002-1.332-.02-.108-.006-.234.012-.339-.064.043-.066.106-.07.16-.087.362-.115.725-.224 1.086-.344.246-.081.35-.235.355-.492a2.241 2.241 0 0 0-.003-.232 45.315 45.315 0 0 1-.105-2.149 5.487 5.487 0 0 0-.035-.478c-.024-.188-.131-.287-.295-.258-.505.092-.99-.006-1.473-.139-.059-.016-.134-.007-.178-.088a.986.986 0 0 1 .285-.09c.255-.052.507-.121.753-.208.312-.112.564-.347.695-.651.089-.203.056-.317-.112-.398-1.418-.683-2.512-1.73-3.391-3.017a8.152 8.152 0 0 1-1.123-2.447c-.067-.246-.156-.3-.383-.26-.306.053-.401.006-.535-.273v-3.49c.144-.303.205-.341.534-.329.235.01.247-.004.309-.242.396-1.508 1.082-2.861 2.171-3.988C6.9 1.42 8.523.631 10.34.203c.456-.108.922-.15 1.387-.203h.854Zm7.974 8.948a7.34 7.34 0 0 0-.048-.938 8.353 8.353 0 0 0-.099-.65c-.598-2.964-2.344-5.02-5.051-6.268-1.553-.715-3.21-.835-4.878-.511-3.248.633-5.396 2.583-6.539 5.652-.436 1.173-.495 2.406-.37 3.65.087.935.339 1.846.745 2.694.585 1.213 1.444 2.207 2.477 3.058.343.286.719.528 1.121.719.235.111.247.105.245-.146.006-.16.003-.32-.009-.48-.125-1.02-.142-2.045-.169-3.069a.392.392 0 0 0-.184-.353c-.385-.268-.713-.592-.921-1.019-.474-.97-.372-2.361.813-3.215.136-.097.217-.19.198-.373a1.724 1.724 0 0 1 .031-.442c.177-1.187.748-2.138 1.722-2.84.68-.492 1.442-.772 2.286-.782.483-.007.953.11 1.414.244 1.609.467 2.846 2.07 2.845 3.697a.64.64 0 0 0 .268.565c.463.371.821.83.943 1.426.22 1.077-.083 1.982-.979 2.634-.266.194-.347.406-.333.698.002.047 0 .095-.002.142l-.062 1.439c-.025.586-.138 1.165-.117 1.754.008.223.006.226.201.128a7.46 7.46 0 0 0 2.393-1.903c1.32-1.577 2.074-3.372 2.059-5.511ZM9.117 12.102c1.489.021 2.443-1.578 1.716-2.879a1.937 1.937 0 0 0-1.699-.991c-1.094-.004-1.954.822-1.958 1.881-.005 1.148.813 1.985 1.941 1.989Zm5.794 0c1.101.002 1.935-.823 1.935-1.917 0-1.091-.846-1.949-1.92-1.947-1.064.003-1.94.866-1.943 1.915-.003 1.105.831 1.948 1.928 1.949Zm-1.472 1.937c-.208.128-.407.277-.63.384-.536.257-1.063.257-1.579-.048-.158-.094-.308-.201-.464-.298-.047-.028-.092-.103-.15-.062-.044.03-.01.1-.001.151.037.179.064.362.082.544.027.565.293.992.742 1.31a.984.984 0 0 0 .791.186c.565-.119 1.025-.614 1.124-1.218.043-.266.005-.544.109-.803a.133.133 0 0 0-.024-.146Zm-8.78-4.92c-.012-1.102.143-2.055.54-2.961.633-1.443 1.642-2.553 2.98-3.374a.378.378 0 0 1 .459.067c.06.06.036.118.01.178a1.09 1.09 0 0 1-.48.51c-1.079.639-1.829 1.571-2.357 2.688a6.325 6.325 0 0 0-.618 2.986c.055 1.309.439 2.516 1.213 3.588.088.104.148.23.173.365.01.08.059.168-.031.228a.312.312 0 0 1-.288.041.502.502 0 0 1-.234-.185c-.72-.979-1.193-2.056-1.331-3.273-.036-.326-.004-.653-.036-.858ZM8.94 2.34a.373.373 0 0 1 .378-.382c.211.001.409.226.416.473.004.138-.309.39-.476.386-.189-.005-.318-.2-.318-.477Zm-.465 7.48a.609.609 0 0 1 .586-.631c.38-.003.671.271.675.633.004.356-.27.622-.639.621-.38-.002-.621-.241-.622-.623Zm6.496.623c-.381-.002-.625-.255-.621-.646a.635.635 0 0 1 .596-.613.656.656 0 0 1 .669.643c.001.354-.275.618-.644.616Z" },
  "grafana": { title: "Grafana", hex: "F46800", category: "devops", path: "M23.02 10.59a8.578 8.578 0 0 0-.862-3.034 8.911 8.911 0 0 0-1.789-2.445c.337-1.342-.413-2.505-.413-2.505-1.292-.08-2.113.4-2.416.62-.052-.02-.102-.044-.154-.064-.22-.089-.446-.172-.677-.247-.231-.073-.47-.14-.711-.197a9.867 9.867 0 0 0-.875-.161C14.557.753 12.94 0 12.94 0c-1.804 1.145-2.147 2.744-2.147 2.744l-.018.093c-.098.029-.2.057-.298.088-.138.042-.275.094-.413.143-.138.055-.275.107-.41.166a8.869 8.869 0 0 0-1.557.87l-.063-.029c-2.497-.955-4.716.195-4.716.195-.203 2.658.996 4.33 1.235 4.636a11.608 11.608 0 0 0-.607 2.635C1.636 12.677.953 15.014.953 15.014c1.926 2.214 4.171 2.351 4.171 2.351.003-.002.006-.002.006-.005.285.509.615.994.986 1.446.156.19.32.371.488.548-.704 2.009.099 3.68.099 3.68 2.144.08 3.553-.937 3.849-1.173a9.784 9.784 0 0 0 3.164.501h.08l.055-.003.107-.002.103-.005.003.002c1.01 1.44 2.788 1.646 2.788 1.646 1.264-1.332 1.337-2.653 1.337-2.94v-.058c0-.02-.003-.039-.003-.06.265-.187.52-.387.758-.6a7.875 7.875 0 0 0 1.415-1.7c1.43.083 2.437-.885 2.437-.885-.236-1.49-1.085-2.216-1.264-2.354l-.018-.013-.016-.013a.217.217 0 0 1-.031-.02c.008-.092.016-.18.02-.27.011-.162.016-.323.016-.48v-.253l-.005-.098-.008-.135a1.891 1.891 0 0 0-.01-.13c-.003-.042-.008-.083-.013-.125l-.016-.124-.018-.122a6.215 6.215 0 0 0-2.032-3.73 6.015 6.015 0 0 0-3.222-1.46 6.292 6.292 0 0 0-.85-.048l-.107.002h-.063l-.044.003-.104.008a4.777 4.777 0 0 0-3.335 1.695c-.332.4-.592.84-.768 1.297a4.594 4.594 0 0 0-.312 1.817l.003.091c.005.055.007.11.013.164a3.615 3.615 0 0 0 .698 1.82 3.53 3.53 0 0 0 1.827 1.282c.33.098.66.14.971.137.039 0 .078 0 .114-.002l.063-.003c.02 0 .041-.003.062-.003.034-.002.065-.007.099-.01.007 0 .018-.003.028-.003l.031-.005.06-.008a1.18 1.18 0 0 0 .112-.02c.036-.008.072-.013.109-.024a2.634 2.634 0 0 0 .914-.415c.028-.02.056-.041.085-.065a.248.248 0 0 0 .039-.35.244.244 0 0 0-.309-.06l-.078.042c-.09.044-.184.083-.283.116a2.476 2.476 0 0 1-.475.096c-.028.003-.054.006-.083.006l-.083.002c-.026 0-.054 0-.08-.002l-.102-.006h-.012l-.024.006c-.016-.003-.031-.003-.044-.006-.031-.002-.06-.007-.091-.01a2.59 2.59 0 0 1-.724-.213 2.557 2.557 0 0 1-.667-.438 2.52 2.52 0 0 1-.805-1.475 2.306 2.306 0 0 1-.029-.444l.006-.122v-.023l.002-.031c.003-.021.003-.04.005-.06a3.163 3.163 0 0 1 1.352-2.29 3.12 3.12 0 0 1 .937-.43 2.946 2.946 0 0 1 .776-.101h.06l.07.002.045.003h.026l.07.005a4.041 4.041 0 0 1 1.635.49 3.94 3.94 0 0 1 1.602 1.662 3.77 3.77 0 0 1 .397 1.414l.005.076.003.075c.002.026.002.05.002.075 0 .024.003.052 0 .07v.065l-.002.073-.008.174a6.195 6.195 0 0 1-.08.639 5.1 5.1 0 0 1-.267.927 5.31 5.31 0 0 1-.624 1.13 5.052 5.052 0 0 1-3.237 2.014 4.82 4.82 0 0 1-.649.066l-.039.003h-.287a6.607 6.607 0 0 1-1.716-.265 6.776 6.776 0 0 1-3.4-2.274 6.75 6.75 0 0 1-.746-1.15 6.616 6.616 0 0 1-.714-2.596l-.005-.083-.002-.02v-.056l-.003-.073v-.096l-.003-.104v-.07l.003-.163c.008-.22.026-.45.054-.678a8.707 8.707 0 0 1 .28-1.355c.128-.444.286-.872.473-1.277a7.04 7.04 0 0 1 1.456-2.1 5.925 5.925 0 0 1 .953-.763c.169-.111.343-.213.524-.306.089-.05.182-.091.273-.135.047-.02.093-.042.138-.062a7.177 7.177 0 0 1 .714-.267l.145-.045c.049-.015.098-.026.148-.041.098-.029.197-.052.296-.076.049-.013.1-.02.15-.033l.15-.032.151-.028.076-.013.075-.01.153-.024c.057-.01.114-.013.171-.023l.169-.021c.036-.003.073-.008.106-.01l.073-.008.036-.003.042-.002c.057-.003.114-.008.171-.01l.086-.006h.023l.037-.003.145-.007a7.999 7.999 0 0 1 1.708.125 7.917 7.917 0 0 1 2.048.68 8.253 8.253 0 0 1 1.672 1.09l.09.077.089.078c.06.052.114.107.171.159.057.052.112.106.166.16.052.055.107.107.159.164a8.671 8.671 0 0 1 1.41 1.978c.012.026.028.052.04.078l.04.078.075.156c.023.051.05.1.07.153l.065.15a8.848 8.848 0 0 1 .45 1.34.19.19 0 0 0 .201.142.186.186 0 0 0 .172-.184c.01-.246.002-.532-.024-.856z" },
  "prometheus": { title: "Prometheus", hex: "E6522C", category: "devops", path: "M12 0C5.373 0 0 5.372 0 12c0 6.627 5.373 12 12 12s12-5.373 12-12c0-6.628-5.373-12-12-12zm0 22.46c-1.885 0-3.414-1.26-3.414-2.814h6.828c0 1.553-1.528 2.813-3.414 2.813zm5.64-3.745H6.36v-2.046h11.28v2.046zm-.04-3.098H6.391c-.037-.043-.075-.086-.111-.13-1.155-1.401-1.427-2.133-1.69-2.879-.005-.025 1.4.287 2.395.511 0 0 .513.119 1.262.255-.72-.843-1.147-1.915-1.147-3.01 0-2.406 1.845-4.508 1.18-6.207.648.053 1.34 1.367 1.387 3.422.689-.951.977-2.69.977-3.755 0-1.103.727-2.385 1.454-2.429-.648 1.069.168 1.984.894 4.256.272.854.237 2.29.447 3.201.07-1.892.395-4.652 1.595-5.605-.529 1.2.079 2.702.494 3.424.671 1.164 1.078 2.047 1.078 3.716a4.642 4.642 0 01-1.11 2.996c.792-.149 1.34-.283 1.34-.283l2.573-.502s-.374 1.538-1.81 3.019z" },
  "opentelemetry": { title: "OpenTelemetry", hex: "000000", category: "devops", path: "M12.6974 13.1173c-1.0224 1.0224-1.0224 2.68 0 3.7024 1.0224 1.0224 2.68 1.0224 3.7024 0 1.0224-1.0223 1.0224-2.68 0-3.7024-1.0223-1.0223-2.68-1.0223-3.7024 0zm2.7677 2.7701c-.5063.5063-1.3267.5063-1.833 0s-.5063-1.3266 0-1.833c.5063-.5062 1.3267-.5062 1.833 0 .5063.504.5063 1.3267 0 1.833zM16.356.2355l-1.6041 1.6042c-.314.314-.314.83 0 1.144L21.015 9.247c.314.314.83.314 1.144 0l1.6042-1.6041c.314-.314.314-.83 0-1.144L17.4976.2354c-.314-.314-.8276-.314-1.1416 0zM5.1173 20.734c.2848-.2848.2848-.7497 0-1.0345l-.8155-.8155c-.2848-.2848-.7497-.2848-1.0345 0l-1.6845 1.6845-.0024.0024-.4625-.4625c-.2556-.2556-.6718-.2556-.925 0-.2556.2556-.2556.6718 0 .925l2.775 2.775c.2556.2556.6718.2556.925 0 .2532-.2556.2556-.6718 0-.925l-.4625-.4625.0024-.0024zm8.4856-15.893-3.5637 3.5637c-.3164.3164-.3164.8374 0 1.1538l2.2006 2.2005c1.5554-1.1197 3.7365-.981 5.1361.4187l1.7819-1.7818c.3164-.3165.3164-.8374 0-1.1538l-4.401-4.401c-.3165-.319-.8374-.319-1.1539 0zm-2.2881 7.8455-1.2999-1.2999c-.3043-.3043-.8033-.3043-1.1076 0l-4.5836 4.586c-.3042.3043-.3042.8033 0 1.1076l2.5973 2.5973c.3043.3043.8033.3043 1.1076 0l2.9478-2.9527c-.6231-1.2877-.5112-2.8431.3384-4.0383z" },
  "sentry": { title: "Sentry", hex: "362D59", category: "devops", path: "M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z" },
  "git": { title: "Git", hex: "F03C2E", category: "tool", path: "M13.09 23.549a1.54 1.54 0 0 1-2.18 0L.451 13.089a1.54 1.54 0 0 1 0-2.179l7.191-7.19 2.733 2.733a1.85 1.85 0 0 0 .964 2.326v6.66a1.849 1.849 0 1 0 1.54 0V8.957l2.508 2.508a1.85 1.85 0 1 0 1.09-1.09l-2.634-2.634a1.85 1.85 0 0 0-2.378-2.377L8.73 2.63 10.91.451a1.54 1.54 0 0 1 2.179 0l10.459 10.46a1.54 1.54 0 0 1 0 2.179z" },
  "github": { title: "GitHub", hex: "181717", category: "tool", path: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" },
  "linux": { title: "Linux", hex: "FCC624", category: "tool", path: "M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.132 1.884 1.071.771-.06 1.592-.536 2.257-1.306.631-.765 1.683-1.084 2.378-1.503.348-.199.629-.469.649-.853.023-.4-.2-.811-.714-1.376v-.097l-.003-.003c-.17-.2-.25-.535-.338-.926-.085-.401-.182-.786-.492-1.046h-.003c-.059-.054-.123-.067-.188-.135a.357.357 0 00-.19-.064c.431-1.278.264-2.55-.173-3.694-.533-1.41-1.465-2.638-2.175-3.483-.796-1.005-1.576-1.957-1.56-3.368.026-2.152.236-6.133-3.544-6.139zm.529 3.405h.013c.213 0 .396.062.584.198.19.135.33.332.438.533.105.259.158.459.166.724 0-.02.006-.04.006-.06v.105a.086.086 0 01-.004-.021l-.004-.024a1.807 1.807 0 01-.15.706.953.953 0 01-.213.335.71.71 0 00-.088-.042c-.104-.045-.198-.064-.284-.133a1.312 1.312 0 00-.22-.066c.05-.06.146-.133.183-.198.053-.128.082-.264.088-.402v-.02a1.21 1.21 0 00-.061-.4c-.045-.134-.101-.2-.183-.333-.084-.066-.167-.132-.267-.132h-.016c-.093 0-.176.03-.262.132a.8.8 0 00-.205.334 1.18 1.18 0 00-.09.4v.019c.002.089.008.179.02.267-.193-.067-.438-.135-.607-.202a1.635 1.635 0 01-.018-.2v-.02a1.772 1.772 0 01.15-.768c.082-.22.232-.406.43-.533a.985.985 0 01.594-.2zm-2.962.059h.036c.142 0 .27.048.399.135.146.129.264.288.344.465.09.199.14.4.153.667v.004c.007.134.006.2-.002.266v.08c-.03.007-.056.018-.083.024-.152.055-.274.135-.393.2.012-.09.013-.18.003-.267v-.015c-.012-.133-.04-.2-.082-.333a.613.613 0 00-.166-.267.248.248 0 00-.183-.064h-.021c-.071.006-.13.04-.186.132a.552.552 0 00-.12.27.944.944 0 00-.023.33v.015c.012.135.037.2.08.334.046.134.098.2.166.268.01.009.02.018.034.024-.07.057-.117.07-.176.136a.304.304 0 01-.131.068 2.62 2.62 0 01-.275-.402 1.772 1.772 0 01-.155-.667 1.759 1.759 0 01.08-.668 1.43 1.43 0 01.283-.535c.128-.133.26-.2.418-.2zm1.37 1.706c.332 0 .733.065 1.216.399.293.2.523.269 1.052.468h.003c.255.136.405.266.478.399v-.131a.571.571 0 01.016.47c-.123.31-.516.643-1.063.842v.002c-.268.135-.501.333-.775.465-.276.135-.588.292-1.012.267a1.139 1.139 0 01-.448-.067 3.566 3.566 0 01-.322-.198c-.195-.135-.363-.332-.612-.465v-.005h-.005c-.4-.246-.616-.512-.686-.71-.07-.268-.005-.47.193-.6.224-.135.38-.271.483-.336.104-.074.143-.102.176-.131h.002v-.003c.169-.202.436-.47.839-.601.139-.036.294-.065.466-.065zm2.8 2.142c.358 1.417 1.196 3.475 1.735 4.473.286.534.855 1.659 1.102 3.024.156-.005.33.018.513.064.646-1.671-.546-3.467-1.089-3.966-.22-.2-.232-.335-.123-.335.59.534 1.365 1.572 1.646 2.757.13.535.16 1.104.021 1.67.067.028.135.06.205.067 1.032.534 1.413.938 1.23 1.537v-.043c-.06-.003-.12 0-.18 0h-.016c.151-.467-.182-.825-1.065-1.224-.915-.4-1.646-.336-1.77.465-.008.043-.013.066-.018.135-.068.023-.139.053-.209.064-.43.268-.662.669-.793 1.187-.13.533-.17 1.156-.205 1.869v.003c-.02.334-.17.838-.319 1.35-1.5 1.072-3.58 1.538-5.348.334a2.645 2.645 0 00-.402-.533 1.45 1.45 0 00-.275-.333c.182 0 .338-.03.465-.067a.615.615 0 00.314-.334c.108-.267 0-.697-.345-1.163-.345-.467-.931-.995-1.788-1.521-.63-.4-.986-.87-1.15-1.396-.165-.534-.143-1.085-.015-1.645.245-1.07.873-2.11 1.274-2.763.107-.065.037.135-.408.974-.396.751-1.14 2.497-.122 3.854a8.123 8.123 0 01.647-2.876c.564-1.278 1.743-3.504 1.836-5.268.048.036.217.135.289.202.218.133.38.333.59.465.21.201.477.335.876.335.039.003.075.006.11.006.412 0 .73-.134.997-.268.29-.134.52-.334.74-.4h.005c.467-.135.835-.402 1.044-.7zm2.185 8.958c.037.6.343 1.245.882 1.377.588.134 1.434-.333 1.791-.765l.211-.01c.315-.007.577.01.847.268l.003.003c.208.199.305.53.391.876.085.4.154.78.409 1.066.486.527.645.906.636 1.14l.003-.007v.018l-.003-.012c-.015.262-.185.396-.498.595-.63.401-1.746.712-2.457 1.57-.618.737-1.37 1.14-2.036 1.191-.664.053-1.237-.2-1.574-.898l-.005-.003c-.21-.4-.12-1.025.056-1.69.176-.668.428-1.344.463-1.897.037-.714.076-1.335.195-1.814.12-.465.308-.797.641-.984l.045-.022zm-10.814.049h.01c.053 0 .105.005.157.014.376.055.706.333 1.023.752l.91 1.664.003.003c.243.533.754 1.064 1.189 1.637.434.598.77 1.131.729 1.57v.006c-.057.744-.48 1.148-1.125 1.294-.645.135-1.52.002-2.395-.464-.968-.536-2.118-.469-2.857-.602-.369-.066-.61-.2-.723-.4-.11-.2-.113-.602.123-1.23v-.004l.002-.003c.117-.334.03-.752-.027-1.118-.055-.401-.083-.71.043-.94.16-.334.396-.4.69-.533.294-.135.64-.202.915-.47h.002v-.002c.256-.268.445-.601.668-.838.19-.201.38-.336.663-.336zm7.159-9.074c-.435.201-.945.535-1.488.535-.542 0-.97-.267-1.28-.466-.154-.134-.28-.268-.373-.335-.164-.134-.144-.333-.074-.333.109.016.129.134.199.2.096.066.215.2.36.333.292.2.68.467 1.167.467.485 0 1.053-.267 1.398-.466.195-.135.445-.334.648-.467.156-.136.149-.267.279-.267.128.016.034.134-.147.332a8.097 8.097 0 01-.69.468zm-1.082-1.583V5.64c-.006-.02.013-.042.029-.05.074-.043.18-.027.26.004.063 0 .16.067.15.135-.006.049-.085.066-.135.066-.055 0-.092-.043-.141-.068-.052-.018-.146-.008-.163-.065zm-.551 0c-.02.058-.113.049-.166.066-.047.025-.086.068-.14.068-.05 0-.13-.02-.136-.068-.01-.066.088-.133.15-.133.08-.031.184-.047.259-.005.019.009.036.03.03.05v.02h.003z" },
  "ubuntu": { title: "Ubuntu", hex: "E95420", category: "tool", path: "M17.61.455a3.41 3.41 0 0 0-3.41 3.41 3.41 3.41 0 0 0 3.41 3.41 3.41 3.41 0 0 0 3.41-3.41 3.41 3.41 0 0 0-3.41-3.41zM12.92.8C8.923.777 5.137 2.941 3.148 6.451a4.5 4.5 0 0 1 .26-.007 4.92 4.92 0 0 1 2.585.737A8.316 8.316 0 0 1 12.688 3.6 4.944 4.944 0 0 1 13.723.834 11.008 11.008 0 0 0 12.92.8zm9.226 4.994a4.915 4.915 0 0 1-1.918 2.246 8.36 8.36 0 0 1-.273 8.303 4.89 4.89 0 0 1 1.632 2.54 11.156 11.156 0 0 0 .559-13.089zM3.41 7.932A3.41 3.41 0 0 0 0 11.342a3.41 3.41 0 0 0 3.41 3.409 3.41 3.41 0 0 0 3.41-3.41 3.41 3.41 0 0 0-3.41-3.41zm2.027 7.866a4.908 4.908 0 0 1-2.915.358 11.1 11.1 0 0 0 7.991 6.698 11.234 11.234 0 0 0 2.422.249 4.879 4.879 0 0 1-.999-2.85 8.484 8.484 0 0 1-.836-.136 8.304 8.304 0 0 1-5.663-4.32zm11.405.928a3.41 3.41 0 0 0-3.41 3.41 3.41 3.41 0 0 0 3.41 3.41 3.41 3.41 0 0 0 3.41-3.41 3.41 3.41 0 0 0-3.41-3.41z" },
  "archlinux": { title: "Arch Linux", hex: "1793D1", category: "tool", path: "M11.39.605C10.376 3.092 9.764 4.72 8.635 7.132c.693.734 1.543 1.589 2.923 2.554-1.484-.61-2.496-1.224-3.252-1.86C6.86 10.842 4.596 15.138 0 23.395c3.612-2.085 6.412-3.37 9.021-3.862a6.61 6.61 0 01-.171-1.547l.003-.115c.058-2.315 1.261-4.095 2.687-3.973 1.426.12 2.534 2.096 2.478 4.409a6.52 6.52 0 01-.146 1.243c2.58.505 5.352 1.787 8.914 3.844-.702-1.293-1.33-2.459-1.929-3.57-.943-.73-1.926-1.682-3.933-2.713 1.38.359 2.367.772 3.137 1.234-6.09-11.334-6.582-12.84-8.67-17.74zM22.898 21.36v-.623h-.234v-.084h.562v.084h-.234v.623h.331v-.707h.142l.167.5.034.107a2.26 2.26 0 01.038-.114l.17-.493H24v.707h-.091v-.593l-.206.593h-.084l-.205-.602v.602h-.091" },
  "nixos": { title: "NixOS", hex: "5277C3", category: "tool", path: "M7.352 1.592l-1.364.002L5.32 2.75l1.557 2.713-3.137-.008-1.32 2.34H14.11l-1.353-2.332-3.192-.006-2.214-3.865zm6.175 0l-2.687.025 5.846 10.127 1.341-2.34-1.59-2.765 2.24-3.85-.683-1.182h-1.336l-1.57 2.705-1.56-2.72zm6.887 4.195l-5.846 10.125 2.696-.008 1.601-2.76 4.453.016.682-1.183-.666-1.157-3.13-.008L21.778 8.1l-1.365-2.313zM9.432 8.086l-2.696.008-1.601 2.76-4.453-.016L0 12.02l.666 1.157 3.13.008-1.575 2.71 1.365 2.315L9.432 8.086zM7.33 12.25l-.006.01-.002-.004-1.342 2.34 1.59 2.765-2.24 3.85.684 1.182H7.35l.004-.006h.001l1.567-2.698 1.558 2.72 2.688-.026-.004-.006h.01L7.33 12.25zm2.55 3.93l1.354 2.332 3.192.006 2.215 3.865 1.363-.002.668-1.156-1.557-2.713 3.137.008 1.32-2.34H9.881Z" },
  "apple": { title: "Apple", hex: "000000", category: "tool", path: "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" },
  "android": { title: "Android", hex: "3DDC84", category: "tool", path: "M18.4395 5.5586c-.675 1.1664-1.352 2.3318-2.0274 3.498-.0366-.0155-.0742-.0286-.1113-.043-1.8249-.6957-3.484-.8-4.42-.787-1.8551.0185-3.3544.4643-4.2597.8203-.084-.1494-1.7526-3.021-2.0215-3.4864a1.1451 1.1451 0 0 0-.1406-.1914c-.3312-.364-.9054-.4859-1.379-.203-.475.282-.7136.9361-.3886 1.5019 1.9466 3.3696-.0966-.2158 1.9473 3.3593.0172.031-.4946.2642-1.3926 1.0177C2.8987 12.176.452 14.772 0 18.9902h24c-.119-1.1108-.3686-2.099-.7461-3.0683-.7438-1.9118-1.8435-3.2928-2.7402-4.1836a12.1048 12.1048 0 0 0-2.1309-1.6875c.6594-1.122 1.312-2.2559 1.9649-3.3848.2077-.3615.1886-.7956-.0079-1.1191a1.1001 1.1001 0 0 0-.8515-.5332c-.5225-.0536-.9392.3128-1.0488.5449zm-.0391 8.461c.3944.5926.324 1.3306-.1563 1.6503-.4799.3197-1.188.0985-1.582-.4941-.3944-.5927-.324-1.3307.1563-1.6504.4727-.315 1.1812-.1086 1.582.4941zM7.207 13.5273c.4803.3197.5506 1.0577.1563 1.6504-.394.5926-1.1038.8138-1.584.4941-.48-.3197-.5503-1.0577-.1563-1.6504.4008-.6021 1.1087-.8106 1.584-.4941z" },
  "ios": { title: "iOS", hex: "000000", category: "tool", path: "M1.1 6.05C.486 6.05 0 6.53 0 7.13A1.08 1.08 0 0 0 1.1 8.21C1.72 8.21 2.21 7.73 2.21 7.13C2.21 6.53 1.72 6.05 1.1 6.05M8.71 6.07C5.35 6.07 3.25 8.36 3.25 12C3.25 15.67 5.35 17.95 8.71 17.95C12.05 17.95 14.16 15.67 14.16 12C14.16 8.36 12.05 6.07 8.71 6.07M19.55 6.07C17.05 6.07 15.27 7.45 15.27 9.5C15.27 11.13 16.28 12.15 18.4 12.64L19.89 13C21.34 13.33 21.93 13.81 21.93 14.64C21.93 15.6 20.96 16.28 19.58 16.28C18.17 16.28 17.11 15.59 17 14.53H15C15.08 16.65 16.82 17.95 19.46 17.95C22.25 17.95 24 16.58 24 14.4C24 12.69 23 11.72 20.68 11.19L19.35 10.89C17.94 10.55 17.36 10.1 17.36 9.34C17.36 8.38 18.24 7.74 19.54 7.74C20.85 7.74 21.75 8.39 21.85 9.46H23.81C23.76 7.44 22.09 6.07 19.55 6.07M8.71 7.82C10.75 7.82 12.06 9.45 12.06 12C12.06 14.57 10.75 16.2 8.71 16.2C6.65 16.2 5.35 14.57 5.35 12C5.35 9.45 6.65 7.82 8.71 7.82M.111 9.31V17.76H2.1V9.31H.11Z" },
  "raspberrypi": { title: "Raspberry Pi", hex: "A22846", category: "tool", path: "m19.8955 10.8961-.1726-.3028c.0068-2.1746-1.0022-3.061-2.1788-3.7348.356-.0938.7237-.1711.8245-.6182.6118-.1566.7397-.4398.8011-.7398.16-.1066.6955-.4061.6394-.9211.2998-.2069.4669-.4725.3819-.8487.3222-.3515.407-.6419.2702-.9096.3868-.4805.2152-.7295.05-.9817.2897-.5254.0341-1.0887-.7758-.9944-.3221-.4733-1.0244-.3659-1.133-.3637-.1215-.1519-.2819-.2821-.7755-.219-.3197-.2851-.6771-.2364-1.0458-.0964-.4378-.3403-.7275-.0675-1.0584.0356-.53-.1706-.6513.0631-.9117.1583-.5781-.1203-.7538.1416-1.0309.4182l-.3224-.0063c-.8719.5061-1.305 1.5366-1.4585 2.0664-.1536-.5299-.5858-1.5604-1.4575-2.0664l-.3223.0063C9.942.5014 9.7663.2394 9.1883.3597 8.9279.2646 8.807.0309 8.2766.2015c-.2172-.0677-.417-.2084-.6522-.2012l.0004.0002C7.5017.0041 7.369.049 7.2185.166c-.3688-.1401-.7262-.1887-1.0459.0964-.4936-.0631-.654.0671-.7756.219C5.2887.4791 4.5862.3717 4.264.845c-.8096-.0943-1.0655.4691-.7756.9944-.1653.2521-.3366.5013.05.9819-.1367.2677-.0519.5581.2703.9096-.085.3763.0822.6418.3819.8487-.0561.515.4795.8144.6394.9211.0614.3001.1894.5832.8011.7398.1008.4472.4685.5244.8245.6183-1.1766.6737-2.1856 1.56-2.1788 3.7348l-.1724.3028c-1.3491.8082-2.5629 3.4056-.6648 5.5167.124.6609.3319 1.1355.5171 1.6609.2769 2.117 2.0841 3.1082 2.5608 3.2255.6984.524 1.4423 1.0212 2.449 1.3696.949.964 1.977 1.3314 3.0107 1.3308.0152 0 .0306.0002.0457 0 1.0337.0006 2.0618-.3668 3.0107-1.3308 1.0067-.3483 1.7506-.8456 2.4491-1.3696.4766-.1173 2.2838-1.1085 2.5607-3.2255.1851-.5253.3931-1 .517-1.6609 1.8981-2.1113.6843-4.7089-.6649-5.517zm-1.0386-.3715c-.0704.8759-4.6354-3.0504-3.8472-3.1808 2.1391-.3558 3.9191.896 3.8472 3.1808zm-2.0155 4.3649c-1.1481.7409-2.8025.2626-3.6953-1.0681-.8928-1.3306-.6858-3.0101.4623-3.7509 1.1481-.7409 2.8025-.2627 3.6953 1.068.8927 1.3307.6858 3.0101-.4623 3.751zM13.6591 1.3721c.0396.1967.0843.321.1354.3577.2537-.272.4611-.5506.7878-.8123.0011.1537-.0776.3205.1169.4425.1752-.2356.4119-.4459.7263-.6244-.1514.2611-.026.3404.0554.4486.24-.2059.4681-.4144.9109-.5759-.121.1474-.2902.2914-.1108.4607.2473-.1544.496-.3086 1.0833-.4183-.1323.1475-.4059.295-.2401.4426.3104-.1186.6539-.2047 1.034-.2546-.182.1496-.3337.2963-.1846.4122.3323-.1022.7899-.2398 1.2372-.1212l-.2832.2849c-.0314.0382.6623.0297 1.1202.0364-.167.2321-.3375.4562-.437.8548.0454.0459.2723.0204.4862 0-.2194.4618-.6004.5783-.6893.776.134.1015.32.075.5232.006-.158.3254-.4892.5484-.7509.8123.0662.047.1818.075.4555.0425-.2418.257-.5339.492-.8802.7032.0614.0708.2722.0681.4678.0727-.3136.3069-.7173.466-1.0955.6668.1885.1288.3234.0988.4678.097-.2676.2198-.7225.3342-1.1448.4668.0803.1249.1607.1589.3324.194-.447.2473-1.0873.1343-1.2679.2607.0435.1243.1665.2053.3139.2728-.7197.0418-2.6879-.0262-3.0652-1.5156.7367-.8094 2.0813-1.7593 4.394-2.934-1.7994.6022-3.4229 1.405-4.7817 2.5096-1.5978-.7436-.4965-2.6197.283-3.3645zm-1.6126 5.3718c1.1329-.0123 2.5356.8325 2.53 1.6286-.005.7027-.9851 1.2715-2.5213 1.2607-1.5043-.0177-2.5172-.7148-2.5137-1.3957.003-.5603 1.2282-1.5263 2.505-1.4936zm-5.7646-.6006c.1717-.0351.252-.0692.3323-.194-.4223-.1327-.8772-.247-1.1448-.4668.1444.0018.2792.0318.4678-.097-.3783-.2008-.782-.3599-1.0956-.6668.1955-.0048.4064-.002.4677-.0728-.3462-.2113-.6383-.4463-.8801-.7033.2738.0325.3893.0045.4555-.0425-.2617-.264-.593-.487-.7509-.8123.2032.069.3892.0954.5232-.006-.089-.1977-.47-.3142-.6894-.776.214.0204.4409.0459.4863 0-.0994-.3985-.2698-.6226-.4369-.8547.4579-.0067 1.1516.0018 1.1202-.0364l-.2831-.2849c.4472-.1186.9049.019 1.2371.1213.1492-.1159-.0026-.2626-.1847-.4123.3801.05.7236.1361 1.034.2547.1659-.1476-.1076-.2951-.24-.4426.5872.1097.8361.2639 1.0833.4183.1794-.1694.0103-.3133-.1108-.4607.4428.1615.6709.37.911.5759.0814-.1082.2068-.1875.0554-.4486.3143.1785.5511.3888.7263.6244.1945-.122.1159-.2888.1169-.4426.3267.2618.534.5404.7879.8124.0511-.0366.0959-.161.1354-.3577.7794.7448 1.8807 2.6208.2831 3.3646-1.3589-1.1039-2.9817-1.9064-4.78-2.5086 2.3115 1.174 3.6556 2.1239 4.392 2.9328-.3773 1.4895-2.3455 1.5575-3.0651 1.5157.1473-.0676.2703-.1485.3139-.2728-.1806-.1264-.8209-.0134-1.2679-.2607zm2.8175 1.1334c.7881.1304-3.7769 4.0567-3.8472 3.1809-.0719-2.2846 1.7079-3.5367 3.8472-3.1809zm-4.847 8.7567c-1.1094-.8789-1.4668-3.4529.5901-4.6097 1.2394-.3273.4184 5.051-.5901 4.6097zm4.2656 4.5989c-.6257.3719-2.1452.2187-3.2252-1.3095-.7283-1.2823-.6345-2.5872-.123-2.9705.7648-.4589 1.9464.1609 2.8559 1.2003.7923.9405 1.1536 2.5927.4923 3.0797zm-1.2415-5.6086c-1.1481-.7409-1.3551-2.4203-.4623-3.7511.8928-1.3307 2.5472-1.8089 3.6952-1.068 1.1481.7409 1.3551 2.4203.4623 3.7509-.8926 1.3308-2.5471 1.809-3.6952 1.0682zm4.7948 8.2279c-1.3763.0584-2.7258-1.1105-2.7081-1.5157-.0206-.594 1.6758-1.0578 2.782-1.0306 1.1131-.0479 2.6068.3531 2.6097.8851.0184.5166-1.3547 1.6838-2.6836 1.6612zm2.7584-5.8578c.0081 1.3899-1.226 2.5225-2.7562 2.5299-1.5302.0073-2.7773-1.1135-2.7854-2.5033v-.0265c-.008-1.3899 1.2259-2.5226 2.7562-2.5299 1.5302-.0073 2.7773 1.1134 2.7853 2.5033a.7794.7794 0 0 1 .0001.0265zm3.855 2.0029c-1.186 1.6208-2.7916 1.684-3.3896 1.2325-.6255-.5811-.148-2.3854.7094-3.3747v-.0003c.9812-1.0912 2.0302-1.8037 2.7609-1.2469.4919.4828.7805 2.3008-.0807 3.3894zm1.0724-3.4301c-1.0086.4413-1.8298-4.9372-.5901-4.61 2.0568 1.1569 1.6994 3.731.5901 4.61zm-.0256-8.3279h.2985v-.5304h.2986c.1502 0 .2053.0624.2262.2052.0152.1088.0113.2395.0477.3253h.2984c-.0533-.0763-.0515-.2358-.0571-.3213-.0097-.1373-.0513-.2796-.1977-.3176v-.0037c.1502-.061.2149-.1807.2149-.341 0-.2048-.1539-.3738-.3974-.3738h-.732v1.3573zm.2985-1.1255h.3269c.1333 0 .2054.0573.2054.188 0 .1369-.0721.1942-.2054.1942H20.03v-.3822zm-1.0337.4633c0 .7009.5682 1.2694 1.2695 1.2694s1.2695-.5684 1.2695-1.2694c0-.7013-.5683-1.2697-1.2695-1.2697-.7013 0-1.2695.5684-1.2695 1.2697zm2.3275 0c0 .5845-.4737 1.058-1.058 1.058s-1.058-.4735-1.058-1.058c0-.5849.4737-1.058 1.058-1.058s1.058.4731 1.058 1.058z" },
  "arduino": { title: "Arduino", hex: "00878F", category: "tool", path: "M18.087 6.146c-.3 0-.607.017-.907.069-2.532.367-4.23 2.239-5.18 3.674-.95-1.435-2.648-3.307-5.18-3.674a6.49 6.49 0 0 0-.907-.069C2.648 6.146 0 8.77 0 12s2.656 5.854 5.913 5.854c.3 0 .607-.017.916-.069 2.531-.376 4.23-2.247 5.18-3.683.949 1.436 2.647 3.307 5.18 3.683.299.043.607.069.915.069C21.344 17.854 24 15.23 24 12s-2.656-5.854-5.913-5.854zM6.53 15.734a3.837 3.837 0 0 1-.625.043c-2.148 0-3.889-1.7-3.889-3.777 0-2.085 1.749-3.777 3.898-3.777.208 0 .416.017.624.043 2.39.35 3.847 2.768 4.347 3.734-.508.974-1.974 3.384-4.355 3.734zm11.558.043c-.208 0-.416-.017-.624-.043-2.39-.35-3.856-2.768-4.347-3.734.491-.966 1.957-3.384 4.347-3.734.208-.026.416-.043.624-.043 2.149 0 3.89 1.7 3.89 3.777 0 2.085-1.75 3.777-3.89 3.777zm1.65-4.404v1.134h-1.205v1.182h-1.156v-1.182H16.17v-1.134h1.206V10.19h1.156v1.183h1.206zM4.246 12.498H7.82v-1.125H4.245v1.125z" },
  "vim": { title: "Vim", hex: "019733", category: "tool", path: "M24 11.986h-.027l-4.318-4.318 4.303-4.414V1.461l-.649-.648h-8.198l-.66.605v1.045L12.015.027V0L12 .014 11.986 0v.027l-1.29 1.291-.538-.539H2.035l-.638.692v1.885l.616.616h.72v5.31L.027 11.987H0L.014 12 0 12.014h.027l2.706 2.706v6.467l.907.523h2.322l1.857-1.904 4.166 4.166V24l.015-.014.014.014v-.028l2.51-2.509h.485c.111 0 .211-.07.25-.179l.146-.426c.028-.084.012-.172-.037-.239l1.462-1.462-.612 1.962c-.043.141.036.289.177.332.025.008.052.012.078.012h1.824c.106-.001.201-.064.243-.163l.165-.394c.025-.065.024-.138-.004-.203-.027-.065-.08-.116-.146-.142-.029-.012-.062-.019-.097-.02h-.075l.84-2.644h1.232l-1.016 3.221c-.043.141.036.289.176.332.025.008.052.012.079.012h2.002c.11 0 .207-.066.248-.17l.164-.428c.051-.138-.021-.29-.158-.341-.029-.011-.06-.017-.091-.017h-.145l1.131-3.673c.027-.082.012-.173-.039-.24l-.375-.504-.003-.005c-.051-.064-.127-.102-.209-.102h-1.436c-.071 0-.141.03-.19.081l-.4.439h-.624l-.042-.046 4.445-4.445H24L23.986 12l.014-.014zM9.838 21.139l1.579-4.509h-.501l.297-.304h1.659l-1.563 4.555h.623l-.079.258H9.838zm3.695-7.516l.15.151-.269.922-.225.226h-.969l-.181-.181.311-.871.288-.247h.895zM5.59 20.829H3.877l-.262-.15V3.091H2.379l-.1-.1V1.815l.143-.154h7.371l.213.214v1.108l-.142.173H8.785v8.688l8.807-8.688h-2.086l-.175-.188V1.805l.121-.111h7.49l.132.133v1.07L12.979 13.25h-.373c-.015-.001-.028 0-.042.001l-.02.003c-.045.01-.086.03-.119.06l-.343.295-.004.003c-.033.031-.059.069-.073.111l-.296.83-6.119 6.276zm14.768-3.952l.474-.519h1.334l.309.415-1.265 4.107h.493l-.08.209H19.84l1.124-3.564h-2.015l-1.077 3.391h.424l-.073.174h-1.605l1.107-3.548h-2.096l-1.062 3.339h.436l-.072.209H13.27l1.514-4.46H14.198l.091-.271h1.65l.519.537h.906l.491-.554h1.061l.489.535h.953z" },
  "neovim": { title: "Neovim", hex: "57A143", category: "tool", path: "M2.214 4.954v13.615L7.655 24V10.314L3.312 3.845 2.214 4.954zm4.999 17.98l-4.557-4.548V5.136l.59-.596 3.967 5.908v12.485zm14.573-4.457l-.862.937-4.24-6.376V0l5.068 5.092.034 13.385zM7.431.001l12.998 19.835-3.637 3.637L3.787 3.683 7.43 0z" },
  "gnuemacs": { title: "GNU Emacs", hex: "7F5AB6", category: "tool", path: "M12,24C5.448,24,0.118,18.617,0.118,12S5.448,0,12,0c6.552,0,11.882,5.383,11.882,12S18.552,24,12,24z M12,0.661 C5.813,0.661,0.779,5.748,0.779,12S5.813,23.339,12,23.339c6.187,0,11.221-5.086,11.221-11.339S18.187,0.661,12,0.661z M8.03,20.197 c0,0,0.978,0.069,2.236-0.042c0.51-0.045,2.444-0.235,3.891-0.552c0,0,1.764-0.377,2.707-0.725c0.987-0.364,1.524-0.673,1.766-1.11 c-0.011-0.09,0.074-0.408-0.381-0.599c-1.164-0.488-2.514-0.4-5.185-0.457c-2.962-0.102-3.948-0.598-4.472-0.997 c-0.503-0.405-0.25-1.526,1.907-2.513c1.086-0.526,5.345-1.496,5.345-1.496c-1.434-0.709-4.109-1.955-4.659-2.224 c-0.482-0.236-1.254-0.591-1.421-1.021c-0.19-0.413,0.448-0.768,0.804-0.87c1.147-0.331,2.766-0.536,4.24-0.56 c0.741-0.012,0.861-0.059,0.861-0.059c1.022-0.17,1.695-0.869,1.414-1.976c-0.252-1.13-1.579-1.795-2.84-1.565 c-1.188,0.217-4.05,1.048-4.05,1.048c3.539-0.031,4.131,0.028,4.395,0.398c0.156,0.218-0.071,0.518-1.015,0.672 c-1.027,0.168-3.163,0.37-3.163,0.37c-2.049,0.122-3.492,0.13-3.925,1.046C6.202,7.564,6.787,8.094,7.043,8.425 c1.082,1.204,2.646,1.853,3.652,2.331c0.379,0.18,1.49,0.52,1.49,0.52c-3.265-0.18-5.619,0.823-7.001,1.977 c-1.562,1.445-0.871,3.168,2.33,4.228c1.891,0.626,2.828,0.921,5.648,0.667c1.661-0.09,1.923-0.036,1.939,0.1 c0.023,0.192-1.845,0.669-2.355,0.816C11.448,19.438,8.047,20.193,8.03,20.197z" },
  "jetbrains": { title: "JetBrains", hex: "000000", category: "tool", path: "M2.345 23.997A2.347 2.347 0 0 1 0 21.652V10.988C0 9.665.535 8.37 1.473 7.433l5.965-5.961A5.01 5.01 0 0 1 10.989 0h10.666A2.347 2.347 0 0 1 24 2.345v10.664a5.056 5.056 0 0 1-1.473 3.554l-5.965 5.965A5.017 5.017 0 0 1 13.007 24v-.003H2.345Zm8.969-6.854H5.486v1.371h5.828v-1.371ZM3.963 6.514h13.523v13.519l4.257-4.257a3.936 3.936 0 0 0 1.146-2.767V2.345c0-.678-.552-1.234-1.234-1.234H10.989a3.897 3.897 0 0 0-2.767 1.145L3.963 6.514Zm-.192.192L2.256 8.22a3.944 3.944 0 0 0-1.145 2.768v10.664c0 .678.552 1.234 1.234 1.234h10.666a3.9 3.9 0 0 0 2.767-1.146l1.512-1.511H3.771V6.706Z" },
  "intellijidea": { title: "IntelliJ IDEA", hex: "000000", category: "tool", path: "M0 0v24h24V0zm3.723 3.111h5v1.834h-1.39v6.277h1.39v1.834h-5v-1.834h1.444V4.945H3.723zm11.055 0H17v6.5c0 .612-.055 1.111-.222 1.556-.167.444-.39.777-.723 1.11-.277.279-.666.557-1.11.668a3.933 3.933 0 0 1-1.445.278c-.778 0-1.444-.167-1.944-.445a4.81 4.81 0 0 1-1.279-1.056l1.39-1.555c.277.334.555.555.833.722.277.167.611.278.945.278.389 0 .721-.111 1-.389.221-.278.333-.667.333-1.278zM2.222 19.5h9V21h-9z" },
  "pycharm": { title: "PyCharm", hex: "000000", category: "tool", path: "M7.833 6.666v-.055c0-1-.667-1.5-1.778-1.5H4.389v3.055h1.723c1.111 0 1.721-.666 1.721-1.5zM0 0v24h24V0H0zm2.223 3.167h4c2.389 0 3.833 1.389 3.833 3.445v.055c0 2.278-1.778 3.5-4.001 3.5H4.389v2.945H2.223V3.167zM11.277 21h-9v-1.5h9V21zm4.779-7.777c-2.944.055-5.111-2.223-5.111-5.057C10.944 5.333 13.056 3 16.111 3c1.889 0 3 .611 3.944 1.556l-1.389 1.61c-.778-.722-1.556-1.111-2.556-1.111-1.658 0-2.873 1.375-2.887 3.084.014 1.709 1.174 3.083 2.887 3.083 1.111 0 1.833-.445 2.61-1.167l1.39 1.389c-.999 1.112-2.166 1.779-4.054 1.779z" },
  "rider": { title: "Rider", hex: "000000", category: "tool", path: "M0 0v24h24V0zm7.031 3.113A4.063 4.063 0 0 1 9.72 4.14a3.23 3.23 0 0 1 .84 2.28A3.16 3.16 0 0 1 8.4 9.54l2.46 3.6H8.28L6.12 9.9H4.38v3.24H2.16V3.12c1.61-.004 3.281.009 4.871-.007zm5.509.007h3.96c3.18 0 5.34 2.16 5.34 5.04 0 2.82-2.16 5.04-5.34 5.04h-3.96zm4.069 1.976c-.607.01-1.235.004-1.849.004v6.06h1.74a2.882 2.882 0 0 0 3.06-3 2.897 2.897 0 0 0-2.951-3.064zM4.319 5.1v2.88H6.6c1.08 0 1.68-.6 1.68-1.44 0-.96-.66-1.44-1.74-1.44zM2.16 19.5h9V21h-9Z" },
  "xcode": { title: "Xcode", hex: "147EFB", category: "tool", path: "M19.06 5.3327c.4517-.1936.7744-.2581 1.097-.1936.5163.1291.7744.5163.968.7098.1936.3872.9034.7744 1.2261.8389.2581.0645.7098-.6453 1.0325-1.2906.3227-.5808.5163-1.3552.4517-1.5488-.0645-.1936-.968-.5808-1.1616-.5808-.1291 0-.3872.1291-.8389.0645-.4517-.0645-.9034-.5808-1.1616-.968-.4517-.6453-1.097-1.0325-1.6778-1.3552-.6453-.3227-1.3552-.5163-2.065-.6453-1.0325-.2581-2.065-.4517-3.0975-.3227-.5808.0645-1.2906.1291-1.8069.3227-.0645 0-.1936.1936-.0645.1936s.5808.0645.5808.0645-.5807.1292-.5807.2583c0 .1291.0645.1291.1291.1291.0645 0 1.4842-.0645 2.065 0 .6453.1291 1.3552.4517 1.8069 1.2261.7744 1.4197.4517 2.7749.2581 3.2266-.968 2.1295-8.6472 15.2294-9.0344 16.1328-.3873.9034-.5163 1.4842.5807 2.065s1.6778.3227 2.0005-.0645c.3872-.5163 7.0339-17.1654 9.2925-18.2624zm-3.6138 8.7117h1.5488c1.0325 0 1.2261.5163 1.2261.7098.0645.5163-.1936 1.1616-1.2261 1.1616h-.968l.7744 1.2906c.4517.7744.2581 1.1616 0 1.4197-.3872.3872-1.2261.3872-1.6778-.4517l-.9034-1.5488c-.6453 1.4197-1.2906 2.9684-2.065 4.7753h4.0009c1.9359 0 3.5492-1.6133 3.5492-3.5492V6.5588c-.0645-.1291-.1936-.0645-.2581 0-.3872.4517-1.4842 2.0004-4.001 7.4856zm-9.8087 8.0019h-.3227c-2.3231 0-4.1945-1.8714-4.1945-4.1945V7.0105c0-2.3231 1.8714-4.1945 4.1945-4.1945h9.3571c-.1936-.1936-.968-.5163-1.7423-.4517-.3227 0-.968.1291-1.3552-.1291-.3872-.3227-.3227-.5163-.9034-.5163H4.9277c-2.6458 0-4.7753 2.1295-4.7753 4.7753v11.7447c0 2.6458 2.1295 4.7753 4.4527 4.7108.6452 0 .8388-.5162 1.0324-.9034zM20.4152 6.9459v10.9058c0 2.3231-1.8714 4.1945-4.1945 4.1945H11.897s-.3872 1.0325.8389 1.0325h3.8719c2.6458 0 4.7753-2.1295 4.7753-4.7753V8.8173c.0646-.9034-.7098-1.4842-.9679-1.8714zm-18.5851.0646v10.8413c0 1.9359 1.6133 3.5492 3.5492 3.5492h.5808c0-.0645.7744-1.4197 2.4522-4.2591.1936-.3872.4517-.7744.7098-1.2261H4.4114c-.5808 0-.9034-.3872-.968-.7098-.1291-.5163.1936-1.1616.9034-1.1616h2.3877l3.033-5.2916s-.7098-1.2906-.9034-1.6133c-.2582-.4517-.1291-.9034.129-1.1615.3872-.3872 1.0325-.5808 1.6778.4517l.2581.3872.2581-.3872c.5808-.8389.968-.7744 1.2906-.7098.5163.1291.8389.7098.3872 1.6133L8.864 14.0444h1.3552c.4517-.7744.9034-1.5488 1.3552-2.3877-.0645-.3227-.1291-.7098-.0645-1.0325.0645-.5163.3227-.968.6453-1.3552l.3872.6453c1.2261-2.1295 2.1295-3.9364 2.3877-4.6463.1291-.3872.3227-1.1616.1291-1.8069H5.3794c-2.0005.0001-3.5493 1.6134-3.5493 3.5494zM4.605 17.7872c0-.0645.7744-1.4197.7744-1.4197 1.2261-.3227 1.8069.4517 1.8714.5163 0 0-.8389 1.4842-1.097 1.7423s-.5808.3227-.9034.2581c-.5164-.129-.839-.6453-.6454-1.097z" },
  "androidstudio": { title: "Android Studio", hex: "3DDC84", category: "tool", path: "M19.2693 10.3368c-.3321 0-.6026.2705-.6026.6031v9.8324h-1.7379l-3.3355-6.9396c.476-.5387.6797-1.286.5243-2.0009a2.2862 2.2862 0 0 0-1.2893-1.6248v-.8124c.0121-.2871-.1426-.5787-.4043-.7407-.1391-.0825-.2884-.1234-.4402-.1234a.8478.8478 0 0 0-.4318.1182c-.2701.1671-.4248.4587-.4123.7662l-.0003.721c-1.0149.3668-1.6619 1.4153-1.4867 2.5197a2.282 2.282 0 0 0 .5916 1.2103l-3.2096 6.9064H4.0928c-1.0949-.007-1.9797-.8948-1.9832-1.9896V5.016c-.0055 1.1024.8836 2.0006 1.9859 2.0062a2.024 2.024 0 0 0 .1326-.0037h14.7453s2.5343-.2189 2.8619 1.5392c-.2491.0287-.4449.2321-.4449.4889 0 .7115-.5791 1.2901-1.3028 1.2901h-.8183zM17.222 22.5366c.2347.4837.0329 1.066-.4507 1.3007-.1296.0629-.2666.0895-.4018.0927a.9738.9738 0 0 1-.3194-.0455c-.024-.0078-.046-.0209-.0694-.0305a.9701.9701 0 0 1-.2277-.1321c-.0247-.0192-.0495-.038-.0724-.0598-.0825-.0783-.1574-.1672-.21-.2757l-1.2554-2.6143-1.5585-3.2452a.7725.7725 0 0 0-.6995-.4443h-.0024a.792.792 0 0 0-.7083.4443l-1.5109 3.2452-1.2321 2.6464a.9722.9722 0 0 1-.7985.5795c-.0626.0053-.1238-.0024-.185-.0087-.0344-.0036-.069-.0053-.1025-.0124-.0489-.0103-.0954-.0278-.142-.0452-.0301-.0113-.0613-.0197-.0901-.0339-.0496-.0244-.0948-.0565-.1397-.0889-.0217-.0156-.0457-.0275-.0662-.045a.9862.9862 0 0 1-.1695-.1844.9788.9788 0 0 1-.0708-.9852l.8469-1.8223 3.2676-7.0314a1.7964 1.7964 0 0 1-.7072-1.1637c-.1555-.9799.5129-1.9003 1.4928-2.0559V9.3946a.3542.3542 0 0 1 .1674-.3155.3468.3468 0 0 1 .3541 0 .354.354 0 0 1 .1674.3155v1.159l.0129.0064a1.8028 1.8028 0 0 1 1.2878 1.378 1.7835 1.7835 0 0 1-.6439 1.7836l3.3889 7.0507.8481 1.7643zM12.9841 12.306c.0042-.6081-.4854-1.1044-1.0935-1.1085a1.1204 1.1204 0 0 0-.7856.3219 1.101 1.101 0 0 0-.323.7716c-.0042.6081.4854 1.1044 1.0935 1.1085h.0077c.6046 0 1.0967-.488 1.1009-1.0935zm-1.027 5.2768c-.1119.0005-.2121.0632-.2571.1553l-1.4127 3.0342h3.3733l-1.4564-3.0328a.274.274 0 0 0-.2471-.1567zm8.1432-6.7459l-.0129-.0001h-.8177a.103.103 0 0 0-.103.103v12.9103a.103.103 0 0 0 .0966.103h.8435c.9861-.0035 1.7836-.804 1.7836-1.79V9.0468c0 .9887-.8014 1.7901-1.7901 1.7901zM2.6098 5.0161v.019c.0039.816.6719 1.483 1.4874 1.4869a12.061 12.061 0 0 1 .1309-.0034h1.1286c.1972-1.315.7607-2.525 1.638-3.4859H4.0993c-.9266.0031-1.6971.6401-1.9191 1.4975.2417.0355.4296.235.4296.4859zm6.3381-2.8977L7.9112.3284a.219.219 0 0 1 0-.2189A.2384.2384 0 0 1 8.098 0a.219.219 0 0 1 .1867.1094l1.0496 1.8158a6.4907 6.4907 0 0 1 5.3186 0L15.696.1094a.2189.2189 0 0 1 .3734.2189l-1.0302 1.79c1.6671.9125 2.7974 2.5439 3.0975 4.4018l-12.286-.0014c.3004-1.8572 1.4305-3.488 3.0972-4.4003zm5.3774 2.6202a.515.515 0 0 0 .5271.5028.515.515 0 0 0 .5151-.5151.5213.5213 0 0 0-.8885-.367.5151.5151 0 0 0-.1537.3793zm-5.7178-.0067a.5151.5151 0 0 0 .5207.5095.5086.5086 0 0 0 .367-.1481.5215.5215 0 1 0-.734-.7341.515.515 0 0 0-.1537.3727z" },
  "cursor": { title: "Cursor", hex: "000000", category: "tool", path: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" },
  "postman": { title: "Postman", hex: "FF6C37", category: "tool", path: "M13.527.099C6.955-.744.942 3.9.099 10.473c-.843 6.572 3.8 12.584 10.373 13.428 6.573.843 12.587-3.801 13.428-10.374C24.744 6.955 20.101.943 13.527.099zm2.471 7.485a.855.855 0 0 0-.593.25l-4.453 4.453-.307-.307-.643-.643c4.389-4.376 5.18-4.418 5.996-3.753zm-4.863 4.861l4.44-4.44a.62.62 0 1 1 .847.903l-4.699 4.125-.588-.588zm.33.694l-1.1.238a.06.06 0 0 1-.067-.032.06.06 0 0 1 .01-.073l.645-.645.512.512zm-2.803-.459l1.172-1.172.879.878-1.979.426a.074.074 0 0 1-.085-.039.072.072 0 0 1 .013-.093zm-3.646 6.058a.076.076 0 0 1-.069-.083.077.077 0 0 1 .022-.046h.002l.946-.946 1.222 1.222-2.123-.147zm2.425-1.256a.228.228 0 0 0-.117.256l.203.865a.125.125 0 0 1-.211.117h-.003l-.934-.934-.294-.295 3.762-3.758 1.82-.393.874.874c-1.255 1.102-2.971 2.201-5.1 3.268zm5.279-3.428h-.002l-.839-.839 4.699-4.125a.952.952 0 0 0 .119-.127c-.148 1.345-2.029 3.245-3.977 5.091zm3.657-6.46l-.003-.002a1.822 1.822 0 0 1 2.459-2.684l-1.61 1.613a.119.119 0 0 0 0 .169l1.247 1.247a1.817 1.817 0 0 1-2.093-.343zm2.578 0a1.714 1.714 0 0 1-.271.218h-.001l-1.207-1.207 1.533-1.533c.661.72.637 1.832-.054 2.522zM18.855 6.05a.143.143 0 0 0-.053.157.416.416 0 0 1-.053.45.14.14 0 0 0 .023.197.141.141 0 0 0 .084.03.14.14 0 0 0 .106-.05.691.691 0 0 0 .087-.751.138.138 0 0 0-.194-.033z" },
  "figma": { title: "Figma", hex: "F24E1E", category: "tool", path: "M15.852 8.981h-4.588V0h4.588c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.491-4.49 4.491zM12.735 7.51h3.117c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-3.117V7.51zm0 1.471H8.148c-2.476 0-4.49-2.014-4.49-4.49S5.672 0 8.148 0h4.588v8.981zm-4.587-7.51c-1.665 0-3.019 1.355-3.019 3.019s1.354 3.02 3.019 3.02h3.117V1.471H8.148zm4.587 15.019H8.148c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h4.588v8.98zM8.148 8.981c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h3.117V8.981H8.148zM8.172 24c-2.489 0-4.515-2.014-4.515-4.49s2.014-4.49 4.49-4.49h4.588v4.441c0 2.503-2.047 4.539-4.563 4.539zm-.024-7.51a3.023 3.023 0 0 0-3.019 3.019c0 1.665 1.365 3.019 3.044 3.019 1.705 0 3.093-1.376 3.093-3.068v-2.97H8.148zm7.704 0h-.098c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h.098c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.49-4.49 4.49zm-.097-7.509c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h.098c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-.098z" },
  "notion": { title: "Notion", hex: "000000", category: "tool", path: "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z" },
  "jira": { title: "Jira", hex: "0052CC", category: "tool", path: "M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z" },
  "vitest": { title: "Vitest", hex: "00FF74", category: "tool", path: "M11.545 23.3a.613.613 0 0 1-.895.197L.252 15.936A.61.61 0 0 1 0 15.439V6.325c0-.502.569-.792.975-.497l6.358 4.624c.594.433 1.432.25 1.793-.39L14.393.7a.62.62 0 0 1 .535-.314h8.455a.613.613 0 0 1 .537.916z" },
  "jest": { title: "Jest", hex: "C21325", category: "tool", path: "M22.251 11.82a3.117 3.117 0 0 0-2.328-3.01L22.911 0H8.104L11.1 8.838a3.116 3.116 0 0 0-2.244 2.988c0 1.043.52 1.967 1.313 2.536a8.279 8.279 0 0 1-1.084 1.244 8.14 8.14 0 0 1-2.55 1.647c-.834-.563-1.195-1.556-.869-2.446a3.11 3.11 0 0 0-.91-6.08 3.117 3.117 0 0 0-3.113 3.113c0 .848.347 1.626.903 2.182-.048.097-.097.195-.146.299-.465.959-.993 2.043-1.195 3.259-.403 2.432.257 4.384 1.849 5.489A5.093 5.093 0 0 0 5.999 24c1.827 0 3.682-.917 5.475-1.807 1.279-.632 2.599-1.292 3.898-1.612.48-.118.98-.187 1.508-.264 1.07-.153 2.175-.312 3.168-.89a4.482 4.482 0 0 0 2.182-3.091c.174-.994 0-1.994-.444-2.87.298-.48.465-1.042.465-1.647zm-1.355 0c0 .965-.785 1.75-1.75 1.75a1.753 1.753 0 0 1-1.085-3.126l.007-.007c.056-.042.118-.084.18-.125 0 0 .008 0 .008-.007.028-.014.055-.035.083-.05.007 0 .014-.006.021-.006.028-.014.063-.028.097-.042.035-.014.07-.027.098-.041.007 0 .013-.007.02-.007.028-.007.056-.021.084-.028.007 0 .02-.007.028-.007.034-.007.062-.014.097-.02h.007l.104-.022c.007 0 .02 0 .028-.007.028 0 .055-.007.083-.007h.035c.035 0 .07-.007.111-.007h.09c.028 0 .05 0 .077.007h.014c.055.007.111.014.167.028a1.766 1.766 0 0 1 1.396 1.723zM10.043 1.39h10.93l-2.509 7.4c-.104.02-.208.055-.312.09l-2.64-5.385-2.648 5.35c-.104-.034-.216-.055-.327-.076l-2.494-7.38zm4.968 9.825a3.083 3.083 0 0 0-.938-1.668l1.438-2.904 1.452 2.967c-.43.43-.743.98-.868 1.605H15.01zm-3.481-1.098c.034-.007.062-.014.097-.02h.02c.029-.008.056-.008.084-.015h.028c.028 0 .049-.007.076-.007h.271c.028 0 .049.007.07.007.014 0 .02 0 .035.007.027.007.048.007.076.014.007 0 .014 0 .028.007l.097.02h.007c.028.008.056.015.083.029.007 0 .014.007.028.007.021.007.049.014.07.027.007 0 .014.007.02.007.028.014.056.021.084.035h.007a.374.374 0 0 1 .09.049h.007c.028.014.056.034.084.048.007 0 .007.007.013.007.028.014.05.035.077.049l.007.007c.083.062.16.132.236.201l.007.007a1.747 1.747 0 0 1 .48 1.209 1.752 1.752 0 0 1-3.502 0 1.742 1.742 0 0 1 1.32-1.695zm-6.838-.049c.966 0 1.751.786 1.751 1.751s-.785 1.751-1.75 1.751-1.752-.785-1.752-1.75.786-1.752 1.751-1.752zm16.163 6.025a3.07 3.07 0 0 1-1.508 2.133c-.758.438-1.689.577-2.669.716a17.29 17.29 0 0 0-1.64.291c-1.445.355-2.834 1.05-4.182 1.717-1.724.854-3.35 1.66-4.857 1.66a3.645 3.645 0 0 1-2.154-.688c-1.529-1.056-1.453-3.036-1.272-4.12.167-1.015.632-1.966 1.077-2.877.028-.055.049-.104.077-.16.152.056.312.098.479.126-.264 1.473.486 2.994 1.946 3.745l.264.139.284-.104c1.216-.431 2.342-1.133 3.336-2.071a9.334 9.334 0 0 0 1.445-1.716c.16.027.32.034.48.034a3.117 3.117 0 0 0 3.008-2.327h1.167a3.109 3.109 0 0 0 3.01 2.327c.576 0 1.11-.16 1.57-.43.18.52.236 1.063.139 1.605z" },
  "cypress": { title: "Cypress", hex: "69D3A7", category: "tool", path: "M11.998.0195c-.8642 0-1.6816.1101-2.1445.1934v.002C4.1731 1.2283 0 6.1368 0 12.0018c0 1.1265.1573 2.2328.4648 3.3028.0387.1453.0915.2993.1368.4473 1.607 4.865 6.2245 8.226 11.3925 8.2285.0651 0 .2518-.0003.502-.0118.8564-.0353 1.6228-.5734 1.9512-1.369l.4736-1.1544L20.4258 8.043H18.621l-2.3164 5.871-2.334-5.871h-1.9082l3.2734 8.0117c-.8115 1.9702-1.6252 3.9395-2.4355 5.9101-.0808.1945-.2655.3284-.4727.336-.144.005-.285.0098-.4316.0098-4.5848 0-8.6672-3.0695-9.9277-7.4649a10.3058 10.3058 0 0 1-.3985-2.8437c0-5.0887 3.6521-9.3404 8.6035-10.164.2214-.037.8885-.1446 1.7246-.1446 4.4166 0 8.269 2.732 9.7305 6.8476.0558.144.0977.293.1465.4395.299.9746.4531 1.9887.4531 3.0215 0 4.5696-2.9413 8.5326-7.3164 9.8613l.4863 1.5996c5.085-1.546 8.4995-6.1518 8.502-11.459 0-1.5491-.2983-2.8706-.6504-3.8926-.0432-.1212-.0873-.2422-.1309-.3633h-.002C21.4577 3.0954 17.0444.0195 11.998.0195ZM8.4336 7.8906c-1.1999 0-2.1747.3852-2.9805 1.1758-.8007.7856-1.205 1.7736-1.205 2.9356 0 1.1544.4068 2.1368 1.205 2.9199.8058.7906 1.7806 1.1738 2.9805 1.1738 1.705 0 3.1556-.955 3.7871-2.4883l.0332-.082-1.6289-.5547c-.168.4563-.7552 1.4883-2.1914 1.4883-.6745 0-1.2437-.2344-1.6934-.6992-.4572-.4699-.6875-1.0632-.6875-1.7578 0-.6998.2253-1.2809.6875-1.7735.4522-.4648 1.019-.7012 1.6934-.7012 1.438 0 2.0238 1.0815 2.1934 1.4883l1.627-.5527-.0333-.084c-.629-1.5358-2.082-2.4883-3.7871-2.4883Z" },
  "storybook": { title: "Storybook", hex: "FF4785", category: "tool", path: "M16.71.243l-.12 2.71a.18.18 0 00.29.15l1.06-.8.9.7a.18.18 0 00.28-.14l-.1-2.76 1.33-.1a1.2 1.2 0 011.279 1.2v21.596a1.2 1.2 0 01-1.26 1.2l-16.096-.72a1.2 1.2 0 01-1.15-1.16l-.75-19.797a1.2 1.2 0 011.13-1.27L16.7.222zM13.64 9.3c0 .47 3.16.24 3.59-.08 0-3.2-1.72-4.89-4.859-4.89-3.15 0-4.899 1.72-4.899 4.29 0 4.45 5.999 4.53 5.999 6.959 0 .7-.32 1.1-1.05 1.1-.96 0-1.35-.49-1.3-2.16 0-.36-3.649-.48-3.769 0-.27 4.03 2.23 5.2 5.099 5.2 2.79 0 4.969-1.49 4.969-4.18 0-4.77-6.099-4.64-6.099-6.999 0-.97.72-1.1 1.13-1.1.45 0 1.25.07 1.19 1.87z" },
  "eslint": { title: "ESLint", hex: "4B32C3", category: "tool", path: "M7.257 9.132L11.816 6.5a.369.369 0 0 1 .368 0l4.559 2.632a.369.369 0 0 1 .184.32v5.263a.37.37 0 0 1-.184.319l-4.559 2.632a.369.369 0 0 1-.368 0l-4.559-2.632a.369.369 0 0 1-.184-.32V9.452a.37.37 0 0 1 .184-.32M23.852 11.53l-5.446-9.475c-.198-.343-.564-.596-.96-.596H6.555c-.396 0-.762.253-.96.596L.149 11.509a1.127 1.127 0 0 0 0 1.117l5.447 9.398c.197.342.563.517.959.517h10.893c.395 0 .76-.17.959-.512l5.446-9.413a1.069 1.069 0 0 0 0-1.086m-4.51 4.556a.4.4 0 0 1-.204.338L12.2 20.426a.395.395 0 0 1-.392 0l-6.943-4.002a.4.4 0 0 1-.205-.338V8.08c0-.14.083-.269.204-.338L11.8 3.74c.12-.07.272-.07.392 0l6.943 4.003a.4.4 0 0 1 .206.338z" },
  "prettier": { title: "Prettier", hex: "F7B93E", category: "tool", path: "M8.571 23.429A.571.571 0 0 1 8 24H2.286a.571.571 0 0 1 0-1.143H8c.316 0 .571.256.571.572zM8 20.57H6.857a.571.571 0 0 0 0 1.143H8a.571.571 0 0 0 0-1.143zm-5.714 1.143H4.57a.571.571 0 0 0 0-1.143H2.286a.571.571 0 0 0 0 1.143zM8 18.286H2.286a.571.571 0 0 0 0 1.143H8a.571.571 0 0 0 0-1.143zM16 16H5.714a.571.571 0 0 0 0 1.143H16A.571.571 0 0 0 16 16zM2.286 17.143h1.143a.571.571 0 0 0 0-1.143H2.286a.571.571 0 0 0 0 1.143zm17.143-3.429H16a.571.571 0 0 0 0 1.143h3.429a.571.571 0 0 0 0-1.143zM9.143 14.857h4.571a.571.571 0 0 0 0-1.143H9.143a.571.571 0 0 0 0 1.143zm-6.857 0h4.571a.571.571 0 0 0 0-1.143H2.286a.571.571 0 0 0 0 1.143zM20.57 11.43H11.43a.571.571 0 0 0 0 1.142h9.142a.571.571 0 0 0 0-1.142zM9.714 12a.571.571 0 0 0-.571-.571H5.714a.571.571 0 0 0 0 1.142h3.429A.571.571 0 0 0 9.714 12zm-7.428.571h1.143a.571.571 0 0 0 0-1.142H2.286a.571.571 0 0 0 0 1.142zm19.428-3.428H16a.571.571 0 0 0 0 1.143h5.714a.571.571 0 0 0 0-1.143zM2.286 10.286H8a.571.571 0 0 0 0-1.143H2.286a.571.571 0 0 0 0 1.143zm13.143-2.857c0 .315.255.571.571.571h5.714a.571.571 0 0 0 0-1.143H16a.571.571 0 0 0-.571.572zm-8.572-.572a.571.571 0 0 0 0 1.143H8a.571.571 0 0 0 0-1.143H6.857zM2.286 8H4.57a.571.571 0 0 0 0-1.143H2.286a.571.571 0 0 0 0 1.143zm16.571-2.857c0 .315.256.571.572.571h1.142a.571.571 0 0 0 0-1.143H19.43a.571.571 0 0 0-.572.572zm-1.143 0a.571.571 0 0 0-.571-.572H12.57a.571.571 0 0 0 0 1.143h4.572a.571.571 0 0 0 .571-.571zm-15.428.571h8a.571.571 0 0 0 0-1.143h-8a.571.571 0 0 0 0 1.143zm5.143-2.857c0 .316.255.572.571.572h11.429a.571.571 0 0 0 0-1.143H8a.571.571 0 0 0-.571.571zm-5.143.572h3.428a.571.571 0 0 0 0-1.143H2.286a.571.571 0 0 0 0 1.143zm0-2.286H16A.571.571 0 0 0 16 0H2.286a.571.571 0 0 0 0 1.143z" },
  "unity": { title: "Unity", hex: "FFFFFF", category: "tool", path: "m12.9288 4.2939 3.7997 2.1929c.1366.077.1415.2905 0 .3675l-4.515 2.6076a.4192.4192 0 0 1-.4246 0L7.274 6.8543c-.139-.0745-.1415-.293 0-.3675l3.7972-2.193V0L1.3758 5.5977V16.793l3.7177-2.1456v-4.3858c-.0025-.1565.1813-.2682.318-.1838l4.5148 2.6076a.4252.4252 0 0 1 .2136.3676v5.2127c.0025.1565-.1813.2682-.3179.1838l-3.7996-2.1929-3.7178 2.1457L12 24l9.6954-5.5977-3.7178-2.1457-3.7996 2.1929c-.1341.082-.3229-.0248-.3179-.1838V13.053c0-.1565.087-.2956.2136-.3676l4.5149-2.6076c.134-.082.3228.0224.3179.1838v4.3858l3.7177 2.1456V5.5977L12.9288 0Z" },
  "godotengine": { title: "Godot Engine", hex: "478CBF", category: "tool", path: "M9.5598.683c-1.096.244-2.1812.5831-3.1983 1.0951.023.8981.081 1.7582.199 2.6323-.395.253-.81.47-1.178.766-.375.288-.7581.564-1.0971.9011-.6781-.448-1.3962-.869-2.1352-1.2411C1.3532 5.6934.608 6.6186 0 7.6546c.458.7411.936 1.4352 1.4521 2.0942h.014v6.3565c.012 0 .023 0 .035.003l3.8963.376c.204.02.364.184.378.3891l.12 1.7201 3.3994.242.234-1.587c.03-.206.207-.358.415-.358h4.1114c.208 0 .385.152.415.358l.234 1.587 3.3993-.242.12-1.72a.4196.4196 0 01.378-.3891l3.8954-.376c.012 0 .023-.003.035-.003v-.5071h.002V9.7498h.014c.516-.659.994-1.3531 1.4521-2.0942-.608-1.036-1.3541-1.9611-2.1512-2.8192-.739.372-1.4571.793-2.1352 1.2411-.339-.337-.721-.613-1.096-.901-.369-.296-.7841-.5131-1.1781-.7661.117-.8741.175-1.7342.199-2.6323-1.0171-.512-2.1012-.851-3.1983-1.095-.438.736-.838 1.533-1.1871 2.3121-.414-.069-.829-.094-1.2461-.099h-.016c-.417.005-.832.03-1.2461.099-.349-.779-.749-1.576-1.1881-2.3121l.001-.001zM6.4765 9.9889c1.2971 0 2.3492 1.0511 2.3492 2.3482s-1.052 2.3482-2.3492 2.3482c-1.296 0-2.3482-1.051-2.3482-2.3482 0-1.297 1.0511-2.3482 2.3482-2.3482zm11.049 0c1.296 0 2.3482 1.0511 2.3482 2.3482s-1.0511 2.3482-2.3482 2.3482-2.3492-1.051-2.3492-2.3482c0-1.297 1.051-2.3482 2.3492-2.3482zm-10.824.9301c-.861 0-1.559.698-1.559 1.5591s.698 1.5582 1.559 1.5582c.8611 0 1.5592-.698 1.5592-1.5582 0-.86-.697-1.559-1.5591-1.559zm10.598 0c-.8611 0-1.5582.698-1.5582 1.5591s.697 1.5582 1.5581 1.5582c.8611 0 1.5592-.698 1.5592-1.5582 0-.86-.697-1.559-1.5592-1.559zm-5.2985.453c.417 0 .757.308.757.6871v2.1622c0 .379-.339.687-.757.687s-.756-.308-.756-.687V12.059c0-.379.339-.687.756-.687zM1.4601 16.9464c.002.377.006.789.006.871 0 3.7014 4.6944 5.4795 10.5269 5.5005h.014c5.8325-.02 10.5259-1.7991 10.5259-5.5004 0-.084.005-.495.007-.871l-3.5023.338-.121 1.729a.421.421 0 01-.389.3901l-4.1814.296a.4203.4203 0 01-.415-.358l-.238-1.6141h-3.3863l-.238 1.6141a.4192.4192 0 01-.4451.357l-4.1513-.296c-.208-.015-.375-.181-.389-.389l-.12-1.7292-3.5044-.337z" },
  "blender": { title: "Blender", hex: "E87D0D", category: "tool", path: "M12.51 13.214c.046-.8.438-1.506 1.03-2.006a3.424 3.424 0 0 1 2.212-.79c.85 0 1.631.3 2.211.79.592.5.983 1.206 1.028 2.005.045.823-.285 1.586-.865 2.153a3.389 3.389 0 0 1-2.374.938 3.393 3.393 0 0 1-2.376-.938c-.58-.567-.91-1.33-.865-2.152M7.35 14.831c.006.314.106.922.256 1.398a7.372 7.372 0 0 0 1.593 2.757 8.227 8.227 0 0 0 2.787 2.001 8.947 8.947 0 0 0 3.66.76 8.964 8.964 0 0 0 3.657-.772 8.285 8.285 0 0 0 2.785-2.01 7.428 7.428 0 0 0 1.592-2.762 6.964 6.964 0 0 0 .25-3.074 7.123 7.123 0 0 0-1.016-2.779 7.764 7.764 0 0 0-1.852-2.043h.002L13.566 2.55l-.02-.015c-.492-.378-1.319-.376-1.86.002-.547.382-.609 1.015-.123 1.415l-.001.001 3.126 2.543-9.53.01h-.013c-.788.001-1.545.518-1.695 1.172-.154.665.38 1.217 1.2 1.22V8.9l4.83-.01-8.62 6.617-.034.025c-.813.622-1.075 1.658-.563 2.313.52.667 1.625.668 2.447.004L7.414 14s-.069.52-.063.831zm12.09 1.741c-.97.988-2.326 1.548-3.795 1.55-1.47.004-2.827-.552-3.797-1.538a4.51 4.51 0 0 1-1.036-1.622 4.282 4.282 0 0 1 .282-3.519 4.702 4.702 0 0 1 1.153-1.371c.942-.768 2.141-1.183 3.396-1.185 1.256-.002 2.455.41 3.398 1.175.48.391.87.854 1.152 1.367a4.28 4.28 0 0 1 .522 1.706 4.236 4.236 0 0 1-.239 1.811 4.54 4.54 0 0 1-1.035 1.626" },
  "x": { title: "X", hex: "000000", category: "social", path: "M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" },
  "mastodon": { title: "Mastodon", hex: "6364FF", category: "social", path: "M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 0 0 .023-.043v-1.809a.052.052 0 0 0-.02-.041.053.053 0 0 0-.046-.01 20.282 20.282 0 0 1-4.709.545c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 0 1-.319-1.433.053.053 0 0 1 .066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.67 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.5 2.962 1.498l.638 1.06.638-1.06c.66-.999 1.65-1.498 2.96-1.498 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12z" },
  "bluesky": { title: "Bluesky", hex: "1185FE", category: "social", path: "M5.202 2.857C7.954 4.922 10.913 9.11 12 11.358c1.087-2.247 4.046-6.436 6.798-8.501C20.783 1.366 24 .213 24 3.883c0 .732-.42 6.156-.667 7.037-.856 3.061-3.978 3.842-6.755 3.37 4.854.826 6.089 3.562 3.422 6.299-5.065 5.196-7.28-1.304-7.847-2.97-.104-.305-.152-.448-.153-.327 0-.121-.05.022-.153.327-.568 1.666-2.782 8.166-7.847 2.97-2.667-2.737-1.432-5.473 3.422-6.3-2.777.473-5.899-.308-6.755-3.369C.42 10.04 0 4.615 0 3.883c0-3.67 3.217-2.517 5.202-1.026" },
  "threads": { title: "Threads", hex: "000000", category: "social", path: "M18.263 11.097c-.03-3.486-1.92-5.586-5.111-5.586-2.13 0-3.922.963-4.863 2.499l2.062 1.438c.535-.843 1.272-1.543 2.628-1.543 1.528 0 2.318.85 2.544 2.431a15 15 0 0 0-2.236-.173c-4.125 0-6.068 1.867-6.068 4.336s1.943 3.99 4.804 3.99c3.139 0 5.013-2.115 5.781-4.735.798.361 1.348 1.204 1.348 2.47 0 3.387-3.907 5.232-7.22 5.232-4.885 0-8.077-3.207-8.077-8.424 0-6.392 4.223-10.487 9.9-10.487 3.808 0 5.69 1.671 6.97 3.914l2.108-1.475C21.44 2.078 18.331 0 13.663 0 6.227 0 1.168 5.277 1.168 12.934c0 7 4.953 11.066 10.856 11.066 4.878 0 9.809-2.846 9.809-7.716 0-2.545-1.46-4.231-3.569-5.187m-6.33 4.855c-1.077 0-2.026-.512-2.026-1.453 0-1.483 1.822-1.934 3.606-1.934.678 0 1.34.045 1.927.173-.422 1.927-1.671 3.215-3.508 3.214Z" },
  "youtube": { title: "YouTube", hex: "FF0000", category: "social", path: "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" },
  "twitch": { title: "Twitch", hex: "9146FF", category: "social", path: "M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z" },
  "reddit": { title: "Reddit", hex: "FF4500", category: "social", path: "M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z" },
  "devdotto": { title: "dev.to", hex: "0A0A0A", category: "social", path: "M7.42 10.05c-.18-.16-.46-.23-.84-.23H6l.02 2.44.04 2.45.56-.02c.41 0 .63-.07.83-.26.24-.24.26-.36.26-2.2 0-1.91-.02-1.96-.29-2.18zM0 4.94v14.12h24V4.94H0zM8.56 15.3c-.44.58-1.06.77-2.53.77H4.71V8.53h1.4c1.67 0 2.16.18 2.6.9.27.43.29.6.32 2.57.05 2.23-.02 2.73-.47 3.3zm5.09-5.47h-2.47v1.77h1.52v1.28l-.72.04-.75.03v1.77l1.22.03 1.2.04v1.28h-1.6c-1.53 0-1.6-.01-1.87-.3l-.3-.28v-3.16c0-3.02.01-3.18.25-3.48.23-.31.25-.31 1.88-.31h1.64v1.3zm4.68 5.45c-.17.43-.64.79-1 .79-.18 0-.45-.15-.67-.39-.32-.32-.45-.63-.82-2.08l-.9-3.39-.45-1.67h.76c.4 0 .75.02.75.05 0 .06 1.16 4.54 1.26 4.83.04.15.32-.7.73-2.3l.66-2.52.74-.04c.4-.02.73 0 .73.04 0 .14-1.67 6.38-1.8 6.68z" },
  "hashnode": { title: "Hashnode", hex: "2962FF", category: "social", path: "M22.351 8.019l-6.37-6.37a5.63 5.63 0 0 0-7.962 0l-6.37 6.37a5.63 5.63 0 0 0 0 7.962l6.37 6.37a5.63 5.63 0 0 0 7.962 0l6.37-6.37a5.63 5.63 0 0 0 0-7.962zM12 15.953a3.953 3.953 0 1 1 0-7.906 3.953 3.953 0 0 1 0 7.906z" },
  "medium": { title: "Medium", hex: "000000", category: "social", path: "M4.21 0A4.201 4.201 0 0 0 0 4.21v15.58A4.201 4.201 0 0 0 4.21 24h15.58A4.201 4.201 0 0 0 24 19.79v-1.093c-.137.013-.278.02-.422.02-2.577 0-4.027-2.146-4.09-4.832a7.592 7.592 0 0 1 .022-.708c.093-1.186.475-2.241 1.105-3.022a3.885 3.885 0 0 1 1.395-1.1c.468-.237 1.127-.367 1.664-.367h.023c.101 0 .202.004.303.01V4.211A4.201 4.201 0 0 0 19.79 0Zm.198 5.583h4.165l3.588 8.435 3.59-8.435h3.864v.146l-.019.004c-.705.16-1.063.397-1.063 1.254h-.003l.003 10.274c.06.676.424.885 1.063 1.03l.02.004v.145h-4.923v-.145l.019-.005c.639-.144.994-.353 1.054-1.03V7.267l-4.745 11.15h-.261L6.15 7.569v9.445c0 .857.358 1.094 1.063 1.253l.02.004v.147H4.405v-.147l.019-.004c.705-.16 1.065-.397 1.065-1.253V6.987c0-.857-.358-1.094-1.064-1.254l-.018-.004zm19.25 3.668c-1.086.023-1.733 1.323-1.813 3.124H24V9.298a1.378 1.378 0 0 0-.342-.047Zm-1.862 3.632c-.1 1.756.86 3.239 2.204 3.634v-3.634z" },
  "substack": { title: "Substack", hex: "FF6719", category: "social", path: "M22.539 8.242H1.46V5.406h21.08v2.836zM1.46 10.812V24L12 18.11 22.54 24V10.812H1.46zM22.54 0H1.46v2.836h21.08V0z" },
  "stackoverflow": { title: "Stack Overflow", hex: "F58025", category: "social", path: "M15.725 0l-1.72 1.277 6.39 8.588 1.716-1.277L15.725 0zm-3.94 3.418l-1.369 1.644 8.225 6.85 1.369-1.644-8.225-6.85zm-3.15 4.465l-.905 1.94 9.702 4.517.904-1.94-9.701-4.517zm-1.85 4.86l-.44 2.093 10.473 2.201.44-2.092-10.473-2.203zM1.89 15.47V24h19.19v-8.53h-2.133v6.397H4.021v-6.396H1.89zm4.265 2.133v2.13h10.66v-2.13H6.154Z" },
  "discord": { title: "Discord", hex: "5865F2", category: "social", path: "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" },
  "telegram": { title: "Telegram", hex: "26A5E4", category: "social", path: "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" },
  "instagram": { title: "Instagram", hex: "FF0069", category: "social", path: "M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077" },
  "gmail": { title: "Gmail", hex: "EA4335", category: "social", path: "M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z" },
  "rss": { title: "RSS", hex: "FFA500", category: "social", path: "M19.199 24C19.199 13.467 10.533 4.8 0 4.8V0c13.165 0 24 10.835 24 24h-4.801zM3.291 17.415c1.814 0 3.293 1.479 3.293 3.295 0 1.813-1.485 3.29-3.301 3.29C1.47 24 0 22.526 0 20.71s1.475-3.294 3.291-3.295zM15.909 24h-4.665c0-6.169-5.075-11.245-11.244-11.245V8.09c8.727 0 15.909 7.184 15.909 15.91z" },
  "githubsponsors": { title: "GitHub Sponsors", hex: "EA4AAA", category: "social", path: "M17.625 1.499c-2.32 0-4.354 1.203-5.625 3.03-1.271-1.827-3.305-3.03-5.625-3.03C3.129 1.499 0 4.253 0 8.249c0 4.275 3.068 7.847 5.828 10.227a33.14 33.14 0 0 0 5.616 3.876l.028.017.008.003-.001.003c.163.085.342.126.521.125.179.001.358-.041.521-.125l-.001-.003.008-.003.028-.017a33.14 33.14 0 0 0 5.616-3.876C20.932 16.096 24 12.524 24 8.249c0-3.996-3.129-6.75-6.375-6.75zm-.919 15.275a30.766 30.766 0 0 1-4.703 3.316l-.004-.002-.004.002a30.955 30.955 0 0 1-4.703-3.316c-2.677-2.307-5.047-5.298-5.047-8.523 0-2.754 2.121-4.5 4.125-4.5 2.06 0 3.914 1.479 4.544 3.684.143.495.596.797 1.086.796.49.001.943-.302 1.085-.796.63-2.205 2.484-3.684 4.544-3.684 2.004 0 4.125 1.746 4.125 4.5 0 3.225-2.37 6.216-5.048 8.523z" },
  "kofi": { title: "Ko-fi", hex: "FF6433", category: "social", path: "M11.351 2.715c-2.7 0-4.986.025-6.83.26C2.078 3.285 0 5.154 0 8.61c0 3.506.182 6.13 1.585 8.493 1.584 2.701 4.233 4.182 7.662 4.182h.83c4.209 0 6.494-2.234 7.637-4a9.5 9.5 0 0 0 1.091-2.338C21.792 14.688 24 12.22 24 9.208v-.415c0-3.247-2.13-5.507-5.792-5.87-1.558-.156-2.65-.208-6.857-.208m0 1.947c4.208 0 5.09.052 6.571.182 2.624.311 4.13 1.584 4.13 4v.39c0 2.156-1.792 3.844-3.87 3.844h-.935l-.156.649c-.208 1.013-.597 1.818-1.039 2.546-.909 1.428-2.545 3.064-5.922 3.064h-.805c-2.571 0-4.831-.883-6.078-3.195-1.09-2-1.298-4.155-1.298-7.506 0-2.181.857-3.402 3.012-3.714 1.533-.233 3.559-.26 6.39-.26m6.547 2.287c-.416 0-.65.234-.65.546v2.935c0 .311.234.545.65.545 1.324 0 2.051-.754 2.051-2s-.727-2.026-2.052-2.026m-10.39.182c-1.818 0-3.013 1.48-3.013 3.142 0 1.533.858 2.857 1.949 3.897.727.701 1.87 1.429 2.649 1.896a1.47 1.47 0 0 0 1.507 0c.78-.467 1.922-1.195 2.623-1.896 1.117-1.039 1.974-2.364 1.974-3.897 0-1.662-1.247-3.142-3.039-3.142-1.065 0-1.792.545-2.338 1.298-.493-.753-1.246-1.298-2.312-1.298" },
  "buymeacoffee": { title: "Buy Me A Coffee", hex: "FFDD00", category: "social", path: "M20.216 6.415l-.132-.666c-.119-.598-.388-1.163-1.001-1.379-.197-.069-.42-.098-.57-.241-.152-.143-.196-.366-.231-.572-.065-.378-.125-.756-.192-1.133-.057-.325-.102-.69-.25-.987-.195-.4-.597-.634-.996-.788a5.723 5.723 0 00-.626-.194c-1-.263-2.05-.36-3.077-.416a25.834 25.834 0 00-3.7.062c-.915.083-1.88.184-2.75.5-.318.116-.646.256-.888.501-.297.302-.393.77-.177 1.146.154.267.415.456.692.58.36.162.737.284 1.123.366 1.075.238 2.189.331 3.287.37 1.218.05 2.437.01 3.65-.118.299-.033.598-.073.896-.119.352-.054.578-.513.474-.834-.124-.383-.457-.531-.834-.473-.466.074-.96.108-1.382.146-1.177.08-2.358.082-3.536.006a22.228 22.228 0 01-1.157-.107c-.086-.01-.18-.025-.258-.036-.243-.036-.484-.08-.724-.13-.111-.027-.111-.185 0-.212h.005c.277-.06.557-.108.838-.147h.002c.131-.009.263-.032.394-.048a25.076 25.076 0 013.426-.12c.674.019 1.347.067 2.017.144l.228.031c.267.04.533.088.798.145.392.085.895.113 1.07.542.055.137.08.288.111.431l.319 1.484a.237.237 0 01-.199.284h-.003c-.037.006-.075.01-.112.015a36.704 36.704 0 01-4.743.295 37.059 37.059 0 01-4.699-.304c-.14-.017-.293-.042-.417-.06-.326-.048-.649-.108-.973-.161-.393-.065-.768-.032-1.123.161-.29.16-.527.404-.675.701-.154.316-.199.66-.267 1-.069.34-.176.707-.135 1.056.087.753.613 1.365 1.37 1.502a39.69 39.69 0 0011.343.376.483.483 0 01.535.53l-.071.697-1.018 9.907c-.041.41-.047.832-.125 1.237-.122.637-.553 1.028-1.182 1.171-.577.131-1.165.2-1.756.205-.656.004-1.31-.025-1.966-.022-.699.004-1.556-.06-2.095-.58-.475-.458-.54-1.174-.605-1.793l-.731-7.013-.322-3.094c-.037-.351-.286-.695-.678-.678-.336.015-.718.3-.678.679l.228 2.185.949 9.112c.147 1.344 1.174 2.068 2.446 2.272.742.12 1.503.144 2.257.156.966.016 1.942.053 2.892-.122 1.408-.258 2.465-1.198 2.616-2.657.34-3.332.683-6.663 1.024-9.995l.215-2.087a.484.484 0 01.39-.426c.402-.078.787-.212 1.074-.518.455-.488.546-1.124.385-1.766zm-1.478.772c-.145.137-.363.201-.578.233-2.416.359-4.866.54-7.308.46-1.748-.06-3.477-.254-5.207-.498-.17-.024-.353-.055-.47-.18-.22-.236-.111-.71-.054-.995.052-.26.152-.609.463-.646.484-.057 1.046.148 1.526.22.577.088 1.156.159 1.737.212 2.48.226 5.002.19 7.472-.14.45-.06.899-.13 1.345-.21.399-.072.84-.206 1.08.206.166.281.188.657.162.974a.544.544 0 01-.169.364zm-6.159 3.9c-.862.37-1.84.788-3.109.788a5.884 5.884 0 01-1.569-.217l.877 9.004c.065.78.717 1.38 1.5 1.38 0 0 1.243.065 1.658.065.447 0 1.786-.065 1.786-.065.783 0 1.434-.6 1.499-1.38l.94-9.95a3.996 3.996 0 00-1.322-.238c-.826 0-1.491.284-2.26.613z" },
  "patreon": { title: "Patreon", hex: "000000", category: "social", path: "M22.957 7.21c-.004-3.064-2.391-5.576-5.191-6.482-3.478-1.125-8.064-.962-11.384.604C2.357 3.231 1.093 7.391 1.046 11.54c-.039 3.411.302 12.396 5.369 12.46 3.765.047 4.326-4.804 6.068-7.141 1.24-1.662 2.836-2.132 4.801-2.618 3.376-.836 5.678-3.501 5.673-7.031Z" },
  "leetcode": { title: "LeetCode", hex: "FFA116", category: "social", path: "M13.483 0a1.374 1.374 0 0 0-.961.438L7.116 6.226l-3.854 4.126a5.266 5.266 0 0 0-1.209 2.104 5.35 5.35 0 0 0-.125.513 5.527 5.527 0 0 0 .062 2.362 5.83 5.83 0 0 0 .349 1.017 5.938 5.938 0 0 0 1.271 1.818l4.277 4.193.039.038c2.248 2.165 5.852 2.133 8.063-.074l2.396-2.392c.54-.54.54-1.414.003-1.955a1.378 1.378 0 0 0-1.951-.003l-2.396 2.392a3.021 3.021 0 0 1-4.205.038l-.02-.019-4.276-4.193c-.652-.64-.972-1.469-.948-2.263a2.68 2.68 0 0 1 .066-.523 2.545 2.545 0 0 1 .619-1.164L9.13 8.114c1.058-1.134 3.204-1.27 4.43-.278l3.501 2.831c.593.48 1.461.387 1.94-.207a1.384 1.384 0 0 0-.207-1.943l-3.5-2.831c-.8-.647-1.766-1.045-2.774-1.202l2.015-2.158A1.384 1.384 0 0 0 13.483 0zm-2.866 12.815a1.38 1.38 0 0 0-1.38 1.382 1.38 1.38 0 0 0 1.38 1.382H20.79a1.38 1.38 0 0 0 1.38-1.382 1.38 1.38 0 0 0-1.38-1.382z" },
  "kaggle": { title: "Kaggle", hex: "20BEFF", category: "social", path: "M.1025 7.3475c-.0681 0-.1022.0341-.1022.102v6.752c0 .0681.034.1022.1022.1022h.7049c.068 0 .1022-.034.1022-.1023v-1.481l.4187-.3985 1.5016 1.91c.041.0477.0884.0716.143.0716h.9091c.0476 0 .0748-.0135.0817-.0407.0135-.041.0066-.075-.0206-.1023l-1.9816-2.4618 1.9002-1.8384c.0204-.0205.0237-.051.01-.092-.0137-.0339-.0408-.051-.0816-.051h-.9398c-.0477 0-.0953.024-.143.0716L.9096 11.607V7.4496c0-.0679-.0342-.102-.1022-.102zm18.0417 0c-.068 0-.102.0341-.102.102v6.752c0 .0681.034.102.102.102h.705c.068 0 .102-.034.102-.102v-6.752c0-.068-.034-.102-.102-.102zM5.961 9.6254c-.5653 0-1.11.1806-1.6343.5415-.0545.0545-.0648.102-.0307.143l.3676.5208c.0272.0477.0717.0545.133.0204.3948-.2722.783-.4086 1.1644-.4086.2927 0 .5158.0886.669.2656.1532.1771.2197.3917.1992.6436-.6606.0681-1.1545.1495-1.4813.245-.8308.2383-1.2461.6913-1.2461 1.3586 0 .4222.1533.7695.4598 1.0419.3132.2654.6845.3982 1.1134.3982.4698 0 .8545-.1125 1.1542-.3372v.1432c0 .0682.0374.102.1123.102h.7048c.068 0 .102-.0338.102-.102V11.372c0-.6604-.2245-1.1406-.6739-1.4403-.3065-.2043-.6776-.3063-1.1134-.3063zm4.3225 0c-.6742 0-1.195.2622-1.5627.7865-.3133.4359-.4699.9671-.4699 1.5936 0 .6604.1634 1.2087.4903 1.6444.3744.4972.892.7455 1.5526.7455.5313 0 .9567-.1327 1.2768-.3982v.531c0 .858-.4122 1.287-1.236 1.287-.361 0-.732-.1907-1.1132-.572a.098.098 0 00-.0716-.0306c-.034 0-.0613.0102-.0817.0307l-.4802.48c-.0408.0613-.0375.1124.0103.1532.1361.1157.2554.2129.3576.2911.102.0783.1905.1413.2656.189.354.1975.7284.2961 1.1235.2961.6808 0 1.207-.1925 1.5781-.577.3711-.3848.5567-.9484.5567-1.6903V9.8196c0-.068-.034-.102-.102-.102h-.705c-.0682 0-.1021.034-.1021.102v.2043c-.3471-.2657-.7763-.3985-1.287-.3985zm4.8021 0c-.6742 0-1.195.2622-1.5627.7865-.3132.4359-.4699.9671-.4699 1.5936 0 .6604.1633 1.2087.4903 1.6444.3744.4972.892.7455 1.5526.7455.5311 0 .9566-.1327 1.2768-.3982v.531c0 .858-.4122 1.287-1.236 1.287-.361 0-.732-.1907-1.1133-.572a.098.098 0 00-.0716-.0306c-.034 0-.0612.0102-.0816.0307l-.48.48c-.0409.0613-.0376.1124.01.1532.1363.1157.2555.2129.3576.2911.1021.0783.1906.1413.2657.189.354.1975.7285.2961 1.1237.2961.6808 0 1.2068-.1925 1.5781-.577.371-.3848.5565-.9484.5565-1.6903V9.8196c0-.068-.034-.102-.102-.102h-.7049c-.0682 0-.1022.034-.1022.102v.2043c-.3474-.2657-.7763-.3985-1.287-.3985zm6.7457 0c-.6537 0-1.185.211-1.5936.6332-.4427.4632-.664 1.0283-.664 1.6956 0 .7083.225 1.2905.6743 1.7467.463.463 1.042.6945 1.7366.6945.6467 0 1.2154-.1838 1.7057-.5515.0545-.041.0545-.0884 0-.143l-.4802-.4903c-.041-.0409-.0919-.0409-.1533 0-.2998.2112-.6368.3167-1.0112.3167-.4222 0-.7729-.119-1.052-.3576-.2452-.2248-.3882-.5038-.429-.8375h3.3197c.0679 0 .1022-.0341.1022-.1023l.01-.2244c.0341-.6878-.1668-1.26-.6025-1.7162-.4224-.4426-.9432-.664-1.5627-.664zm-.0206.7865c.3268 0 .6062.1056.8377.3166.2452.211.371.4734.378.7865h-2.4618c.0613-.3269.2077-.5925.4392-.7968.2313-.2042.5004-.3063.8069-.3063zm-11.4249.102c.6196 0 1.0146.2181 1.1848.6538v1.6854c-.1702.4358-.5755.6538-1.2155.6538-.3133 0-.5687-.0986-.7661-.2963-.2656-.2518-.3983-.6538-.3983-1.2053 0-.9941.3984-1.4914 1.1951-1.4914zm4.802 0c.6196 0 1.0148.2181 1.1851.6538h-.0002v1.6854c-.1703.4358-.5755.6538-1.2155.6538-.3132 0-.5686-.0986-.7661-.2963-.2655-.2518-.3983-.6538-.3983-1.2053 0-.9941.3983-1.4914 1.195-1.4914zm-8.3586 1.6547v1.0215c-.286.286-.6675.412-1.1441.3779-.1703-.0135-.32-.0663-.4493-.1582-.1294-.0919-.2045-.2129-.2249-.3627-.0341-.2657.1158-.47.4495-.6129.2452-.1088.7013-.1974 1.3688-.2656z" },
  "dribbble": { title: "Dribbble", hex: "EA4C89", category: "social", path: "M12 24C5.385 24 0 18.615 0 12S5.385 0 12 0s12 5.385 12 12-5.385 12-12 12zm10.12-10.358c-.35-.11-3.17-.953-6.384-.438 1.34 3.684 1.887 6.684 1.992 7.308 2.3-1.555 3.936-4.02 4.395-6.87zm-6.115 7.808c-.153-.9-.75-4.032-2.19-7.77l-.066.02c-5.79 2.015-7.86 6.025-8.04 6.4 1.73 1.358 3.92 2.166 6.29 2.166 1.42 0 2.77-.29 4-.814zm-11.62-2.58c.232-.4 3.045-5.055 8.332-6.765.135-.045.27-.084.405-.12-.26-.585-.54-1.167-.832-1.74C7.17 11.775 2.206 11.71 1.756 11.7l-.004.312c0 2.633.998 5.037 2.634 6.855zm-2.42-8.955c.46.008 4.683.026 9.477-1.248-1.698-3.018-3.53-5.558-3.8-5.928-2.868 1.35-5.01 3.99-5.676 7.17zM9.6 2.052c.282.38 2.145 2.914 3.822 6 3.645-1.365 5.19-3.44 5.373-3.702-1.81-1.61-4.19-2.586-6.795-2.586-.825 0-1.63.1-2.4.285zm10.335 3.483c-.218.29-1.935 2.493-5.724 4.04.24.49.47.985.68 1.486.08.18.15.36.22.53 3.41-.43 6.8.26 7.14.33-.02-2.42-.88-4.64-2.31-6.38z" },
  "behance": { title: "Behance", hex: "1769FF", category: "social", path: "M16.969 16.927a2.561 2.561 0 0 0 1.901.677 2.501 2.501 0 0 0 1.531-.475c.362-.235.636-.584.779-.99h2.585a5.091 5.091 0 0 1-1.9 2.896 5.292 5.292 0 0 1-3.091.88 5.839 5.839 0 0 1-2.284-.433 4.871 4.871 0 0 1-1.723-1.211 5.657 5.657 0 0 1-1.08-1.874 7.057 7.057 0 0 1-.383-2.393c-.005-.8.129-1.595.396-2.349a5.313 5.313 0 0 1 5.088-3.604 4.87 4.87 0 0 1 2.376.563c.661.362 1.231.87 1.668 1.485a6.2 6.2 0 0 1 .943 2.133c.194.821.263 1.666.205 2.508h-7.699c-.063.79.184 1.574.688 2.187ZM6.947 4.084a8.065 8.065 0 0 1 1.928.198 4.29 4.29 0 0 1 1.49.638c.418.303.748.711.958 1.182.241.579.357 1.203.341 1.83a3.506 3.506 0 0 1-.506 1.961 3.726 3.726 0 0 1-1.503 1.287 3.588 3.588 0 0 1 2.027 1.437c.464.747.697 1.615.67 2.494a4.593 4.593 0 0 1-.423 2.032 3.945 3.945 0 0 1-1.163 1.413 5.114 5.114 0 0 1-1.683.807 7.135 7.135 0 0 1-1.928.259H0V4.084h6.947Zm-.235 12.9c.308.004.616-.029.916-.099a2.18 2.18 0 0 0 .766-.332c.228-.158.411-.371.534-.619.142-.317.208-.663.191-1.009a2.08 2.08 0 0 0-.642-1.715 2.618 2.618 0 0 0-1.696-.505h-3.54v4.279h3.471Zm13.635-5.967a2.13 2.13 0 0 0-1.654-.619 2.336 2.336 0 0 0-1.163.259 2.474 2.474 0 0 0-.738.62 2.359 2.359 0 0 0-.396.792c-.074.239-.12.485-.137.734h4.769a3.239 3.239 0 0 0-.679-1.785l-.002-.001Zm-13.813-.648a2.254 2.254 0 0 0 1.423-.433c.399-.355.607-.88.56-1.413a1.916 1.916 0 0 0-.178-.891 1.298 1.298 0 0 0-.495-.533 1.851 1.851 0 0 0-.711-.274 3.966 3.966 0 0 0-.835-.073H3.241v3.631h3.293v-.014ZM21.62 5.122h-5.976v1.527h5.976V5.122Z" },
  "codeberg": { title: "Codeberg", hex: "2185D0", category: "social", path: "M11.999.747A11.974 11.974 0 0 0 0 12.75c0 2.254.635 4.465 1.833 6.376L11.837 6.19c.072-.092.251-.092.323 0l4.178 5.402h-2.992l.065.239h3.113l.882 1.138h-3.674l.103.374h3.86l.777 1.003h-4.358l.135.483h4.593l.695.894h-5.038l.165.589h5.326l.609.785h-5.717l.182.65h6.038l.562.727h-6.397l.183.65h6.717A12.003 12.003 0 0 0 24 12.75 11.977 11.977 0 0 0 11.999.747zm3.654 19.104.182.65h5.326c.173-.204.353-.433.513-.65zm.385 1.377.18.65h3.563c.233-.198.485-.428.712-.65zm.383 1.377.182.648h1.203c.356-.204.685-.412 1.042-.648zz" },
  "orcid": { title: "ORCID", hex: "A6CE39", category: "social", path: "M12 0C5.372 0 0 5.372 0 12s5.372 12 12 12 12-5.372 12-12S18.628 0 12 0zM7.369 4.378c.525 0 .947.431.947.947s-.422.947-.947.947a.95.95 0 0 1-.947-.947c0-.525.422-.947.947-.947zm-.722 3.038h1.444v10.041H6.647V7.416zm3.562 0h3.9c3.712 0 5.344 2.653 5.344 5.025 0 2.578-2.016 5.025-5.325 5.025h-3.919V7.416zm1.444 1.303v7.444h2.297c3.272 0 4.022-2.484 4.022-3.722 0-2.016-1.284-3.722-4.097-3.722h-2.222z" },
  "googlescholar": { title: "Google Scholar", hex: "4285F4", category: "social", path: "M5.242 13.769L0 9.5 12 0l12 9.5-5.242 4.269C17.548 11.249 14.978 9.5 12 9.5c-2.977 0-5.548 1.748-6.758 4.269zM12 10a7 7 0 1 0 0 14 7 7 0 0 0 0-14z" }
};

// src/cards/icons.ts
var MONOGRAMS = {
  csharp: { title: "C#", hex: "68217A", text: "C#", category: "language" },
  java: { title: "Java", hex: "E76F00", text: "Java", category: "language" },
  powershell: { title: "PowerShell", hex: "5391FE", text: ">_", category: "language" },
  visualbasic: { title: "Visual Basic", hex: "945DB7", text: "VB", category: "language" },
  amazonwebservices: { title: "AWS", hex: "FF9900", text: "aws", category: "cloud" },
  awslambda: { title: "AWS Lambda", hex: "FF9900", text: "\u03BB", category: "cloud" },
  amazondynamodb: { title: "DynamoDB", hex: "4053D6", text: "DDB", category: "data" },
  microsoftazure: { title: "Azure", hex: "0078D4", text: "Az", category: "cloud" },
  azuredevops: { title: "Azure DevOps", hex: "0078D7", text: "AD", category: "devops" },
  microsoft: { title: "Microsoft", hex: "5E5E5E", text: "MS", category: "tool" },
  microsoftsqlserver: { title: "SQL Server", hex: "CC2927", text: "SQL", category: "data" },
  windows: { title: "Windows", hex: "0078D4", text: "Win", category: "tool" },
  visualstudiocode: { title: "VS Code", hex: "007ACC", text: "VSC", category: "tool" },
  visualstudio: { title: "Visual Studio", hex: "5C2D91", text: "VS", category: "tool" },
  slack: { title: "Slack", hex: "4A154B", text: "#", category: "tool" },
  playwright: { title: "Playwright", hex: "2EAD33", text: "PW", category: "tool" },
  openai: { title: "OpenAI", hex: "10A37F", text: "AI", category: "ai" },
  oracle: { title: "Oracle", hex: "F80000", text: "O", category: "data" },
  heroku: { title: "Heroku", hex: "430098", text: "H", category: "cloud" },
  ibm: { title: "IBM", hex: "0F62FE", text: "IBM", category: "cloud" },
  twilio: { title: "Twilio", hex: "F22F46", text: "Tw", category: "cloud" },
  linkedin: { title: "LinkedIn", hex: "0A66C2", text: "in", category: "social" },
  hackernews: { title: "Hacker News", hex: "FF6600", text: "Y", category: "social" },
  codepen: { title: "CodePen", hex: "1E1F26", text: "CP", category: "social" }
};
var TITLES = {
  gnubash: "Bash",
  html5: "HTML",
  gnuemacs: "Emacs",
  intellijidea: "IntelliJ IDEA",
  googlecloud: "Google Cloud"
};
var GLYPHS = {
  email: {
    title: "Email",
    stroke: "M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 17V7A1.5 1.5 0 0 1 4 5.5ZM3 6.8l9 6.4 9-6.4"
  },
  website: {
    title: "Website",
    stroke: "M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18ZM3.2 12h17.6M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9M12 3c-2.4 2.5-3.6 5.5-3.6 9s1.2 6.5 3.6 9"
  },
  link: {
    title: "Link",
    stroke: "M10 14a4.2 4.2 0 0 0 6 0l3.2-3.2a4.2 4.2 0 0 0-6-6L12 6M14 10a4.2 4.2 0 0 0-6 0l-3.2 3.2a4.2 4.2 0 0 0 6 6L12 18"
  }
};
var ALIASES = {
  // languages
  cs: "csharp",
  csharpdotnet: "csharp",
  js: "javascript",
  ecmascript: "javascript",
  ts: "typescript",
  py: "python",
  python3: "python",
  golang: "go",
  rs: "rust",
  kt: "kotlin",
  rb: "ruby",
  cpp: "cplusplus",
  cxx: "cplusplus",
  fs: "fsharp",
  ex: "elixir",
  hs: "haskell",
  vb: "visualbasic",
  vbnet: "visualbasic",
  jdk: "java",
  bash: "gnubash",
  shell: "gnubash",
  sh: "gnubash",
  zsh: "gnubash",
  shellscript: "gnubash",
  pwsh: "powershell",
  html: "html5",
  css3: "css",
  scss: "sass",
  md: "markdown",
  tex: "latex",
  wasm: "webassembly",
  jupyternotebook: "jupyter",
  ipynb: "jupyter",
  vimscript: "vim",
  viml: "vim",
  emacslisp: "gnuemacs",
  nix: "nixos",
  hcl: "terraform",
  dockerfile: "docker",
  dockercompose: "docker",
  vue: "vuedotjs",
  // platforms & frameworks
  dotnetcore: "dotnet",
  net: "dotnet",
  netcore: "dotnet",
  aspnet: "dotnet",
  aspnetcore: "dotnet",
  dotnetframework: "dotnet",
  node: "nodedotjs",
  nodejs: "nodedotjs",
  next: "nextdotjs",
  nextjs: "nextdotjs",
  vuejs: "vuedotjs",
  vue3: "vuedotjs",
  nuxtjs: "nuxt",
  nuxtdotjs: "nuxt",
  solidjs: "solid",
  threejs: "threedotjs",
  three: "threedotjs",
  d3js: "d3",
  d3dotjs: "d3",
  tailwind: "tailwindcss",
  shadcn: "shadcnui",
  rails: "rubyonrails",
  ror: "rubyonrails",
  reactjs: "react",
  reactnative: "react",
  angularjs: "angular",
  sveltekit: "svelte",
  nest: "nestjs",
  springframework: "spring",
  denojs: "deno",
  bunjs: "bun",
  expressjs: "express",
  torch: "pytorch",
  sklearn: "scikitlearn",
  hf: "huggingface",
  chatgpt: "openai",
  gpt: "openai",
  copilot: "githubcopilot",
  // infrastructure & data
  k8s: "kubernetes",
  kube: "kubernetes",
  postgres: "postgresql",
  pg: "postgresql",
  psql: "postgresql",
  mongo: "mongodb",
  elastic: "elasticsearch",
  kafka: "apachekafka",
  aws: "amazonwebservices",
  amazon: "amazonwebservices",
  amazonaws: "amazonwebservices",
  lambda: "awslambda",
  dynamodb: "amazondynamodb",
  azure: "microsoftazure",
  msazure: "microsoftazure",
  ado: "azuredevops",
  spark: "apachespark",
  airflow: "apacheairflow",
  gcp: "googlecloud",
  gcloud: "googlecloud",
  googlecloudplatform: "googlecloud",
  sqlserver: "microsoftsqlserver",
  mssql: "microsoftsqlserver",
  fly: "flydotio",
  flyio: "flydotio",
  gha: "githubactions",
  actions: "githubactions",
  gh: "github",
  // tools & OS
  vscode: "visualstudiocode",
  code: "visualstudiocode",
  vs: "visualstudio",
  win: "windows",
  macos: "apple",
  osx: "apple",
  mac: "apple",
  arch: "archlinux",
  rpi: "raspberrypi",
  raspberry: "raspberrypi",
  nvim: "neovim",
  emacs: "gnuemacs",
  intellij: "intellijidea",
  godot: "godotengine",
  jetbrainsrider: "rider",
  // social
  twitter: "x",
  xdotcom: "x",
  devto: "devdotto",
  so: "stackoverflow",
  yt: "youtube",
  ig: "instagram",
  insta: "instagram",
  bsky: "bluesky",
  bmc: "buymeacoffee",
  sponsors: "githubsponsors",
  hn: "hackernews",
  li: "linkedin",
  mail: "email",
  site: "website",
  web: "website",
  blog: "website",
  homepage: "website",
  url: "link"
};
function slugify(input) {
  return input.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\+/g, "plus").replace(/\./g, "dot").replace(/&/g, "and").replace(/#/g, "sharp").replace(/[^a-z0-9]/g, "");
}
function canonical(input) {
  const slug = slugify(input);
  return own(ALIASES, slug) ?? slug;
}
function monogramText(input) {
  const clean2 = input.trim();
  if (!clean2) return "?";
  if ([...clean2].length <= 3) return clean2.charAt(0).toUpperCase() + clean2.slice(1);
  const words2 = clean2.split(/[\s\-_/.]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words2.length >= 2) return words2.slice(0, 2).map((w) => [...w][0]?.toUpperCase() ?? "").join("");
  const chars = [...clean2.replace(/[^\p{L}\p{N}]/gu, "")];
  if (!chars.length) return [...clean2].slice(0, 2).join("");
  return (chars[0] ?? "").toUpperCase() + (chars[1] ?? "").toLowerCase();
}
function resolveIcon(input) {
  const raw = String(input ?? "").trim();
  const slug = canonical(raw);
  const icon3 = own(ICONS, slug);
  if (icon3) return { slug, title: own(TITLES, slug) ?? icon3.title, hex: `#${icon3.hex}`, category: icon3.category, path: icon3.path, known: true };
  const mono = own(MONOGRAMS, slug);
  if (mono) return { slug, title: mono.title, hex: `#${mono.hex}`, category: mono.category, monogram: mono.text, known: true };
  const glyph = own(GLYPHS, slug);
  if (glyph) return { slug, title: glyph.title, hex: "", category: "generic", stroke: glyph.stroke, known: true };
  return { slug: slug || "unknown", title: raw || "Unknown", hex: "", category: "generic", monogram: monogramText(raw), known: false };
}
function saturation(c) {
  const h = c.replace("#", "");
  const v = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) || 0);
  return (Math.max(...v) - Math.min(...v)) / 255;
}
function legible(color, bg, ink, base = 2.3) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return ink;
  const sat = saturation(color);
  const min = Math.max(1.35, base - 1.1 * sat);
  if (contrast(color, bg) >= min) return color;
  if (sat < 0.14) return ink;
  return ensureContrast(color, bg, min, ink);
}
function inkOn(fill, a, b) {
  return contrast(fill, a) >= contrast(fill, b) ? a : b;
}
function drawIcon(icon3, x, y, size, o) {
  const attrs = o.attrs ? ` ${o.attrs}` : "";
  const k = size / 24;
  const t = `translate(${n(x, 2)} ${n(y, 2)}) scale(${n(k, 4)})`;
  if (icon3.path) return `<path${attrs} transform="${t}" fill="${o.color}" d="${icon3.path}"/>`;
  if (icon3.stroke) {
    return `<path${attrs} transform="${t}" fill="none" stroke="${o.color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="${icon3.stroke}"/>`;
  }
  const text = icon3.monogram ?? "?";
  const len = [...text].length;
  const fs = size * (len <= 1 ? 0.56 : len === 2 ? 0.44 : len === 3 ? 0.34 : 0.28);
  const ink = inkOn(o.color, o.inks[0], o.inks[1]);
  return `<g${attrs}><rect x="${n(x, 2)}" y="${n(y, 2)}" width="${n(size, 2)}" height="${n(size, 2)}" rx="${n(size * 0.24, 2)}" fill="${o.color}"/><text x="${n(x + size / 2, 2)}" y="${n(y + size / 2 + fs * 0.36, 2)}" text-anchor="middle" class="sans" font-size="${n(fs, 2)}" font-weight="800" letter-spacing="${n(-fs * 0.02, 2)}" fill="${ink}">${esc(text)}</text></g>`;
}

// src/cards/hero.ts
var W2 = 1200;
var H = 400;
var X0 = 60;
var CODE_LANGUAGES = [
  "csharp",
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
  "java",
  "kotlin",
  "swift",
  "ruby",
  "php",
  "json"
];
var FILES = {
  csharp: "Program.cs",
  typescript: "profile.ts",
  javascript: "profile.js",
  python: "me.py",
  go: "main.go",
  rust: "main.rs",
  java: "Main.java",
  kotlin: "Main.kt",
  swift: "main.swift",
  ruby: "me.rb",
  php: "me.php",
  json: "profile.json"
};
var FILE_ICONS = {
  csharp: "csharp",
  typescript: "typescript",
  javascript: "javascript",
  python: "python",
  go: "go",
  rust: "rust",
  java: "java",
  kotlin: "kotlin",
  swift: "swift",
  ruby: "ruby",
  php: "php",
  json: "json"
};
var LANG_ALIASES = {
  csharp: "csharp",
  cs: "csharp",
  dotnet: "csharp",
  typescript: "typescript",
  ts: "typescript",
  tsx: "typescript",
  vue: "typescript",
  svelte: "typescript",
  astro: "typescript",
  javascript: "javascript",
  js: "javascript",
  jsx: "javascript",
  nodedotjs: "javascript",
  node: "javascript",
  python: "python",
  py: "python",
  jupyternotebook: "python",
  go: "go",
  golang: "go",
  rust: "rust",
  rs: "rust",
  java: "java",
  kotlin: "kotlin",
  kt: "kotlin",
  swift: "swift",
  ruby: "ruby",
  rb: "ruby",
  php: "php",
  json: "json"
};
function codeLanguageOf(name) {
  return own(LANG_ALIASES, slugify(name)) ?? null;
}
function detectLanguage(data) {
  for (const l of data.languages) {
    const lang = codeLanguageOf(l.name);
    if (lang) return lang;
  }
  return "json";
}
var words = (s) => new Set(s.split(/\s+/).filter(Boolean));
var C_LIKE = { comments: ["//"], quotes: `"'`, blockComments: true };
var SYNTAX = {
  csharp: {
    ...C_LIKE,
    keywords: words(
      "var new await async public private protected internal static class record struct interface void return using namespace if else for foreach in while get set init readonly const this base override virtual sealed partial required"
    ),
    types: words("string int long bool double decimal object dynamic Task List"),
    literals: words("true false null")
  },
  typescript: {
    ...C_LIKE,
    quotes: "\"'`",
    keywords: words(
      "const let var function return await async new export import from default interface type class extends implements as satisfies readonly public private protected if else for of in while typeof keyof"
    ),
    types: words("string number boolean void unknown any never object"),
    literals: words("true false null undefined")
  },
  javascript: {
    ...C_LIKE,
    quotes: "\"'`",
    keywords: words("const let var function return await async new export import from default class extends if else for of in while typeof"),
    types: words(""),
    literals: words("true false null undefined")
  },
  python: {
    comments: ["#"],
    quotes: `"'`,
    blockComments: false,
    keywords: words("def class return import from as with for in if elif else while await async lambda pass yield and or not is self"),
    types: words("str int bool float list dict"),
    literals: words("True False None")
  },
  go: {
    ...C_LIKE,
    quotes: "\"'`",
    keywords: words("package import func var const type struct interface return if else for range go defer chan map select switch case"),
    types: words("string int int64 bool error byte rune float64 any"),
    literals: words("true false nil")
  },
  rust: {
    ...C_LIKE,
    quotes: '"',
    keywords: words("let mut fn struct impl pub use mod return if else for in while loop match async await move const static enum trait where self Self"),
    types: words("String str Vec Option Result u8 u32 u64 i32 i64 usize bool"),
    literals: words("true false")
  },
  java: {
    ...C_LIKE,
    keywords: words("var new public private protected static final class record interface void return import package if else for while this extends implements"),
    types: words("String int long boolean double List Map"),
    literals: words("true false null")
  },
  kotlin: {
    ...C_LIKE,
    keywords: words("val var fun class data object return import package if else for in while when suspend this"),
    types: words("String Int Long Boolean List"),
    literals: words("true false null")
  },
  swift: {
    ...C_LIKE,
    quotes: '"',
    keywords: words("let var func struct class enum return import if else for in while guard try await async throws self init"),
    types: words("String Int Bool Double"),
    literals: words("true false nil")
  },
  ruby: {
    comments: ["#"],
    quotes: `"'`,
    blockComments: false,
    keywords: words("def end class module return require do if else elsif unless while self attr_reader"),
    types: words(""),
    literals: words("true false nil")
  },
  php: {
    ...C_LIKE,
    comments: ["//", "#"],
    keywords: words("function return new class public private protected static use namespace echo fn if else foreach as readonly"),
    types: words("string int bool array"),
    literals: words("true false null")
  },
  json: {
    comments: [],
    quotes: '"',
    blockComments: false,
    keywords: words(""),
    types: words(""),
    literals: words("true false null")
  }
};
var PUNCT = /* @__PURE__ */ new Set(["{", "}", "[", "]", "(", ")", ";", ",", ":", "=", "?"]);
var OPS = ["=>", "->", ":=", "::", "??", "?.", "==", "!=", "<=", ">="];
function tokenize(line, lang) {
  const spec = SYNTAX[lang];
  const out = [];
  const push = (kind, text) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  const first = line.search(/\S/);
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    if (spec.comments.some((c) => rest.startsWith(c)) && !(lang === "php" && rest.startsWith("#["))) {
      push("comment", rest);
      break;
    }
    if (spec.blockComments && rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2);
      const text = end < 0 ? rest : rest.slice(0, end + 2);
      push("comment", text);
      i += text.length;
      continue;
    }
    if (lang === "php" && rest.startsWith("<?php")) {
      push("keyword", "<?php");
      i += 5;
      continue;
    }
    const str = new RegExp(`^(?:[$@]{1,2}|[fFrRbB]{1,2})?([${spec.quotes.replace(/[\]\\^-]/g, "\\$&")}])`).exec(rest);
    if (str) {
      const quote = str[1];
      let j = str[0].length;
      while (j < rest.length && rest[j] !== quote) j += rest[j] === "\\" ? 2 : 1;
      const text = rest.slice(0, Math.min(rest.length, j + 1));
      const next = rest.slice(text.length).trimStart();
      push(i === first && next.startsWith(":") && !next.startsWith("::") ? "property" : "string", text);
      i += text.length;
      continue;
    }
    const num = /^(?:0x[\da-f_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)[a-z]*/i.exec(rest);
    if (num) {
      push("number", num[0]);
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (id) {
      const word = id[0];
      const next = rest.slice(word.length).trimStart();
      const before = line.slice(0, i).trimEnd();
      const member = before.endsWith(".") || before.endsWith("->");
      let kind = "plain";
      if (spec.keywords.has(word) && (!member || lang === "rust" && word === "await")) kind = "keyword";
      else if (spec.literals.has(word)) kind = "number";
      else if (spec.types.has(word)) kind = "type";
      else if (next.startsWith("(") || lang === "rust" && next.startsWith("!")) kind = "type";
      else if (member) kind = "property";
      else if (first > 0 && i === first && (next.startsWith(":") && !next.startsWith("::") || /^=(?![=>])/.test(next)))
        kind = "property";
      else if (/^[A-Z]/.test(word) && lang !== "json") kind = "type";
      push(kind, word);
      i += word.length;
      continue;
    }
    const ws = /^\s+/.exec(rest);
    if (ws) {
      push("plain", ws[0]);
      i += ws[0].length;
      continue;
    }
    const op = OPS.find((o) => rest.startsWith(o));
    if (op) {
      push(op === "?." ? "plain" : "punctuation", op);
      i += op.length;
      continue;
    }
    const ch = rest[0];
    push(PUNCT.has(ch) ? "punctuation" : "plain", ch);
    i += 1;
  }
  return out;
}
var BUILD_VERB = /^(i\s*(am|'m)\s+)?(building|making|creating|crafting|shipping|writing|developing|designing|exploring|working\s+on|i\s+build|i\s+make|i\s+create|i\s+craft|i\s+ship|i\s+write|i\s+develop|i\s+design)\s+/i;
function bioClauses(bio) {
  const out = [];
  for (const line of (bio ?? "").split(/\r?\n/)) {
    for (const segment of line.split(/\s*\|\s*|\s+[—–-]\s+/)) {
      for (const sentence of segment.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/)) {
        const clause = sentence.trim();
        if (/[\p{L}\p{N}]/u.test(clause)) out.push(clause);
      }
    }
  }
  return out;
}
var stripEnd = (s) => s.replace(/[\s.!?,;:·]+$/, "").trim();
var keyOf = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function roleFrom(clause, fits) {
  const text = stripEnd(clause);
  if (!text) return "";
  if (fits(text)) return text;
  const cuts = [...text.matchAll(/\s+[·•/]\s+/g)].map((m) => m.index).reverse();
  for (const at of cuts) {
    const head = stripEnd(text.slice(0, at));
    if (head && fits(head)) return head;
  }
  return "";
}
function isLocation(clause, location) {
  if (/^\s*(?:📍|🌍|🌎|🌏)/u.test(clause)) return true;
  const key = keyOf(clause.replace(/^\s*(?:based\s+in|living\s+in|located\s+in|from)\s+/i, ""));
  if (!key || !location.trim()) return false;
  const parts2 = location.split(/[,/·|]/).map(keyOf).filter(Boolean);
  return key === keyOf(location) || parts2.includes(key);
}
var restates = (a, b) => {
  const [x, y] = [keyOf(a), keyOf(b)];
  if (!x || !y) return false;
  if (!x.includes(" ") || !y.includes(" ")) return x === y;
  return `${x} `.startsWith(`${y} `) || `${y} `.startsWith(`${x} `);
};
var ROLE_SIZE = 25;
var ROLE_WEIGHT = 600;
var DEFAULT_ROLE = "Developer";
function deriveCopy(data, colW, roleOption) {
  const clauses = bioClauses(data.bio);
  if (roleOption) return { role: roleOption, rest: clauses.filter((c) => !restates(c, roleOption)) };
  const fits = (s) => textWidth(s, ROLE_SIZE, { weight: ROLE_WEIGHT }) <= colW;
  const at = clauses.findIndex((c) => !isLocation(c, data.location ?? ""));
  const role = at >= 0 ? roleFrom(clauses[at] ?? "", fits) : "";
  return role ? { role, rest: clauses.filter((_, i) => i !== at) } : { role: DEFAULT_ROLE, rest: clauses };
}
function joinClauses(parts2) {
  let out = "";
  for (const part of parts2) out = !out ? part : `${out}${/[.!?]$/.test(out) ? " " : " \xB7 "}${part}`;
  return out;
}
function onlyPlaceWords(text, location) {
  const words2 = (s) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const place = new Set(words2(location));
  const own2 = words2(text);
  return own2.length > 0 && own2.every((w) => place.has(w));
}
var NOISE_TOPICS = /* @__PURE__ */ new Set([
  "hacktoberfest",
  "github",
  "awesome",
  "awesome-list",
  "github-profile",
  "profile-readme",
  "readme",
  "github-readme",
  "github-actions",
  "github-action",
  "svg",
  "template",
  "open-source",
  "opensource",
  "portfolio",
  "cli",
  "library"
]);
function topTopics(data, limit = 3) {
  const profileRepo = `${data.login}/${data.login}`.toLowerCase();
  const counts = /* @__PURE__ */ new Map();
  for (const repo of data.repos ?? []) {
    if (repo.isPrivate || repo.isFork || repo.isArchived || repo.nameWithOwner.toLowerCase() === profileRepo) continue;
    for (const topic of new Set((repo.topics ?? []).map((t) => t.trim().toLowerCase()))) {
      if (!topic || NOISE_TOPICS.has(topic) || codeLanguageOf(topic) || resolveIcon(topic).category === "language") continue;
      counts.set(topic, (counts.get(topic) ?? 0) + 1);
    }
  }
  return [...counts].filter(([, n2]) => n2 >= 2).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([t]) => t);
}
function focusOf(data, copy) {
  const location = data.location?.trim() ?? "";
  const left = copy.rest.filter((c) => !restates(c, copy.role) && !isLocation(c, location));
  const sentence = left.find((s) => BUILD_VERB.test(s)) ?? left[0];
  if (sentence) {
    const text = stripEnd(sentence.replace(BUILD_VERB, "")) || stripEnd(sentence);
    if (text && !restates(text, copy.role)) return text.charAt(0).toUpperCase() + text.slice(1);
  }
  const topics = topTopics(data);
  return topics.length ? topics : void 0;
}
function fitWords(s, maxW, size, opts = {}) {
  const cut = fit(s, maxW, size, opts);
  if (cut === s) return s;
  const kept = cut.slice(0, -1);
  const space = kept.search(/[\s·,;:/-]+\S*$/);
  return space >= kept.length * 0.55 ? `${kept.slice(0, space).replace(/[\s·,;:/-]+$/, "")}\u2026` : cut;
}
function languageNames(data, limit) {
  return [...new Set(data.languages.map((l) => displayName(l.name)).filter(Boolean))].slice(0, limit);
}
function factsFrom(data, name, now, copy) {
  const year = Number(data.createdAt.slice(0, 4));
  return {
    name,
    login: data.login,
    base: data.location?.trim() || void 0,
    stack: languageNames(data, 3),
    focus: focusOf(data, copy ?? deriveCopy(data, CODE_COL_W)),
    since: Number.isFinite(year) && year > 1990 ? year : now.getUTCFullYear()
  };
}
var pascal = (k) => k.charAt(0).toUpperCase() + k.slice(1);
var TEMPLATES = {
  csharp: {
    open: ["var me = new Developer", "{"],
    close: ["};", "await me.ShipAsync();"],
    indent: "    ",
    key: pascal,
    field: (k, v, _l, w) => `    ${k.padEnd(w)} = ${v},`,
    quote: '"',
    list: (xs) => `[${xs.join(", ")}]`,
    listOverhead: 2
  },
  typescript: {
    open: ["const me: Developer = {"],
    close: ["};", "await ship(me);"],
    indent: "  ",
    key: (k) => k,
    field: (k, v) => `  ${k}: ${v},`,
    quote: '"',
    list: (xs) => `[${xs.join(", ")}]`,
    listOverhead: 2
  },
  javascript: {
    open: ["const me = {"],
    close: ["};", "export default me;"],
    indent: "  ",
    key: (k) => k,
    field: (k, v) => `  ${k}: ${v},`,
    quote: '"',
    list: (xs) => `[${xs.join(", ")}]`,
    listOverhead: 2
  },
  python: {
    open: ["me = Developer("],
    close: [")", "me.ship()"],
    indent: "    ",
    key: (k) => k,
    field: (k, v) => `    ${k}=${v},`,
    quote: '"',
    list: (xs) => `[${xs.join(", ")}]`,
    listOverhead: 2
  },
  go: {
    open: ["me := Developer{"],
    close: ["}", "me.Ship()"],
    indent: "    ",
    key: pascal,
    field: (k, v, _l, w) => `    ${`${k}:`.padEnd(w + 1)} ${v},`,
    quote: '"',
    list: (xs) => `[]string{${xs.join(", ")}}`,
    listOverhead: 10
  },
  rust: {
    open: ["let me = Developer {"],
    close: ["};", "me.ship().await?;"],
    indent: "    ",
    key: (k) => k,
    field: (k, v) => `    ${k}: ${v},`,
    quote: '"',
    list: (xs) => `vec![${xs.join(", ")}]`,
    listOverhead: 6
  },
  java: {
    open: ["var me = Developer.builder()"],
    close: ["    .build();", "me.ship();"],
    indent: "    ",
    key: (k) => k,
    field: (k, v) => `    .${k}(${v})`,
    quote: '"',
    list: (xs) => `List.of(${xs.join(", ")})`,
    listOverhead: 9
  },
  kotlin: {
    open: ["val me = Developer("],
    close: [")", "me.ship()"],
    indent: "    ",
    key: (k) => k,
    field: (k, v) => `    ${k} = ${v},`,
    quote: '"',
    list: (xs) => `listOf(${xs.join(", ")})`,
    listOverhead: 8
  },
  swift: {
    open: ["let me = Developer("],
    close: [")", "try await me.ship()"],
    indent: "    ",
    key: (k) => k,
    field: (k, v, last) => `    ${k}: ${v}${last ? "" : ","}`,
    quote: '"',
    list: (xs) => `[${xs.join(", ")}]`,
    listOverhead: 2
  },
  ruby: {
    open: ["me = Developer.new("],
    close: [")", "me.ship!"],
    indent: "  ",
    key: (k) => k,
    field: (k, v, last) => `  ${k}: ${v}${last ? "" : ","}`,
    quote: '"',
    list: (xs) => `[${xs.join(", ")}]`,
    listOverhead: 2
  },
  php: {
    open: ["<?php", "$me = new Developer("],
    close: [");", "$me->ship();"],
    indent: "    ",
    key: (k) => k,
    field: (k, v) => `    ${k}: ${v},`,
    quote: "'",
    list: (xs) => `[${xs.join(", ")}]`,
    listOverhead: 2
  },
  json: {
    open: ["{"],
    close: ["}"],
    indent: "  ",
    key: (k) => `"${k}"`,
    field: (k, v, last) => `  ${k}: ${v}${last ? "" : ","}`,
    quote: '"',
    list: (xs) => `[${xs.join(", ")}]`,
    listOverhead: 2
  }
};
function quoted(s, quote, budget) {
  const escape = (x) => x.replace(/\\/g, "\\\\").replace(quote === '"' ? /"/g : /'/g, `\\${quote}`);
  let body = escape(s);
  if (body.length + 2 > budget) {
    let cut = [...s];
    while (cut.length > 1 && escape(`${cut.join("").trimEnd()}\u2026`).length + 2 > budget) cut = cut.slice(0, -1);
    let kept = cut.join("");
    const space = kept.search(/[\s·,;:/-]+\S*$/);
    if (space >= kept.length * 0.55) kept = kept.slice(0, space);
    body = escape(`${kept.replace(/[\s·,;:/-]+$/, "")}\u2026`);
  }
  return `${quote}${body}${quote}`;
}
function autoCode(f, lang, maxChars) {
  const t = TEMPLATES[lang];
  const fields = [["name", { kind: "str", v: f.name }]];
  if (f.base) fields.push(["base", { kind: "str", v: f.base }]);
  if (f.stack.length) fields.push(["stack", { kind: "list", v: f.stack }]);
  if (f.focus?.length) fields.push(["focus", typeof f.focus === "string" ? { kind: "str", v: f.focus } : { kind: "list", v: f.focus }]);
  if (fields.length < 3 && f.login) fields.push(["github", { kind: "str", v: `@${f.login}` }]);
  fields.push(["since", { kind: "num", v: f.since }]);
  const maxFields = 9 - t.open.length - t.close.length;
  const used = fields.slice(0, Math.max(1, maxFields));
  const keyWidth = Math.max(...used.map(([k]) => t.key(k).length));
  const lines = used.map(([k, value], idx) => {
    const key = t.key(k);
    const last = idx === used.length - 1;
    const overhead = t.field(key, "", last, keyWidth).length;
    const budget = Math.max(6, maxChars - overhead);
    let literal;
    if (value.kind === "num") literal = String(value.v);
    else if (value.kind === "str") literal = quoted(value.v, t.quote, budget);
    else {
      const items2 = [];
      for (const item of value.v) {
        const q = quoted(item, t.quote, 99);
        const next = [...items2, q];
        if (next.join(", ").length + t.listOverhead <= budget) items2.push(q);
        else break;
      }
      if (!items2.length) items2.push(quoted(value.v[0] ?? "", t.quote, budget - t.listOverhead));
      literal = t.list(items2);
    }
    return t.field(key, literal, last, keyWidth);
  });
  return [...t.open, ...lines, ...t.close].map((l) => clampLine(l, maxChars));
}
function clampLine(line, maxChars) {
  const chars = [...line];
  return chars.length <= maxChars ? line : `${chars.slice(0, maxChars - 1).join("")}\u2026`;
}
function customCode(code, maxChars) {
  const lines = code.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n").map((l) => l.trimEnd());
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  while (lines.length && !lines[0]) lines.shift();
  const kept = lines.slice(0, 9);
  while (kept.length && !kept[kept.length - 1]) kept.pop();
  return kept.map((l) => clampLine(l, maxChars));
}
function content(ctx, colW) {
  const d = ctx.data;
  const o = readOptions(ctx.options);
  const name = o.string("name", d.name?.trim() || d.login || "Hello, world");
  const copy = deriveCopy(d, colW, o.optionalString("role")?.trim());
  const role = copy.role;
  const statusRaw = o.string("status", "");
  const location = d.location?.trim() ?? "";
  const status = /^(none|false|off|hide)$/i.test(statusRaw.trim()) ? "" : statusRaw || ["open to collaboration", location].filter(Boolean).join(" \xB7 ");
  let tagline;
  const rawTag = o.raw("tagline");
  if (Array.isArray(rawTag)) tagline = rawTag.map((s) => String(s).trim()).filter(Boolean).slice(0, 2);
  else if (typeof rawTag === "string" && rawTag.trim()) tagline = wrapPx(rawTag.trim(), colW, 17, {}, 2);
  else {
    const city = (location.split(",")[0] ?? "").trim().toLowerCase();
    const statusLower = status.toLowerCase();
    const locationShown = !!location && (statusLower.includes(location.toLowerCase()) || city.length > 2 && statusLower.includes(city));
    const parts2 = copy.rest.filter((c) => !(locationShown && (isLocation(c, location) || onlyPlaceWords(c, location))));
    const company = d.company?.trim() ?? "";
    const bioKey = keyOf(d.bio ?? "");
    if (company && !` ${bioKey} `.includes(` ${keyOf(company)} `)) parts2.push(`Currently at ${company}.`);
    if (location && !locationShown && !parts2.some((c) => isLocation(c, location))) parts2.push(`Based in ${location}.`);
    const text = joinClauses(parts2);
    tagline = wrapPx(text || `Building in public on GitHub since ${factsFrom(d, name, ctx.now, copy).since}.`, colW, 17, {}, 2);
  }
  const chips2 = o.has("chips") ? o.list("chips", []) : languageNames(d, 6);
  return { name, role, copy, tagline, chips: chips2.slice(0, 12), status };
}
function nameFit(name, maxW) {
  const width = (s, size) => textWidth(s, size, { weight: 800 }) - size * 0.033 * Math.max(0, [...s].length - 1);
  for (let size = 76; size >= 48; size -= 2) if (width(name, size) <= maxW) return { text: name, size };
  return { text: fitWords(name, maxW, 48, { weight: 800 }), size: 48 };
}
var DOT_CONTRAST = 2.2;
function dotColor(color, bg, p) {
  return ensureContrast(safeColor(color, p.accentB), bg, DOT_CONTRAST, p.text);
}
function chipRow(chips2, x0, y, maxX, ctx) {
  const p = ctx.palette;
  const out = [];
  let x = x0;
  chips2.forEach((chip2, i) => {
    const text = fit(chip2, 220, 13, { mono: true });
    const icon3 = resolveIcon(chip2);
    const key = chip2.trim().toLowerCase();
    const lang = ctx.data.languages.find((l) => l.name.toLowerCase() === key || displayName(l.name).toLowerCase() === key);
    const w = Math.ceil(12 + 14 + 8 + textWidth(text, 13, { mono: true }) + 14);
    if (x + w > maxX) return;
    const glyph = icon3.path ? drawIcon(icon3, x + 12, y + 8, 14, { color: legible(icon3.hex, p.chipBg, p.text), inks: [p.panel, p.text] }) : icon3.monogram && icon3.known ? drawIcon(icon3, x + 11, y + 7, 16, { color: legible(icon3.hex, p.chipBg, p.text), inks: [p.panel, p.text] }) : `<circle cx="${n(x + 19, 2)}" cy="${y + 15}" r="4.5" fill="${dotColor(icon3.hex || lang?.color, p.chipBg, p)}"/>`;
    out.push(
      `<g class="up" ${delay(0.55 + i * 0.07)}><rect x="${n(x, 2)}" y="${y}" width="${w}" height="30" rx="15" fill="${p.chipBg}" stroke="${p.border}"/>${glyph}<text x="${n(x + 34, 2)}" y="${y + 19.5}" class="mono" font-size="13" fill="${p.text}">${esc(text)}</text></g>`
    );
    x += w + 10;
  });
  return out.join("");
}
function textColumn(c, colW, ctx, statusColor) {
  const p = ctx.palette;
  const name = nameFit(c.name, colW);
  const role = fitWords(c.role, colW, 25, { weight: 600 });
  const tagline = c.tagline.map((l) => fit(l, colW, 17));
  const blocks = [];
  if (c.status) {
    const text = fit(c.status, colW - 22, 14, { mono: true });
    blocks.push({
      h: 19,
      gap: 22,
      draw: (top2) => `<g class="up" ${delay(0.05)}><circle class="h-ring" cx="${X0 + 6}" cy="${top2 + 9}" r="4" fill="none" stroke="${statusColor}" stroke-width="1.5"/><circle class="h-pulse" cx="${X0 + 6}" cy="${top2 + 9}" r="4" fill="${statusColor}"/><text x="${X0 + 20}" y="${top2 + 14}" class="mono" font-size="14" fill="${p.muted}">${esc(text)}</text></g>`
    });
  }
  blocks.push({
    h: name.size,
    gap: 10,
    draw: (top2) => `<text class="sans up" ${delay(0.15)} x="${X0 - 2}" y="${n(top2 + name.size * 0.8)}" font-size="${name.size}" font-weight="800" letter-spacing="${n(-name.size * 0.033, 2)}" fill="url(#h-accent)">${esc(name.text)}</text>`
  });
  blocks.push({
    h: 29,
    gap: 16,
    draw: (top2) => `<text class="sans up" ${delay(0.28)} x="${X0}" y="${top2 + 22}" font-size="25" font-weight="600" letter-spacing="-.3" fill="${p.text}">${esc(role)}</text>`
  });
  if (tagline.length) {
    blocks.push({
      h: 22 + 26 * (tagline.length - 1),
      gap: 20,
      draw: (top2) => `<g class="up" ${delay(0.4)}>${tagline.map((l, i) => `<text x="${X0}" y="${top2 + 16 + i * 26}" class="sans" font-size="17" fill="${p.muted}">${esc(l)}</text>`).join("")}</g>`
    });
  }
  const chips2 = c.chips.length ? (top2) => chipRow(c.chips, X0, top2, X0 + colW, ctx) : null;
  if (chips2) blocks.push({ h: 30, gap: 0, draw: chips2 });
  const last = blocks[blocks.length - 1];
  if (last) last.gap = 0;
  const total = blocks.reduce((s, b) => s + b.h + b.gap, 0);
  let top = Math.round(H / 2 - total / 2 + 2);
  return blocks.map((b) => {
    const out = b.draw(top);
    top += b.h + b.gap;
    return out;
  }).join("");
}
var PANEL = { x: 700, y: 52, w: 452, h: 300 };
var CODE_COL_W = PANEL.x - 40 - X0;
var CODE_SIZE = 14.5;
var CHAR_W = CODE_SIZE * 0.6;
var CODE_X = PANEL.x + 50;
var MAX_CODE_CHARS = Math.floor((PANEL.x + PANEL.w - 18 - CODE_X) / CHAR_W);
function codePanel(lines, lang, file, ctx) {
  const p = ctx.palette;
  const s = p.syntax;
  const color = (k) => k === "plain" ? p.text : s[k];
  const { x, y, w, h } = PANEL;
  const lineH = 24;
  const firstBase = y + 44 + (h - 44 - lines.length * lineH) / 2 + 17;
  const body = lines.map((line, i) => {
    const by = n(firstBase + i * lineH);
    const num = `<text x="${x + 34}" y="${by}" text-anchor="end" class="mono" font-size="12" fill="${p.faint}" fill-opacity=".7">${i + 1}</text>`;
    if (!line.trim()) return num;
    const spans = tokenize(line, lang).map((t) => t.kind === "plain" ? esc(t.text) : `<tspan fill="${color(t.kind)}">${esc(t.text)}</tspan>`);
    if (i === lines.length - 1) spans.push(`<tspan class="h-cur" dx="2" fill="${p.accentB}">\u2588</tspan>`);
    return num + `<text class="mono h-code h-type" ${delay(0.55 + i * 0.3)} x="${CODE_X}" y="${by}" font-size="${CODE_SIZE}" fill="${p.text}" xml:space="preserve">${spans.join("")}</text>`;
  }).join("");
  const fileIcon = resolveIcon(FILE_ICONS[lang]);
  const fileName = fit(file, w - 160, 12.5, { mono: true });
  const fw = textWidth(fileName, 12.5, { mono: true });
  const fx = x + w / 2 - (fw + 20) / 2;
  const glyph = fileIcon.path ? drawIcon(fileIcon, fx, y + 15, 13, { color: legible(fileIcon.hex, p.panelAlt, p.text), inks: [p.panel, p.text] }) : fileIcon.monogram && fileIcon.known ? drawIcon(fileIcon, fx - 1, y + 14, 15, { color: legible(fileIcon.hex, p.panelAlt, p.text), inks: [p.panel, p.text] }) : `<circle cx="${n(fx + 6.5, 2)}" cy="${y + 21.5}" r="4" fill="${dotColor(fileIcon.hex, p.panelAlt, p)}"/>`;
  return `<g class="up" ${delay(0.3)}><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${p.panel}" fill-opacity=".86" stroke="${p.border}"/><path d="M${x} ${y + 16}a16 16 0 0 1 16-16h${w - 32}a16 16 0 0 1 16 16v28H${x}z" fill="${p.panelAlt}" fill-opacity=".92"/><circle cx="${x + 22}" cy="${y + 22}" r="5.5" fill="#FF5F57"/><circle cx="${x + 40}" cy="${y + 22}" r="5.5" fill="#FEBC2E"/><circle cx="${x + 58}" cy="${y + 22}" r="5.5" fill="#28C840"/>` + glyph + `<text x="${n(fx + 20, 2)}" y="${y + 26}" class="mono" font-size="12.5" fill="${p.muted}">${esc(fileName)}</text><line x1="${x}" y1="${y + 44}" x2="${x + w}" y2="${y + 44}" stroke="${p.border}"/>` + body + "</g>";
}
function activity(ctx) {
  const p = ctx.palette;
  const ramp = contribRamp(p, ctx.mode);
  const weeks = 18;
  const cell = 15;
  const gap = 4;
  const gw = weeks * (cell + gap) - gap;
  const gh = 7 * (cell + gap) - gap;
  const x0 = 1140 - gw;
  const y0 = Math.round(H / 2 - gh / 2) + 4;
  const cells = yearWindow(ctx.data.calendar, ctx.now, weeks);
  const total = cells.reduce((s, c) => s + c.count, 0);
  const level = levelScale(cells.map((c) => c.count));
  const empty = total === 0;
  const rects = cells.map((c) => {
    const lv = empty ? Math.max(0, Math.min(4, Math.round(c.week / (weeks - 1) * 4.6 - Math.abs(c.day - 3) * 0.45))) : level(c.count);
    const x = x0 + c.week * (cell + gap);
    const y = y0 + c.day * (cell + gap);
    return `<rect class="h-cell" ${delay(0.5 + c.week * 0.03 + c.day * 0.02)} x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3.5" fill="${ramp[lv]}"${empty ? ' fill-opacity=".45"' : ""}/>`;
  }).join("");
  const { current } = streaks(ctx.data.calendar, ctx.now);
  const caption = empty ? "Your first contribution lights this up" : `${compact(total)} ${plural(total, "contribution")}${current > 1 ? ` \xB7 ${current}-day streak` : ""}`;
  const right = x0 + gw;
  const squaresEnd = right - textWidth("more", 11, { mono: true }) - 7;
  const squaresStart = squaresEnd - (5 * 11 + 4 * 3);
  const legend2 = ramp.map((c, i) => `<rect x="${n(squaresStart + i * 14, 2)}" y="${y0 - 31}" width="11" height="11" rx="2.5" fill="${c}"/>`).join("");
  return `<g class="fade" ${delay(0.35)}>${label(x0, y0 - 21, `Last ${weeks} weeks`, p)}<text x="${n(squaresStart - 7, 2)}" y="${y0 - 21.5}" text-anchor="end" class="mono" font-size="11" fill="${p.muted}">less</text>${legend2}<text x="${right}" y="${y0 - 21.5}" text-anchor="end" class="mono" font-size="11" fill="${p.muted}">more</text></g>` + rects + `<text class="mono fade" ${delay(0.9)} x="${x0}" y="${y0 + gh + 30}" font-size="13" fill="${p.muted}">${esc(caption)}</text>`;
}
var TOKENS = ["accentA", "accentB", "success", "text", "muted"];
function statusColorOf(value, p) {
  if (!value) return p.success;
  const v = value.trim();
  if (/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return v.startsWith("#") ? v : `#${v}`;
  const token = TOKENS.find((t) => t.toLowerCase() === v.toLowerCase());
  return token ? p[token] : p.success;
}
var card4 = {
  id: "hero",
  title: "Hero banner",
  description: "An animated banner: status line, gradient name, role, tagline, tech chips and a code editor that types out a snippet about you in your top language.",
  options: [
    { key: "name", type: "string", default: "profile name or login", description: "Big gradient headline." },
    { key: "role", type: "string", default: 'first sentence of your bio, or "Developer"', description: "Line under the name." },
    { key: "tagline", type: "list", default: "rest of your bio, company and location", description: "One string (wrapped to two lines) or a list of up to two lines." },
    { key: "chips", type: "list", default: "top languages", description: "Small pills under the tagline; known technologies get their logo." },
    { key: "status", type: "string", default: '"open to collaboration \xB7 <location>"', description: 'Status line with a pulsing dot; "none" hides it.' },
    { key: "statusColor", type: "string", default: "palette success", description: "Dot colour: hex (#3FB950) or a palette token (accentA, accentB, success)." },
    { key: "code", type: "string", default: "auto", description: '"auto" writes a snippet from your profile, "none" hides the editor, any other text is shown as code (max 9 lines).' },
    { key: "codeLanguage", type: "string", default: "top language", description: `Highlighting and snippet language: ${CODE_LANGUAGES.join(", ")}.` },
    { key: "codeFile", type: "string", default: "per language (Program.cs, profile.ts, me.py\u2026)", description: "File name in the editor title bar." }
  ],
  render(ctx) {
    const p = ctx.palette;
    const o = readOptions(ctx.options);
    const codeOpt = o.string("code", "auto");
    const showCode = !/^(none|false|off|hide)$/i.test(codeOpt.trim());
    const colW = showCode ? CODE_COL_W : 740 - X0;
    const c = content(ctx, colW);
    const langOpt = o.optionalString("codeLanguage");
    const lang = langOpt && langOpt.toLowerCase() !== "auto" && codeLanguageOf(langOpt) || detectLanguage(ctx.data);
    const file = o.string("codeFile", FILES[lang]);
    const lines = !showCode ? [] : codeOpt.trim().toLowerCase() === "auto" ? autoCode(factsFrom(ctx.data, c.name, ctx.now, c.copy), lang, MAX_CODE_CHARS) : customCode(codeOpt, MAX_CODE_CHARS);
    const statusColor = statusColorOf(o.optionalString("statusColor"), p);
    const defs = linearGradient("h-accent", p.accentA, p.accentB) + `<radialGradient id="h-orbA"><stop offset="0" stop-color="${p.accentA}" stop-opacity="${n(p.glowOpacity, 3)}"/><stop offset="1" stop-color="${p.accentA}" stop-opacity="0"/></radialGradient><radialGradient id="h-orbB"><stop offset="0" stop-color="${p.accentB}" stop-opacity="${n(p.glowOpacity, 3)}"/><stop offset="1" stop-color="${p.accentB}" stop-opacity="0"/></radialGradient><pattern id="h-grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="${p.grid}" stroke-opacity="${n(p.gridOpacity, 3)}"/></pattern><radialGradient id="h-fade" cx="0.3" cy="0.35" r="0.85"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient><mask id="h-mask"><rect width="${W2}" height="${H}" fill="url(#h-fade)"/></mask>`;
    const style = ".h-orbA{animation:h-driftA 16s ease-in-out infinite alternate}.h-orbB{animation:h-driftB 19s ease-in-out infinite alternate}@keyframes h-driftA{to{transform:translate(140px,50px)}}@keyframes h-driftB{to{transform:translate(-160px,-40px)}}.h-scan{opacity:.5;animation:h-scan 6s ease-in-out infinite}@keyframes h-scan{0%,100%{opacity:0}50%{opacity:.9}}.h-pulse{animation:h-pulse 2.4s ease-in-out infinite}@keyframes h-pulse{50%{opacity:.35}}.h-ring{opacity:0;transform-box:fill-box;transform-origin:center;animation:h-ring 2.4s ease-out infinite}@keyframes h-ring{0%{opacity:.6;transform:scale(1)}100%{opacity:0;transform:scale(2.8)}}.h-type{animation:h-type .5s steps(20,end) backwards}@keyframes h-type{from{clip-path:inset(0 100% 0 0)}}.h-code{font-variant-ligatures:none;white-space:pre}.h-cur{animation:h-blink 1.1s steps(1) infinite}@keyframes h-blink{50%{fill-opacity:0}}.h-cell{transform-box:fill-box;transform-origin:center;animation:h-cell .45s ease-out backwards}@keyframes h-cell{from{opacity:0;transform:scale(.3)}}";
    const background = `<g clip-path="url(#ps-clip)"><rect width="${W2}" height="${H}" fill="${p.bg}"/><rect width="${W2}" height="${H}" fill="url(#h-grid)" mask="url(#h-mask)"/><circle class="h-orbA" cx="180" cy="40" r="320" fill="url(#h-orbA)"/><circle class="h-orbB" cx="1060" cy="380" r="340" fill="url(#h-orbB)"/><rect class="h-scan" width="${W2}" height="2" fill="url(#h-accent)"/></g>`;
    const body = background + textColumn(c, colW, ctx, statusColor) + (showCode ? codePanel(lines.length ? lines : ["// hello, world"], lang, file, ctx) : activity(ctx));
    const title = `${c.name} \u2014 ${c.role}`;
    return [
      {
        name: "hero",
        alt: title,
        layout: "full",
        svg: shell({
          width: W2,
          height: H,
          palette: p,
          title,
          desc: [c.status, ...c.tagline].filter(Boolean).join(" "),
          defs,
          style,
          body,
          background: false,
          radius: 20,
          animate: ctx.animate
        })
      }
    ];
  }
};

// src/cards/repos.ts
var NO_DESCRIPTION = "No description provided.";
var SAFE = 0.95;
function readSettings(ctx) {
  const o = readOptions(ctx.options);
  const layout2 = o.string("layout", "compact").trim().toLowerCase() === "detail" ? "detail" : "compact";
  return {
    layout: layout2,
    count: Math.floor(o.number("count", 4, { min: 1, max: 12 })),
    showOwner: o.has("showOwner") ? o.boolean("showOwner", false) : layout2 === "detail" ? true : null,
    descriptionLines: Math.floor(o.number("descriptionLines", layout2 === "detail" ? 2 : 3, { min: 1, max: 4 })),
    title: o.optionalString("title")?.replace(/\s+/g, " ").trim()
  };
}
function repoSlug(nameWithOwner) {
  return nameWithOwner.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function selectRepos(data, limit) {
  const extra = data.extraRepos ?? [];
  const profileRepo = `${data.login}/${data.login}`.toLowerCase();
  const eligible = (r) => !r.isPrivate && r.nameWithOwner.toLowerCase() !== profileRepo;
  const ranked = (data.repos ?? []).filter((r) => eligible(r) && !r.isArchived).sort((a, b) => b.stars - a.stars || (b.pushedAt > a.pushedAt ? 1 : b.pushedAt < a.pushedAt ? -1 : 0));
  const source = extra.length ? extra : [...(data.pinned ?? []).filter(eligible), ...ranked];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const repo of source) {
    const slug = repoSlug(repo.nameWithOwner);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(repo);
    if (out.length >= limit) break;
  }
  return out;
}
var validDate = (iso) => !!iso && Number.isFinite(Date.parse(iso));
var clean = (s) => (s ?? "").replace(/\s+/g, " ").trim();
var dataColor = (c, p) => ensureContrast(safeColor(c, p.faint), p.panel, 1.8, p.text);
var norm = (s) => s.toLowerCase().replace(/#/g, "sharp").replace(/\+/g, "p").replace(/[^a-z0-9]/g, "");
function primaryLanguage(repo) {
  if (repo.primaryLanguage?.name) return repo.primaryLanguage;
  const first = repo.languages?.[0];
  return first?.name ? { name: first.name, color: first.color } : null;
}
function categoryLabel(repo, maxWidth, maxParts = 2) {
  const lang = primaryLanguage(repo)?.name;
  const candidates = [];
  if (lang) candidates.push(displayName(lang));
  const langKey = lang ? norm(lang) : "";
  const shortKey = lang ? norm(displayName(lang)) : "";
  for (const topic of repo.topics ?? []) {
    const key = norm(topic);
    if (!key || key === langKey || key === shortKey || key === `${langKey}lang` || candidates.some((c) => norm(c) === key)) continue;
    candidates.push(topic);
  }
  if (!candidates.length) return "REPOSITORY";
  const parts2 = [];
  for (const c of candidates) {
    if (parts2.length >= maxParts) break;
    const next = [...parts2, c].join(" \xB7 ").toUpperCase();
    if (parts2.length && labelWidth(next) > maxWidth) break;
    parts2.push(c);
  }
  return fitLabel(parts2.join(" \xB7 ").toUpperCase(), maxWidth);
}
function ownerShown(repo, data, s) {
  const foreign = repo.owner.toLowerCase() !== (data.login ?? "").toLowerCase();
  return s.showOwner === null ? foreign : s.showOwner || foreign;
}
function titleText(repo, showOwner, maxWidth, size, weight, p, sep2) {
  const nameOpts = { weight };
  if (!showOwner) return `<tspan fill="${p.text}">${esc(fit(repo.name, maxWidth, size, nameOpts))}</tspan>`;
  const ownerOpts = { weight: 500 };
  let owner = repo.owner;
  const sepW = textWidth(sep2, size, ownerOpts);
  if (textWidth(owner, size, ownerOpts) + sepW > maxWidth * 0.45) owner = fit(owner, maxWidth * 0.45 - sepW, size, ownerOpts);
  const ownerW = textWidth(owner, size, ownerOpts) + sepW;
  const name = fit(repo.name, maxWidth - ownerW, size, nameOpts);
  return `<tspan fill="${p.muted}" font-weight="500">${esc(owner)}</tspan><tspan fill="${p.faint}" font-weight="400">${esc(sep2)}</tspan><tspan fill="${p.text}">${esc(name)}</tspan>`;
}
function starPoints(outer, inner) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? inner : outer;
    const a = -Math.PI / 2 + i * Math.PI / 5;
    pts.push(`${n(Math.cos(a) * r, 2)} ${n(Math.sin(a) * r + 0.6, 2)}`);
  }
  return `M${pts.join("L")}Z`;
}
var STAR = starPoints(7.2, 3.1);
function iconBody(name, color) {
  switch (name) {
    case "star":
      return `<path d="${STAR}"/>`;
    case "fork":
      return '<circle cx="-4" cy="-4.6" r="1.9"/><circle cx="4" cy="-4.6" r="1.9"/><circle cx="0" cy="4.8" r="1.9"/><path d="M-4-2.7V-1.4Q-4 .6-2 .6H2Q4 .6 4-1.4V-2.7M0 .6V2.9"/>';
    case "issue":
      return `<circle r="6.6"/><circle r="1.7" fill="${color}" stroke="none"/>`;
    case "pr":
      return '<circle cx="-4" cy="-4.8" r="1.9"/><circle cx="-4" cy="4.8" r="1.9"/><circle cx="4" cy="4.8" r="1.9"/><path d="M-4-2.9V2.9M4 2.9V-1.6Q4-4.6 1-4.6H-.6M1.4-6.6-.6-4.6 1.4-2.6"/>';
    case "eye":
      return `<path d="M-7.2 0Q0-8.4 7.2 0Q0 8.4-7.2 0Z"/><circle r="2.3" fill="${color}" stroke="none"/>`;
    case "tag":
      return `<path d="M-6.6-6.6H-.9L6.2.5Q7 1.3 6.2 2.1L2.1 6.2Q1.3 7 .5 6.2L-6.6-.9Z"/><circle cx="-3.4" cy="-3.4" r="1.2" fill="${color}" stroke="none"/>`;
    case "clock":
      return '<circle r="6.6"/><path d="M0-3.6V0L2.6 1.8"/>';
    case "law":
      return '<path d="M0-6.6V6.4M-3.8 6.4H3.8M-6.2-4.4H6.2M-6.2-4.4-8 .6Q-6.2 2.4-4.4 .6ZM6.2-4.4 4.4.6Q6.2 2.4 8 .6Z"/>';
    case "globe":
      return '<circle r="6.6"/><ellipse rx="2.8" ry="6.6"/><path d="M-6.6 0H6.6"/>';
    case "book":
      return '<path d="M-5.6 5V-5.2Q-5.6-6.8-4-6.8H5.6V3.4H-4Q-5.6 3.4-5.6 5Q-5.6 6.6-4 6.6H5.6M-2.6-3.6H2.6"/>';
  }
}
function icon(name, x, y, color, scale = 1, strokeWidth = 1.5) {
  const t = scale === 1 ? `translate(${n(x)} ${n(y)})` : `translate(${n(x)} ${n(y)}) scale(${n(scale, 3)})`;
  return `<g transform="${t}" fill="none" stroke="${color}" stroke-width="${n(strokeWidth, 2)}" stroke-linecap="round" stroke-linejoin="round">${iconBody(name, color)}</g>`;
}
var STYLE2 = ".rp-bar{transform-box:fill-box;transform-origin:left;animation:rp-grow 1.1s cubic-bezier(.2,.7,.2,1) backwards}@keyframes rp-grow{from{transform:scaleX(0)}}";
function accentBar(W5) {
  return `<g clip-path="url(#ps-clip)"><rect class="rp-bar" width="${W5}" height="3" fill="url(#rp-accent)"/></g>`;
}
function chip(x, y, w, h, p, inner) {
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${h}" rx="${n(h / 2)}" fill="${p.chipBg}" stroke="${p.border}"/>${inner}`;
}
function badgeOf(repo) {
  const tag = clean(repo.latestRelease?.tag);
  if (tag) return { text: tag, release: true };
  if (repo.isArchived) return { text: "Archived", release: false };
  if (repo.isTemplate) return { text: "Template", release: false };
  if (repo.isFork) return { text: "Fork", release: false };
  return null;
}
function describe(repo) {
  const bits = [`${compact(repo.stars)} stars`, `${compact(repo.forks)} forks`];
  const lang = primaryLanguage(repo);
  if (lang) bits.unshift(`written in ${lang.name}`);
  const desc = clean(repo.description);
  return `${desc ? `${desc} ` : ""}(${bits.join(", ")})`;
}
function compactCard(ctx, repo, s) {
  const p = ctx.palette;
  const W5 = 400;
  const P = 24;
  const lines = s.descriptionLines;
  const descTop = 104;
  const lh = 21;
  const divY = descTop + (lines - 1) * lh + 18;
  const H3 = divY + 36;
  const out = [];
  const badge = badgeOf(repo);
  let badgeW = 0;
  let badgeSvg = "";
  if (badge) {
    const iconW = badge.release ? 15 : 0;
    const text = fit(badge.text, 120, 11, { mono: true });
    badgeW = textWidth(text, 11, { mono: true }) + 20 + iconW;
    const bx = W5 - P - badgeW;
    const tagColor = badge.release ? p.accentB : p.muted;
    badgeSvg = chip(
      bx,
      25,
      badgeW,
      22,
      p,
      (badge.release ? icon("tag", bx + 15, 36, tagColor, 0.62, 2) : "") + `<text x="${n(bx + 10 + iconW)}" y="40" class="mono" font-size="11" fill="${badge.release ? p.text : p.muted}">${esc(text)}</text>`
    );
  }
  const labelMax = W5 - 2 * P - (badgeW ? badgeW + 14 : 0);
  const category = s.title ? fitLabel(s.title.toUpperCase(), labelMax) : categoryLabel(repo, labelMax);
  out.push(`<g class="fade">${label(P, 40, category, p)}${badgeSvg}</g>`);
  const title = titleText(repo, ownerShown(repo, ctx.data, s), (W5 - 2 * P) * SAFE, 20, 700, p, "/");
  out.push(
    `<text class="sans up" ${delay(0.05)} x="${P}" y="72" font-size="20" font-weight="700" letter-spacing="-.3">${title}</text>`
  );
  const desc = clean(repo.description);
  if (desc) {
    const rows = wrapPx(desc, (W5 - 2 * P) * SAFE, 13.5, {}, lines);
    out.push(
      `<g class="up" ${delay(0.12)}>` + rows.map(
        (row, i) => `<text x="${P}" y="${descTop + i * lh}" class="sans" font-size="13.5" fill="${p.muted}">${esc(row)}</text>`
      ).join("") + "</g>"
    );
  } else {
    out.push(
      `<text class="sans up" ${delay(0.12)} x="${P}" y="${descTop}" font-size="13.5" font-style="italic" fill="${p.faint}">${NO_DESCRIPTION}</text>`
    );
  }
  const cy = divY + 18;
  const base = divY + 22.5;
  const mono = { mono: true };
  const foot = [`<line x1="${P}" y1="${divY}" x2="${W5 - P}" y2="${divY}" stroke="${p.border}"/>`];
  let x = P;
  const lang = primaryLanguage(repo);
  if (lang) {
    const name = fit(displayName(lang.name), 118, 12.5, mono);
    foot.push(
      `<circle cx="${x + 6}" cy="${cy}" r="5.5" fill="${dataColor(lang.color, p)}"/><text x="${x + 18}" y="${n(base)}" class="mono" font-size="12.5" fill="${p.text}">${esc(name)}</text>`
    );
    x += 18 + textWidth(name, 12.5, mono) + 18;
  }
  for (const [kind, value] of [
    ["star", repo.stars],
    ["fork", repo.forks]
  ]) {
    const v = compact(Math.max(0, value || 0));
    foot.push(
      icon(kind, x + 6, cy, p.muted, 0.82, 1.6) + `<text x="${n(x + 17)}" y="${n(base)}" class="mono" font-size="12.5" fill="${p.muted}">${esc(v)}</text>`
    );
    x += 17 + textWidth(v, 12.5, mono) + 16;
  }
  if (validDate(repo.pushedAt)) {
    const ago = relativeTime(repo.pushedAt, ctx.now);
    const agoW = textWidth(ago, 12, mono);
    if (x + agoW + 18 <= W5 - P) {
      foot.push(
        icon("clock", W5 - P - agoW - 10, cy, p.muted, 0.72, 1.7) + `<text x="${W5 - P}" y="${n(base)}" text-anchor="end" class="mono" font-size="12" fill="${p.muted}">${esc(ago)}</text>`
      );
    }
  }
  out.push(`<g class="fade" ${delay(0.2)}>${foot.join("")}</g>`);
  return shell({
    width: W5,
    height: H3,
    palette: p,
    title: `${repo.nameWithOwner} repository`,
    desc: describe(repo),
    radius: 16,
    defs: linearGradient("rp-accent", p.accentA, p.accentB),
    style: STYLE2,
    glow: { cx: 0, cy: 0, r: 1, color: p.accentA, opacity: p.glowOpacity * 0.45 },
    body: accentBar(W5) + out.join(""),
    animate: ctx.animate
  });
}
function languageSlices(repo, p) {
  let langs2 = (repo.languages ?? []).filter((l) => l.name && Number.isFinite(l.value) && l.value > 0);
  if (!langs2.length) {
    const primary = primaryLanguage(repo);
    if (!primary) return [];
    langs2 = [{ name: primary.name, color: primary.color, value: 1 }];
  }
  const sorted = [...langs2].sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, 5).map((l) => ({ name: l.name, color: dataColor(l.color, p), value: l.value }));
  const rest = sorted.slice(5).reduce((sum, l) => sum + l.value, 0);
  if (rest > 0) top.push({ name: "Other", color: otherColor(p, top.map((l) => l.color)), value: rest });
  return top;
}
function detailCard(ctx, repo, s) {
  const p = ctx.palette;
  const W5 = 1200;
  const P = 40;
  const CW = W5 - 2 * P;
  const mono = { mono: true };
  const out = [];
  const flags = [
    repo.isArchived && "Archived",
    repo.isTemplate && "Template",
    repo.isFork && "Fork",
    repo.isPrivate && "Private"
  ].filter((f) => !!f);
  let right = W5 - P;
  const chips2 = [];
  for (const f of [...flags].reverse()) {
    const w = textWidth(f, 12, mono) + 26;
    right -= w;
    chips2.push(
      chip(right, 39, w, 26, p, `<text x="${n(right + w / 2)}" y="56.5" text-anchor="middle" class="mono" font-size="12" fill="${p.muted}">${f}</text>`)
    );
    right -= 8;
  }
  const labelMax = right - P - 24;
  const category = s.title ? fitLabel(s.title.toUpperCase(), labelMax) : categoryLabel(repo, labelMax, 3);
  out.push(`<g class="fade">${label(P, 58, category, p)}${chips2.join("")}</g>`);
  const title = titleText(repo, ownerShown(repo, ctx.data, s), CW * SAFE, 40, 800, p, " / ");
  out.push(
    `<text class="sans up" ${delay(0.05)} x="${P}" y="114" font-size="40" font-weight="800" letter-spacing="-1">${title}</text>`
  );
  const descY = 156;
  const descLh = 28;
  const desc = clean(repo.description);
  const rows = desc ? wrapPx(desc, CW * SAFE, 18, {}, s.descriptionLines) : [];
  if (rows.length) {
    out.push(
      `<g class="up" ${delay(0.12)}>` + rows.map((row, i) => `<text x="${P}" y="${descY + i * descLh}" class="sans" font-size="18" fill="${p.muted}">${esc(row)}</text>`).join("") + "</g>"
    );
  } else {
    out.push(
      `<text class="sans up" ${delay(0.12)} x="${P}" y="${descY}" font-size="18" font-style="italic" fill="${p.faint}">${NO_DESCRIPTION}</text>`
    );
  }
  let y = descY + (Math.max(1, rows.length) - 1) * descLh;
  y += 44;
  const meta = [];
  const tag = clean(repo.latestRelease?.tag);
  if (tag) {
    const t = fit(tag, 220, 13, mono);
    const when = validDate(repo.latestRelease?.publishedAt) ? ` \xB7 ${shortDate(repo.latestRelease.publishedAt)}` : "";
    meta.push({
      icon: "tag",
      color: p.accentB,
      spans: `<tspan fill="${p.text}" font-weight="600">${esc(t)}</tspan><tspan fill="${p.muted}">${esc(when)}</tspan>`,
      width: textWidth(t + when, 13, mono)
    });
  }
  if (validDate(repo.pushedAt)) {
    const t = `updated ${relativeTime(repo.pushedAt, ctx.now)}`;
    meta.push({ icon: "clock", color: p.muted, spans: `<tspan fill="${p.muted}">${esc(t)}</tspan>`, width: textWidth(t, 13, mono) });
  }
  const license = clean(repo.license);
  if (license) {
    const t = fit(`${license} license`, 220, 13, mono);
    meta.push({ icon: "law", color: p.muted, spans: `<tspan fill="${p.muted}">${esc(t)}</tspan>`, width: textWidth(t, 13, mono) });
  }
  const homepage = clean(repo.homepageUrl);
  const home = /^https?:\/\/[^\s/]/i.test(homepage) ? homepage.replace(/^https?:\/\/(www\.)?/i, "").replace(/[?#].*$/, "").replace(/\/+$/, "") : "";
  if (home) {
    const t = fit(home, 260, 13, mono);
    const color = ensureContrast(p.accentB, p.panel, 3.5, p.text);
    meta.push({ icon: "globe", color, spans: `<tspan fill="${color}">${esc(t)}</tspan>`, width: textWidth(t, 13, mono) });
  }
  let mx = P;
  const metaSvg = [];
  for (const m of meta) {
    if (mx + 22 + m.width > W5 - P) break;
    metaSvg.push(icon(m.icon, mx + 8, y - 4.5, m.color, 0.95) + `<text x="${n(mx + 22)}" y="${y}" class="mono" font-size="13">${m.spans}</text>`);
    mx += 22 + m.width + 30;
  }
  if (metaSvg.length) out.push(`<g class="fade" ${delay(0.18)}>${metaSvg.join("")}</g>`);
  else y -= 30;
  y += 30;
  const stats = [
    ["star", "Stars", repo.stars],
    ["fork", "Forks", repo.forks],
    ["issue", "Open issues", repo.openIssues],
    ["pr", "Open PRs", repo.openPullRequests],
    ["eye", "Watchers", repo.watchers]
  ];
  const gap = 16;
  const tileW = (CW - gap * (stats.length - 1)) / stats.length;
  const tileH = 92;
  stats.forEach(([kind, name, value], i) => {
    const tx = P + i * (tileW + gap);
    const v = compact(Math.max(0, value || 0));
    out.push(
      `<g class="up" ${delay(0.22 + i * 0.06)}><rect x="${n(tx)}" y="${y}" width="${n(tileW)}" height="${tileH}" rx="14" fill="${p.panelAlt}" stroke="${p.border}"/>` + icon(kind, tx + 28, y + 30, p.accentB, 1, 1.5) + `<text x="${n(tx + 46)}" y="${y + 34.5}" class="mono" font-size="12" letter-spacing="1" fill="${p.muted}">${esc(name.toUpperCase())}</text><text x="${n(tx + 20)}" y="${y + 74}" class="sans" font-size="30" font-weight="800" letter-spacing="-.8" fill="${p.text}">${esc(v)}</text></g>`
    );
  });
  y += tileH;
  const slices = languageSlices(repo, p);
  let defs = linearGradient("rp-accent", p.accentA, p.accentB);
  if (slices.length) {
    y += 48;
    const total = slices.reduce((sum, l) => sum + l.value, 0) || 1;
    const barY = y + 16;
    const barH = 10;
    out.push(
      `<text x="${P}" y="${y}" class="mono" font-size="12" letter-spacing="1.2" fill="${p.muted}">LANGUAGES</text><rect x="${P}" y="${barY}" width="${CW}" height="${barH}" rx="${barH / 2}" fill="${p.empty}"/>`
    );
    defs += `<clipPath id="rp-lang"><rect x="${P}" y="${barY}" width="${CW}" height="${barH}" rx="${barH / 2}"/></clipPath>`;
    let bx = P;
    const segs = slices.map((l, i) => {
      const w = l.value / total * CW;
      const seg = `<rect class="rp-bar" ${delay(0.3 + i * 0.08)} x="${n(bx)}" y="${barY}" width="${n(Math.max(1.5, w - (i < slices.length - 1 ? 3 : 0)))}" height="${barH}" fill="${l.color}"/>`;
      bx += w;
      return seg;
    });
    out.push(`<g clip-path="url(#rp-lang)">${segs.join("")}</g>`);
    let lx = P;
    let ly = barY + barH + 32;
    const legend2 = [];
    for (const l of slices) {
      const name = fit(l.name, 220, 14, { weight: 600 });
      const pct = percent(l.value / total);
      const w = 18 + textWidth(name, 14, { weight: 600 }) + 8 + textWidth(pct, 13, mono);
      if (lx > P && lx + w > W5 - P) {
        lx = P;
        ly += 28;
      }
      legend2.push(
        `<circle cx="${n(lx + 5)}" cy="${ly - 5}" r="5" fill="${l.color}"/><text x="${n(lx + 18)}" y="${ly}"><tspan class="sans" font-size="14" font-weight="600" fill="${p.text}">${esc(name)}</tspan><tspan dx="8" class="mono" font-size="13" fill="${p.muted}">${pct}</tspan></text>`
      );
      lx += w + 32;
    }
    out.push(`<g class="fade" ${delay(0.4)}>${legend2.join("")}</g>`);
    y = ly;
  }
  const topics = (repo.topics ?? []).map(clean).filter(Boolean);
  if (topics.length) {
    y += 46;
    out.push(`<text x="${P}" y="${y}" class="mono" font-size="12" letter-spacing="1.2" fill="${p.muted}">TOPICS</text>`);
    const chipY = y + 14;
    const chipH = 28;
    const chipGap = 8;
    const chipFill = mix(p.panel, p.accentB, 0.1);
    const chipStroke = mix(p.panel, p.accentB, 0.28);
    const chipText = ensureContrast(p.accentB, chipFill, 4.5, p.text);
    const widths = topics.map((t) => {
      const text = fit(t, 300, 12.5, mono);
      return { text, w: textWidth(text, 12.5, mono) + 26 };
    });
    const moreW = (k) => textWidth(`+${k}`, 12.5, mono) + 26;
    let cx = P;
    let shown = 0;
    for (let i = 0; i < widths.length; i++) {
      const item = widths[i];
      if (!item) break;
      const remaining = widths.length - i - 1;
      const reserve = remaining > 0 ? chipGap + moreW(remaining) : 0;
      if (cx + item.w + reserve > W5 - P) break;
      out.push(
        `<g class="fade" ${delay(0.45 + i * 0.04)}><rect x="${n(cx)}" y="${chipY}" width="${n(item.w)}" height="${chipH}" rx="${chipH / 2}" fill="${chipFill}" stroke="${chipStroke}"/><text x="${n(cx + item.w / 2)}" y="${chipY + 18.5}" text-anchor="middle" class="mono" font-size="12.5" fill="${chipText}">${esc(item.text)}</text></g>`
      );
      cx += item.w + chipGap;
      shown++;
    }
    const hidden = widths.length - shown;
    if (hidden > 0) {
      const w = moreW(hidden);
      out.push(
        `<g class="fade" ${delay(0.45 + shown * 0.04)}>` + chip(cx, chipY, w, chipH, p, `<text x="${n(cx + w / 2)}" y="${chipY + 18.5}" text-anchor="middle" class="mono" font-size="12.5" fill="${p.muted}">+${hidden}</text>`) + "</g>"
      );
    }
    y = chipY + chipH;
  }
  const H3 = Math.ceil(y + 40);
  return shell({
    width: W5,
    height: H3,
    palette: p,
    title: `${repo.nameWithOwner} repository`,
    desc: describe(repo),
    radius: 20,
    defs,
    style: STYLE2,
    glow: { cx: 1, cy: 0, r: 0.8, color: p.accentB, opacity: p.glowOpacity * 0.3 },
    body: accentBar(W5) + out.join(""),
    animate: ctx.animate
  });
}
function placeholder(ctx, s) {
  const p = ctx.palette;
  const detail = s.layout === "detail";
  const W5 = detail ? 1200 : 400;
  const P = detail ? 40 : 24;
  const skeleton = mix(p.panel, p.faint, 0.18);
  const heading = "No repositories yet";
  const message = "Pin a repository on your profile or list some in the repos setting and they will appear here.";
  const out = [];
  let H3;
  if (!detail) {
    H3 = 200;
    out.push(`<g class="fade">${label(P, 40, s.title ? fitLabel(s.title.toUpperCase(), W5 - 2 * P) : "Repositories", p)}</g>`);
    out.push(
      `<g class="up" ${delay(0.05)}><circle cx="${P + 24}" cy="96" r="24" fill="${p.chipBg}" stroke="${p.border}"/>${icon("book", P + 24, 96, p.accentB, 1.3, 1.5)}</g>`
    );
    const tx = P + 64;
    const rows = wrapPx(message, (W5 - P - tx) * SAFE, 13, {}, 3);
    out.push(
      `<g class="up" ${delay(0.12)}><text x="${tx}" y="82" class="sans" font-size="17" font-weight="700" letter-spacing="-.2" fill="${p.text}">${heading}</text>` + rows.map((r, i) => `<text x="${tx}" y="${104 + i * 19}" class="sans" font-size="13" fill="${p.muted}">${esc(r)}</text>`).join("") + "</g>"
    );
    out.push(
      `<g class="fade" ${delay(0.2)}><line x1="${P}" y1="164" x2="${W5 - P}" y2="164" stroke="${p.border}"/><circle cx="${P + 6}" cy="182" r="5.5" fill="${skeleton}"/><rect x="${P + 18}" y="177" width="64" height="10" rx="5" fill="${skeleton}"/><rect x="${P + 100}" y="177" width="36" height="10" rx="5" fill="${skeleton}"/><rect x="${P + 152}" y="177" width="28" height="10" rx="5" fill="${skeleton}"/></g>`
    );
  } else {
    out.push(`<g class="fade">${label(P, 58, s.title ? fitLabel(s.title.toUpperCase(), W5 - 2 * P) : "Repository", p)}</g>`);
    out.push(
      `<g class="up" ${delay(0.05)}><circle cx="${P + 32}" cy="122" r="32" fill="${p.chipBg}" stroke="${p.border}"/>${icon("book", P + 32, 122, p.accentB, 1.8, 1.4)}</g>`
    );
    out.push(
      `<g class="up" ${delay(0.12)}><text x="${P + 88}" y="116" class="sans" font-size="28" font-weight="800" letter-spacing="-.6" fill="${p.text}">${heading}</text><text x="${P + 88}" y="146" class="sans" font-size="16" fill="${p.muted}">${esc(message)}</text></g>`
    );
    const gap = 16;
    const tileW = (W5 - 2 * P - gap * 4) / 5;
    const tiles2 = [];
    for (let i = 0; i < 5; i++) {
      const tx = P + i * (tileW + gap);
      tiles2.push(
        `<rect x="${n(tx)}" y="190" width="${n(tileW)}" height="64" rx="14" fill="${p.panelAlt}" stroke="${p.border}"/><rect x="${n(tx + 20)}" y="210" width="${n(tileW * 0.32)}" height="8" rx="4" fill="${skeleton}"/><rect x="${n(tx + 20)}" y="228" width="${n(tileW * 0.5)}" height="12" rx="6" fill="${skeleton}"/>`
      );
    }
    out.push(`<g class="fade" ${delay(0.2)}>${tiles2.join("")}</g>`);
    H3 = 294;
  }
  const svg = shell({
    width: W5,
    height: H3,
    palette: p,
    title: "Repositories",
    desc: heading,
    radius: detail ? 20 : 16,
    defs: linearGradient("rp-accent", p.accentA, p.accentB),
    style: STYLE2,
    glow: detail ? { cx: 1, cy: 0, r: 0.8, color: p.accentB, opacity: p.glowOpacity * 0.3 } : { cx: 0, cy: 0, r: 1, color: p.accentA, opacity: p.glowOpacity * 0.45 },
    body: accentBar(W5) + out.join(""),
    animate: ctx.animate
  });
  return { name: "repos", alt: `Repositories: ${heading.toLowerCase()}`, svg, layout: detail ? "full" : "half" };
}
var card5 = {
  id: "repos",
  title: "Repo cards",
  description: "One card per repository: pinned or configured repos (else your most starred), as compact half-width tiles for your profile or a detailed full-width card for a project README.",
  options: [
    { key: "layout", type: "string", default: "compact", description: '"compact" (400px half-width tiles) or "detail" (1200px card for a project README).' },
    { key: "count", type: "number", default: 4, description: "How many repositories to render (1-12)." },
    {
      key: "showOwner",
      type: "boolean",
      description: 'Prefix the name with "owner/". Defaults to true for detail; compact shows it only for repos you do not own.'
    },
    { key: "descriptionLines", type: "number", description: "Maximum description lines (1-4). Defaults to 3 for compact, 2 for detail." },
    { key: "title", type: "string", description: 'Replaces the category label (default: primary language and topics, e.g. "TYPESCRIPT \xB7 REACT").' }
  ],
  render(ctx) {
    const s = readSettings(ctx);
    const repos = selectRepos(ctx.data, s.count);
    if (!repos.length) return [placeholder(ctx, s)];
    return repos.map((repo) => {
      const desc = clean(repo.description);
      return {
        name: `repo-${repoSlug(repo.nameWithOwner) || "unnamed"}`,
        alt: desc ? `${repo.name}: ${desc}` : repo.name,
        svg: s.layout === "detail" ? detailCard(ctx, repo, s) : compactCard(ctx, repo, s),
        link: repo.url,
        layout: s.layout === "detail" ? "full" : "half"
      };
    });
  }
};

// src/cards/socials.ts
var strip = (h) => h.replace(/^@+/, "");
var PLATFORMS = {
  github: { label: "GitHub", icon: "github", url: (h) => `https://github.com/${h}`, hosts: ["github.com"] },
  linkedin: {
    label: "LinkedIn",
    icon: "linkedin",
    url: (h) => `https://www.linkedin.com/${/^(in|company|school|pub)\//.test(h) ? h : `in/${h}`}`,
    hosts: ["linkedin.com"]
  },
  x: { label: "X", icon: "x", url: (h) => `https://x.com/${h}`, hosts: ["x.com", "twitter.com"] },
  website: { label: "Website", icon: "website", url: (h) => `https://${h}`, hosts: [] },
  email: { label: "Email", icon: "email", url: (h) => `mailto:${h}`, hosts: [] },
  mastodon: {
    label: "Mastodon",
    icon: "mastodon",
    keepAt: true,
    url: (h) => {
      const [user = "", server = ""] = strip(h).split("@");
      const host = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(server) ? server : "mastodon.social";
      return `https://${host}/@${encodeURIComponent(user)}`;
    },
    hosts: ["mastodon.social"]
  },
  bluesky: { label: "Bluesky", icon: "bluesky", url: (h) => `https://bsky.app/profile/${h}`, hosts: ["bsky.app"] },
  youtube: {
    label: "YouTube",
    icon: "youtube",
    url: (h) => `https://www.youtube.com/${/^(channel|c|user)\//.test(h) ? h : `@${h}`}`,
    hosts: ["youtube.com", "youtu.be"]
  },
  devto: { label: "DEV", icon: "devdotto", url: (h) => `https://dev.to/${h}`, hosts: ["dev.to"] },
  medium: { label: "Medium", icon: "medium", url: (h) => `https://medium.com/@${h}`, hosts: ["medium.com"] },
  stackoverflow: {
    label: "Stack Overflow",
    icon: "stackoverflow",
    url: (h) => `https://stackoverflow.com/users/${h}`,
    hosts: ["stackoverflow.com"]
  },
  discord: {
    label: "Discord",
    icon: "discord",
    url: (h) => `https://discord.gg/${h}`,
    hosts: ["discord.gg", "discord.com"]
  },
  instagram: { label: "Instagram", icon: "instagram", url: (h) => `https://www.instagram.com/${h}`, hosts: ["instagram.com"] },
  threads: { label: "Threads", icon: "threads", url: (h) => `https://www.threads.net/@${h}`, hosts: ["threads.net", "threads.com"] },
  reddit: { label: "Reddit", icon: "reddit", url: (h) => `https://www.reddit.com/user/${h}`, hosts: ["reddit.com"] },
  twitch: { label: "Twitch", icon: "twitch", url: (h) => `https://www.twitch.tv/${h}`, hosts: ["twitch.tv"] },
  telegram: { label: "Telegram", icon: "telegram", url: (h) => `https://t.me/${h}`, hosts: ["t.me", "telegram.me"] },
  gitlab: { label: "GitLab", icon: "gitlab", url: (h) => `https://gitlab.com/${h}`, hosts: ["gitlab.com"] },
  codeberg: { label: "Codeberg", icon: "codeberg", url: (h) => `https://codeberg.org/${h}`, hosts: ["codeberg.org"] },
  hashnode: { label: "Hashnode", icon: "hashnode", url: (h) => `https://hashnode.com/@${h}`, hosts: ["hashnode.com", "hashnode.dev"] },
  substack: { label: "Substack", icon: "substack", url: (h) => `https://${h}.substack.com`, hosts: ["substack.com"] },
  kofi: { label: "Ko-fi", icon: "kofi", url: (h) => `https://ko-fi.com/${h}`, hosts: ["ko-fi.com"] },
  buymeacoffee: {
    label: "Buy Me a Coffee",
    icon: "buymeacoffee",
    url: (h) => `https://www.buymeacoffee.com/${h}`,
    hosts: ["buymeacoffee.com"]
  },
  patreon: { label: "Patreon", icon: "patreon", url: (h) => `https://www.patreon.com/${h}`, hosts: ["patreon.com"] },
  sponsors: { label: "Sponsor", icon: "githubsponsors", url: (h) => `https://github.com/sponsors/${h}`, hosts: [] },
  leetcode: { label: "LeetCode", icon: "leetcode", url: (h) => `https://leetcode.com/u/${h}`, hosts: ["leetcode.com"] },
  kaggle: { label: "Kaggle", icon: "kaggle", url: (h) => `https://www.kaggle.com/${h}`, hosts: ["kaggle.com"] },
  huggingface: { label: "Hugging Face", icon: "huggingface", url: (h) => `https://huggingface.co/${h}`, hosts: ["huggingface.co"] },
  dribbble: { label: "Dribbble", icon: "dribbble", url: (h) => `https://dribbble.com/${h}`, hosts: ["dribbble.com"] },
  behance: { label: "Behance", icon: "behance", url: (h) => `https://www.behance.net/${h}`, hosts: ["behance.net"] },
  codepen: { label: "CodePen", icon: "codepen", url: (h) => `https://codepen.io/${h}`, hosts: ["codepen.io"] },
  orcid: { label: "ORCID", icon: "orcid", url: (h) => `https://orcid.org/${h}`, hosts: ["orcid.org"] },
  scholar: {
    label: "Google Scholar",
    icon: "googlescholar",
    url: (h) => `https://scholar.google.com/citations?user=${encodeURIComponent(h)}`,
    hosts: ["scholar.google.com"]
  },
  rss: { label: "RSS", icon: "rss", url: (h) => `https://${h}`, hosts: [] }
};
var KEY_ALIASES = {
  twitter: "x",
  site: "website",
  web: "website",
  homepage: "website",
  blog: "website",
  url: "website",
  mail: "email",
  bsky: "bluesky",
  devdotto: "devto",
  dev: "devto",
  so: "stackoverflow",
  yt: "youtube",
  ig: "instagram",
  insta: "instagram",
  githubsponsors: "sponsors",
  bmc: "buymeacoffee",
  googlescholar: "scholar",
  li: "linkedin",
  gh: "github"
};
var ORDER_AUTO_FIRST = ["github"];
var ORDER_AUTO_LAST = ["x", "website"];
var platformKey = (key) => {
  const slug = slugify(key);
  return own(KEY_ALIASES, slug) ?? slug;
};
function safeUrl(value) {
  const v = value.trim();
  if (!v || /[\s<>"'`]/.test(v)) return null;
  if (/^https?:\/\/[^/?#]+/i.test(v)) return v;
  if (/^mailto:[^@]+@[^@]+\.[^@]+$/i.test(v)) return v;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(v) ? `https://${v}` : null;
}
var EMAIL = /^[^@\s/"'<>`]+@[^@\s/"'<>`]+\.[^@\s/"'<>`]+$/;
function hostOf(url) {
  const m = /^https?:\/\/([^/?#:]+)/i.exec(url);
  return (m?.[1] ?? "").toLowerCase().replace(/^www\./, "");
}
function detect(url) {
  const host = hostOf(url);
  if (!host) return null;
  if (host === "github.com" && /^https?:\/\/[^/]+\/sponsors\//i.test(url)) return "sponsors";
  for (const [key, p] of Object.entries(PLATFORMS)) {
    if (p.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return key;
  }
  return null;
}
function handleFromUrl(url) {
  const path = url.replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/)[0] ?? "";
  const seg = path.split("/").filter(Boolean).pop();
  return seg ? decodeURIComponentSafe(seg) : void 0;
}
function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
function buildLink(rawKey, rawValue) {
  const key = platformKey(rawKey);
  const value = rawValue.trim();
  if (!value) return null;
  if (key === "email") {
    const address = value.replace(/^mailto:/i, "");
    if (!EMAIL.test(address)) return null;
    return { key, label: "Email", url: `mailto:${address}`, icon: resolveIcon("email"), handle: address };
  }
  if (key === "website" || key === "rss") {
    const url = safeUrl(value);
    if (!url) return null;
    const host = hostOf(url);
    const p = own(PLATFORMS, key);
    return { key, label: key === "website" ? host || p.label : p.label, url, icon: resolveIcon(p.icon), handle: host || void 0 };
  }
  const platform = own(PLATFORMS, key);
  if (!platform) {
    return customLink(rawKey, value);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^[^/\s@]+\.[a-z]{2,}\//i.test(value)) {
    const url = safeUrl(value);
    if (!url) return null;
    return { key, label: platform.label, url, icon: resolveIcon(platform.icon), handle: handleFromUrl(url) };
  }
  const handle = platform.keepAt ? value : strip(value);
  if (!handle || /[\s<>"']/.test(handle)) return null;
  const path = platform.keepAt ? handle : handle.split("/").map(encodeURIComponent).join("/");
  return {
    key,
    label: platform.label,
    url: platform.url(path),
    icon: resolveIcon(platform.icon),
    handle: key === "x" || key === "threads" || key === "youtube" || key === "medium" ? `@${strip(handle)}` : handle
  };
}
function customLink(label2, value, iconName) {
  const bare = value.trim().replace(/^mailto:/i, "");
  const url = safeUrl(EMAIL.test(bare) ? `mailto:${bare}` : value);
  if (!url) return null;
  const detected = url.startsWith("mailto:") ? "email" : detect(url);
  const icon3 = iconName ? resolveIcon(iconName) : detected ? resolveIcon(own(PLATFORMS, detected)?.icon ?? detected) : resolveIcon("link");
  const text = label2.trim() || (detected ? own(PLATFORMS, detected)?.label ?? hostOf(url) : hostOf(url)) || "Link";
  return { key: slugify(text) || "link", label: text, url, icon: icon3 };
}
function fromObject(entry) {
  const url = typeof entry.url === "string" ? entry.url : typeof entry.href === "string" ? entry.href : "";
  const label2 = typeof entry.label === "string" ? entry.label : typeof entry.name === "string" ? entry.name : "";
  const icon3 = typeof entry.icon === "string" ? entry.icon : void 0;
  return url ? customLink(label2, url, icon3) : null;
}
function fromString(entry) {
  const s = entry.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    const key = detect(s);
    return key ? buildLink(key, s) : buildLink("website", s);
  }
  if (/^mailto:/i.test(s)) return buildLink("email", s);
  const i = s.indexOf(":");
  if (i <= 0) return EMAIL.test(s) ? buildLink("email", s) : null;
  return buildLink(s.slice(0, i), s.slice(i + 1));
}
var disabled = (v) => v === false || typeof v === "string" && /^(none|false|off|hide|-)?$/i.test(v.trim());
function resolveLinks(ctx) {
  const o = readOptions(ctx.options);
  const raw = o.raw("links");
  const links = [];
  const mentioned = /* @__PURE__ */ new Set();
  const push = (link) => {
    if (link) links.push(link);
  };
  const handleEntry = (key, value) => {
    const k = platformKey(key);
    mentioned.add(k);
    if (disabled(value)) return;
    if (k === "custom") {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item && typeof item === "object") push(fromObject(item));
      }
      return;
    }
    if (typeof value === "string" || typeof value === "number") push(buildLink(key, String(value)));
    else if (value && typeof value === "object" && !Array.isArray(value)) push(fromObject({ label: key, ...value }));
  };
  const handleItem = (item) => {
    if (typeof item === "string") {
      const s = item.trim();
      const i = s.indexOf(":");
      if (i > 0 && !/^(https?|mailto):/i.test(s)) mentioned.add(platformKey(s.slice(0, i)));
      if (i > 0 && disabled(s.slice(i + 1))) return;
      const link = fromString(s);
      if (link) mentioned.add(link.key);
      push(link);
    } else if (item && typeof item === "object") {
      const obj = item;
      if ("url" in obj || "href" in obj) push(fromObject(obj));
      else for (const [k, v] of Object.entries(obj)) handleEntry(k, v);
    }
  };
  if (Array.isArray(raw)) raw.forEach(handleItem);
  else if (typeof raw === "string") raw.split(/[\n,]/).forEach(handleItem);
  else if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) handleEntry(k, v);
  if (o.boolean("auto", true)) {
    const d = ctx.data;
    const auto = {
      github: d.login || null,
      x: d.twitter,
      website: d.websiteUrl
    };
    const first = [];
    for (const key of ORDER_AUTO_FIRST) {
      const v = auto[key];
      if (!mentioned.has(key) && v) {
        const link = buildLink(key, v);
        if (link) first.push(link);
      }
    }
    links.unshift(...first);
    for (const key of ORDER_AUTO_LAST) {
      const v = auto[key];
      if (!mentioned.has(key) && v) push(buildLink(key, v));
    }
  }
  const seen = /* @__PURE__ */ new Set();
  return links.filter((l) => seen.has(l.url) ? false : (seen.add(l.url), true));
}
var H2 = 36;
function pill(link, p, showHandle, ctx) {
  const label2 = fit(link.label, 220, 13.5, { weight: 600 });
  const handle = showHandle && link.handle && link.handle !== link.label ? fit(link.handle, 220, 13, {}) : "";
  const textW = textWidth(label2, 13.5, { weight: 600 }) + (handle ? 7 + textWidth(handle, 13, {}) : 0);
  const W5 = Math.ceil(14 + 18 + 9 + textW + 17);
  const color = legible(link.icon.hex || p.accentA, p.panel, p.text);
  const alt = handle ? `${link.label}: ${link.handle}` : link.label;
  const body = `<circle cx="23" cy="18" r="17" fill="url(#sg)"/><g class="fade">${drawIcon(link.icon, 14, 9, 18, { color, inks: [p.panel, p.text] })}<text x="41" y="22.8" class="sans" font-size="13.5" font-weight="600" fill="${p.text}">${esc(label2)}` + (handle ? `<tspan dx="7" font-size="13" font-weight="500" fill="${p.muted}">${esc(handle)}</tspan>` : "") + "</text></g>";
  const svg = shell({
    width: W5,
    height: H2,
    palette: p,
    title: alt,
    defs: glow(color, ctx),
    body,
    radius: H2 / 2,
    animate: ctx.animate
  });
  return { svg, alt };
}
function iconBadge(link, p, ctx) {
  const color = legible(link.icon.hex || p.accentA, p.panel, p.text);
  const alt = link.handle && link.handle !== link.label ? `${link.label}: ${link.handle}` : link.label;
  const body = `<circle cx="18" cy="18" r="17" fill="url(#sg)"/><g class="fade">${drawIcon(link.icon, 9, 9, 18, { color, inks: [p.panel, p.text] })}</g>`;
  return { svg: shell({ width: H2, height: H2, palette: p, title: alt, defs: glow(color, ctx), body, radius: H2 / 2, animate: ctx.animate }), alt };
}
function glow(color, ctx) {
  const o = ctx.mode === "dark" ? 0.22 : 0.14;
  return `<radialGradient id="sg"><stop offset="0" stop-color="${color}" stop-opacity="${n(o, 2)}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`;
}
var card6 = {
  id: "socials",
  title: "Social badges",
  description: "One small, theme-aware badge per link (GitHub, LinkedIn, X, website, email and more), each linking to its destination.",
  options: [
    {
      key: "links",
      type: "object",
      default: "GitHub, X and website from your profile",
      description: 'Links as {"linkedin": "handle", "email": "me@x.dev", "custom": [{"label": "Blog", "url": "https://\u2026"}]} or a list like ["linkedin:handle", "https://\u2026"]. Set a key to false to hide it.'
    },
    { key: "style", type: "string", default: "pill", description: '"pill" (icon + label) or "icon" (round icon only).' },
    { key: "handles", type: "boolean", default: false, description: "Show the handle or address after the platform name (pill style)." },
    { key: "auto", type: "boolean", default: true, description: "Add GitHub, X and website links from your profile automatically." }
  ],
  render(ctx) {
    const p = ctx.palette;
    const o = readOptions(ctx.options);
    const style = o.oneOf("style", ["pill", "icon"], "pill");
    const showHandles = o.boolean("handles", false);
    const links = resolveLinks(ctx);
    if (!links.length) {
      const placeholder2 = { key: "none", label: "No links yet", url: "", icon: resolveIcon("link") };
      const { svg } = pill(placeholder2, p, false, ctx);
      return [{ name: "socials", alt: "No social links configured", svg, layout: "inline" }];
    }
    const used = /* @__PURE__ */ new Map();
    return links.map((link) => {
      const base = `social-${link.key}`;
      const count = (used.get(base) ?? 0) + 1;
      used.set(base, count);
      const { svg, alt } = style === "icon" ? iconBadge(link, p, ctx) : pill(link, p, showHandles, ctx);
      return { name: count > 1 ? `${base}-${count}` : base, alt, svg, link: link.url, layout: "inline" };
    });
  }
};

// src/cards/stack.ts
var W3 = 1200;
var PAD3 = 40;
var HEADER_Y = 56;
var MAX_ICONS = 48;
function parseItem(entry) {
  const i = entry.indexOf(":");
  const key = (i > 0 ? entry.slice(0, i) : entry).trim();
  const custom = i > 0 ? entry.slice(i + 1).trim() : "";
  if (!key) return null;
  const icon3 = resolveIcon(key);
  return { icon: icon3, label: custom || displayName(icon3.title) };
}
function defaultStack(data, limit = 8) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const lang of data.languages) {
    const icon3 = resolveIcon(lang.name);
    if (!icon3.known || seen.has(icon3.slug)) continue;
    seen.add(icon3.slug);
    out.push(lang.name);
    if (out.length >= limit) break;
  }
  return out;
}
function items(ctx) {
  const o = readOptions(ctx.options);
  const requested = o.has("icons") ? o.list("icons", []) : defaultStack(ctx.data);
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of requested) {
    const item = parseItem(entry);
    if (!item) continue;
    const key = `${item.icon.slug}|${item.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= MAX_ICONS) break;
  }
  return out;
}
function iconColor(icon3, bg, p) {
  return legible(icon3.hex || p.accentA, bg, p.text);
}
function tiles(list, top, perRow, ctx) {
  const p = ctx.palette;
  const gap = 16;
  const tileW = (W3 - PAD3 * 2 - gap * (perRow - 1)) / perRow;
  const iconSize = Math.round(Math.min(46, Math.max(26, tileW * 0.36)));
  const labelSize = tileW < 96 ? 12 : 14;
  const tileH = Math.round(iconSize + 78);
  const glowOpacity = ctx.mode === "dark" ? 0.2 : 0.13;
  const gradients = /* @__PURE__ */ new Map();
  const parts2 = [];
  const rows = Math.ceil(list.length / perRow);
  list.forEach((item, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const inRow = Math.min(perRow, list.length - row * perRow);
    const rowWidth = inRow * tileW + (inRow - 1) * gap;
    const x = (W3 - rowWidth) / 2 + col * (tileW + gap);
    const y = top + row * (tileH + gap);
    const color = iconColor(item.icon, p.panelAlt, p);
    let gid = gradients.get(color);
    if (!gid) {
      gid = `sg${gradients.size}`;
      gradients.set(color, gid);
    }
    const cx = x + tileW / 2;
    const iy = y + 24;
    const text = fit(item.label, tileW - 16, labelSize, { weight: 600 });
    parts2.push(
      `<g class="up" ${delay(0.08 + Math.min(i, 24) * 0.035)}><rect x="${n(x, 2)}" y="${n(y, 2)}" width="${n(tileW, 2)}" height="${tileH}" rx="14" fill="${p.panelAlt}" stroke="${p.border}"/><circle cx="${n(cx, 2)}" cy="${n(iy + iconSize / 2, 2)}" r="${n(iconSize * 1.05, 2)}" fill="url(#${gid})"/>` + drawIcon(item.icon, cx - iconSize / 2, iy, iconSize, { color, inks: [p.panel, p.text] }) + `<text x="${n(cx, 2)}" y="${n(y + tileH - 22, 2)}" text-anchor="middle" class="sans" font-size="${labelSize}" font-weight="600" fill="${p.text}">${esc(text)}</text></g>`
    );
  });
  const defs = [...gradients].map(
    ([color, id]) => `<radialGradient id="${id}"><stop offset="0" stop-color="${color}" stop-opacity="${glowOpacity}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`
  ).join("");
  return { body: parts2.join(""), defs, height: rows * tileH + (rows - 1) * gap };
}
function chips(list, top, ctx) {
  const p = ctx.palette;
  const h = 44;
  const gap = 12;
  const iconSize = 20;
  const fontSize = 15;
  const maxW = W3 - PAD3 * 2;
  const placed = [[]];
  let rowW = 0;
  for (const item of list) {
    const text = fit(item.label, 360, fontSize, { weight: 600 });
    const w = Math.ceil(16 + iconSize + 10 + textWidth(text, fontSize, { weight: 600 }) + 20);
    let row = placed[placed.length - 1];
    if (row.length && rowW + gap + w > maxW) {
      row = [];
      placed.push(row);
      rowW = 0;
    }
    rowW += (row.length ? gap : 0) + w;
    row.push({ item, w, text });
  }
  const parts2 = [];
  let i = 0;
  placed.forEach((row, r) => {
    let x = PAD3;
    const y = top + r * (h + gap);
    for (const { item, w, text } of row) {
      const color = iconColor(item.icon, p.chipBg, p);
      parts2.push(
        `<g class="up" ${delay(0.08 + Math.min(i, 24) * 0.03)}><rect x="${n(x, 2)}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${p.chipBg}" stroke="${p.border}"/>` + drawIcon(item.icon, x + 16, y + (h - iconSize) / 2, iconSize, { color, inks: [p.panel, p.text] }) + `<text x="${n(x + 16 + iconSize + 10, 2)}" y="${y + h / 2 + 5.3}" class="sans" font-size="${fontSize}" font-weight="600" fill="${p.text}">${esc(text)}</text></g>`
      );
      x += w + gap;
      i++;
    }
  });
  return { body: parts2.join(""), defs: "", height: placed.length * h + (placed.length - 1) * gap };
}
function emptyState(top, p) {
  const h = 112;
  return {
    body: `<g class="fade"><rect x="${PAD3 + 0.5}" y="${top + 0.5}" width="${W3 - PAD3 * 2 - 1}" height="${h - 1}" rx="14" fill="${p.panelAlt}" fill-opacity=".6" stroke="${p.faint}" stroke-opacity=".45" stroke-dasharray="5 5"/><text x="${W3 / 2}" y="${top + 50}" text-anchor="middle" class="sans" font-size="16" font-weight="600" fill="${p.muted}">No tech stack to show yet</text><text x="${W3 / 2}" y="${top + 76}" text-anchor="middle" class="mono" font-size="12.5" fill="${p.muted}">Pick icons with the "icons" option, e.g. typescript, docker, postgres</text></g>`,
    defs: "",
    height: h
  };
}
var card7 = {
  id: "stack",
  title: "Tech stack",
  description: "Brand icons for the technologies you use, as tiles or pills. Missing logos fall back to tasteful monograms.",
  options: [
    {
      key: "icons",
      type: "list",
      default: "top languages with an icon (max 8)",
      description: 'Technologies to show: slugs or aliases (typescript, csharp, k8s, aws\u2026). Append ":Label" to rename one.'
    },
    { key: "style", type: "string", default: "tiles", description: '"tiles" (icon above label) or "chips" (pill per technology).' },
    { key: "title", type: "string", default: "Tech stack", description: "Header label." },
    { key: "hideTitle", type: "boolean", default: false, description: "Hide the header row." },
    { key: "perRow", type: "number", default: 8, description: "Tiles per row (3\u201312); rows wrap and the card grows." }
  ],
  render(ctx) {
    const p = ctx.palette;
    const o = readOptions(ctx.options);
    const list = items(ctx);
    const style = o.oneOf("style", ["tiles", "chips"], "tiles");
    const perRow = Math.round(o.number("perRow", 8, { min: 3, max: 12 }));
    const title = o.string("title", "Tech stack");
    const hideTitle = o.boolean("hideTitle", false);
    const top = hideTitle ? PAD3 : 80;
    const layout2 = !list.length ? emptyState(top, p) : style === "chips" ? chips(list, top, ctx) : tiles(list, top, perRow, ctx);
    const height = Math.round(top + layout2.height + PAD3);
    const countText = list.length ? `${list.length} ${plural(list.length, "technology", "technologies")}` : "";
    const titleRoom = W3 - PAD3 * 2 - (countText ? labelWidth(countText) + 32 : 0);
    const header2 = hideTitle ? "" : `<g class="fade">${label(PAD3, HEADER_Y, fitLabel(title, titleRoom), p)}` + (countText ? label(W3 - PAD3, HEADER_Y, countText, p, { anchor: "end", color: p.muted }) : "") + "</g>";
    const names = list.map((i) => i.label);
    const alt = names.length ? `${title}: ${names.join(", ")}` : `${title}: nothing to show yet`;
    return [
      {
        name: "stack",
        alt,
        layout: "full",
        svg: shell({
          width: W3,
          height,
          palette: p,
          title,
          desc: alt,
          defs: layout2.defs,
          body: header2 + layout2.body,
          radius: 20,
          glow: { cx: 0.08, cy: 0, r: 0.9, color: p.accentA, opacity: p.glowOpacity * 0.22 },
          animate: ctx.animate
        })
      }
    ];
  }
};

// src/cards/stats.ts
var DAY2 = 864e5;
var W4 = 1200;
var PAD4 = 40;
var TILE_H = 74;
var GAP3 = 12;
var HERO_SIZE = 58;
var LABEL_SIZE = 11;
var LABEL_SPACING = 0.8;
var METRIC_KEYS = [
  "currentStreak",
  "longestStreak",
  "commits",
  "pullRequests",
  "issues",
  "reviews",
  "allTime",
  "bestWeek",
  "bestDay",
  "activeDays",
  "years",
  "stars",
  "followers",
  "repos"
];
var DEFAULT_METRICS = ["currentStreak", "longestStreak", "commits", "allTime", "bestWeek", "years"];
var MAX_METRICS = 9;
var normalize = (s) => s.toLowerCase().replace(/[^a-z]/g, "");
var LOOKUP = {
  ...Object.fromEntries(METRIC_KEYS.map((k) => [normalize(k), k])),
  streak: "currentStreak",
  prs: "pullRequests",
  pulls: "pullRequests",
  pullrequest: "pullRequests",
  issue: "issues",
  review: "reviews",
  total: "allTime",
  alltimecontributions: "allTime",
  year: "years",
  age: "years",
  yearsongithub: "years",
  star: "stars",
  follower: "followers",
  repo: "repos",
  repositories: "repos",
  publicrepos: "repos",
  publicrepocount: "repos"
};
function parseMetrics(input) {
  const out = [];
  for (const raw of input) {
    const key = own(LOOKUP, normalize(raw));
    if (key && !out.includes(key)) out.push(key);
  }
  return out.slice(0, MAX_METRICS);
}
var safe = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
function computeFacts(data, now) {
  const today = isoDate(now);
  const calendar = (Array.isArray(data.calendar) ? data.calendar : []).filter((d) => d && typeof d.date === "string" && d.date.slice(0, 10) <= today).map((d) => ({ date: d.date.slice(0, 10), count: safe(d.count) }));
  const year = lastYear(calendar, now);
  const rolling = year.slice(-364);
  const weeks = Array.from({ length: 52 }, (_, w) => rolling.slice(w * 7, w * 7 + 7).reduce((s, d) => s + d.count, 0));
  let bestDay = { count: 0, date: null };
  for (const d of year) if (d.count > bestDay.count) bestDay = { count: d.count, date: d.date };
  const { current, longest } = streaks(calendar, now);
  const allTime = calendar.reduce((s, d) => s + d.count, 0);
  const created = Date.parse(data.createdAt);
  const ageDays = Number.isFinite(created) ? Math.max(0, Math.floor((now.getTime() - created) / DAY2)) : 0;
  const years = Math.floor(ageDays / 365.25);
  const age = years >= 1 ? { value: years, unit: "year" } : ageDays >= 31 ? { value: Math.floor(ageDays / 30.44), unit: "month" } : { value: ageDays, unit: "day" };
  const createdYear = Number.isFinite(created) ? new Date(created).toISOString().slice(0, 4) : "";
  const firstYear = calendar[0]?.date.slice(0, 4) ?? "";
  const since = allTime > 0 ? [createdYear, firstYear].filter(Boolean).sort().pop() ?? null : null;
  const y = data.year;
  return {
    yearTotal: yearTotal({ calendar, year: y }, now),
    current,
    longest,
    allTime,
    since,
    weeks,
    weeksStart: rolling[0]?.date ?? today,
    bestWeek: Math.max(0, ...weeks),
    bestDay,
    activeDays: year.filter((d) => d.count > 0).length,
    windowDays: year.length,
    age,
    commits: safe(y?.commits),
    pullRequests: safe(y?.pullRequests),
    issues: safe(y?.issues),
    reviews: safe(y?.reviews),
    stars: safe(data.totalStars),
    followers: safe(data.followers),
    repos: safe(data.publicRepoCount)
  };
}
var PAST_YEAR = "past year";
function shortDay(iso) {
  const [, m = "1", d = "1"] = iso.split("-");
  return `${MONTHS[Number(m) - 1] ?? ""} ${Number(d)}`;
}
function buildTile(key, f) {
  const t = (label2, value, unit, icon3) => ({ key, label: label2, value: compact(value), unit, icon: icon3 });
  switch (key) {
    case "currentStreak":
      return t("Current streak", f.current, plural(f.current, "day"), "flame");
    case "longestStreak":
      return t("Longest streak", f.longest, plural(f.longest, "day"), "trophy");
    case "commits":
      return t("Commits", f.commits, PAST_YEAR, "commit");
    case "pullRequests":
      return t("Pull requests", f.pullRequests, PAST_YEAR, "pr");
    case "issues":
      return t("Issues", f.issues, PAST_YEAR, "issue");
    case "reviews":
      return t("Reviews", f.reviews, PAST_YEAR, "eye");
    case "allTime":
      return t("All-time", f.allTime, f.since ? `since ${f.since}` : "total", "layers");
    case "bestWeek":
      return t("Best week", f.bestWeek, "in 7 days", "bars");
    case "bestDay":
      return t("Best day", f.bestDay.count, f.bestDay.date ? `on ${shortDay(f.bestDay.date)}` : "", "bolt");
    case "activeDays":
      return t("Active days", f.activeDays, `of ${f.windowDays}`, "calendar");
    case "years":
      return t("On GitHub", f.age.value, plural(f.age.value, f.age.unit), "clock");
    case "stars":
      return t("Stars", f.stars, "earned", "star");
    case "followers":
      return t("Followers", f.followers, "", "people");
    case "repos":
      return t("Repositories", f.repos, "public", "repo");
  }
}
var ring = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
var ICONS2 = {
  flame: "M8 1.6c1.4 2.5 4.3 4 4.3 7.7A4.3 4.3 0 0 1 3.7 9.3c0-2 1-3.3 2.2-4.2.1 1.4.8 2.4 1.8 2.8C7.3 5.9 7.3 3.7 8 1.6Z",
  trophy: "M5 2h6v4a3 3 0 0 1-6 0V2Z M5 3.4H2.6a2.4 2.4 0 0 0 2.7 3.1 M11 3.4h2.4a2.4 2.4 0 0 1-2.7 3.1 M8 9v3.4 M5 14.2h6",
  commit: `${ring(8, 8, 2.7)} M1.2 8h4.1 M10.7 8h4.1`,
  pr: `${ring(4, 3.4, 1.7)} ${ring(4, 12.6, 1.7)} ${ring(12, 12.6, 1.7)} M4 5.1v5.8 M12 10.9V6.4a2 2 0 0 0-2-2H7.2 M8.9 2.7 7.2 4.4l1.7 1.7`,
  issue: `${ring(8, 8, 6.3)} ${ring(8, 8, 0.6)}`,
  eye: `M1.3 8S3.8 3.3 8 3.3 14.7 8 14.7 8 12.2 12.7 8 12.7 1.3 8 1.3 8Z ${ring(8, 8, 2.2)}`,
  layers: "M8 1.7l6.3 3.2L8 8.1 1.7 4.9 8 1.7Z M1.7 8.1 8 11.3l6.3-3.2 M1.7 11.3 8 14.5l6.3-3.2",
  bars: "M2 14.3h12 M4.2 11.6V8.2 M8 11.6V2.4 M11.8 11.6V5.6",
  bolt: "M9.3 1.4 3.4 9.1h4.4l-1 5.5 5.9-7.7H8.3l1-5.5Z",
  calendar: "M3.6 2.9h8.8a1.6 1.6 0 0 1 1.6 1.6v8.1a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 12.6V4.5a1.6 1.6 0 0 1 1.6-1.6Z M2 6.6h12 M5.3 1.4v2.8 M10.7 1.4v2.8 M5.7 10.3l1.6 1.5 3-3.1",
  clock: `${ring(8, 8, 6.3)} M8 4.4V8l2.4 1.6`,
  star: "M8 1.5l2 4 4.4.7-3.2 3.1.8 4.4L8 11.6l-4 2.1.8-4.4-3.2-3.1 4.4-.7 2-4Z",
  people: `${ring(6, 5.1, 2.5)} M1.4 13.9a4.6 4.6 0 0 1 9.2 0 M10.7 2.8a2.5 2.5 0 0 1 0 4.7 M12.3 9.5a4.6 4.6 0 0 1 2.3 4.4`,
  repo: "M3 12.9V3.2a1.7 1.7 0 0 1 1.7-1.7H13v10.1H4.6A1.6 1.6 0 0 0 3 13.2a1.3 1.3 0 0 0 1.3 1.3H13 M6 4.6h4.2"
};
function icon2(name, x, y, size, color) {
  const d = ICONS2[name];
  if (!d) return "";
  return `<path transform="translate(${n(x)} ${n(y)}) scale(${n(size / 16, 3)})" d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
}
function tileSvg(t, x, y, w, p, index) {
  const inner = w - 32;
  const labelText = fitLabel(t.label.toUpperCase(), inner - 21, { size: LABEL_SIZE, spacing: LABEL_SPACING });
  const unitW = t.unit ? textWidth(t.unit, 13) + 6 : 0;
  let size = 26;
  const valueW = (s) => textWidth(t.value, s, { weight: 700 }) - 0.5 * t.value.length;
  while (size > 18 && valueW(size) + unitW > inner) size--;
  const unit = t.unit && valueW(size) + unitW > inner ? fit(t.unit, Math.max(0, inner - valueW(size) - 6), 13) : t.unit;
  const unitSvg = unit ? `<tspan dx="6" font-size="13" fill="${p.muted}">${esc(unit)}</tspan>` : "";
  return `<g class="up" ${delay(0.12 + index * 0.05)}><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${TILE_H}" rx="12" fill="${p.panelAlt}" stroke="${p.border}"/>` + icon2(t.icon, x + 16, y + 15, 14, p.accentB) + `<text x="${n(x + 37)}" y="${n(y + 26.5)}" class="mono" font-size="${LABEL_SIZE}" letter-spacing="${LABEL_SPACING}" fill="${p.muted}">${esc(labelText)}</text><text x="${n(x + 16)}" y="${n(y + 58)}" class="sans"><tspan font-size="${size}" font-weight="700" letter-spacing="-.5" fill="${p.text}">${esc(t.value)}</tspan>${unitSvg}</text></g>`;
}
function tileGrid(tiles2, x, y, width, p) {
  if (!tiles2.length) return { svg: "", height: 0 };
  const cols = tiles2.length === 4 ? 2 : 3;
  const rows = Math.ceil(tiles2.length / cols);
  const w = (width - (cols - 1) * GAP3) / cols;
  const svg = tiles2.map((t, i) => tileSvg(t, x + i % cols * (w + GAP3), y + Math.floor(i / cols) * (TILE_H + GAP3), w, p, i)).join("");
  return { svg, height: rows * TILE_H + (rows - 1) * GAP3 };
}
function heroNumber(value) {
  return value < 1e6 ? Math.round(value).toLocaleString("en-US") : compact(value);
}
function hero(total, x, baseline, maxWidth, p) {
  const text = heroNumber(total);
  const unit = plural(total, "contribution");
  let size = HERO_SIZE;
  const numberW = (s) => textWidth(text, s, { weight: 800 }) - 2 * [...text].length;
  const unitW = textWidth(unit, 18) + 12;
  while (size > 36 && numberW(size) + unitW > maxWidth) size -= 2;
  const defs = `<linearGradient id="st-hero" gradientUnits="userSpaceOnUse" x1="${n(x)}" y1="0" x2="${n(x + Math.max(40, numberW(size)))}" y2="0"><stop offset="0" stop-color="${p.accentA}"/><stop offset="1" stop-color="${p.accentB}"/></linearGradient>`;
  const svg = `<text x="${n(x)}" y="${n(baseline)}" class="sans up" ${delay(0.05)}><tspan font-size="${size}" font-weight="800" letter-spacing="-2" fill="url(#st-hero)">${esc(text)}</tspan><tspan dx="12" font-size="18" fill="${p.muted}">${esc(unit)}</tspan></text>`;
  return { svg, defs };
}
function weeklyChart(f, box, ctx) {
  const p = ctx.palette;
  const ramp = contribRamp(p, ctx.mode);
  const { x: x0, width: cw, top, bottom } = box;
  const bh = bottom - top;
  const weeks = f.weeks;
  const peak = Math.max(0, ...weeks);
  const step = cw / weeks.length;
  const bw = Math.max(2, step * 0.66);
  const rx = Math.min(3, bw / 2);
  const parts2 = [];
  if (box.headerY !== null) {
    parts2.push(label(x0, box.headerY, "Weekly contributions", p, { color: p.muted }));
  }
  if (peak > 0) {
    for (const k of [0.5, 1]) {
      const gy = bottom - bh * k;
      parts2.push(`<line x1="${n(x0)}" y1="${n(gy)}" x2="${n(x0 + cw)}" y2="${n(gy)}" stroke="${p.grid}" stroke-opacity="${n(p.gridOpacity * 1.6, 3)}"/>`);
    }
  }
  const defs = `<linearGradient id="st-bars" gradientUnits="userSpaceOnUse" x1="0" y1="${n(bottom)}" x2="0" y2="${n(top)}"><stop offset="0" stop-color="${ramp[1]}"/><stop offset=".38" stop-color="${ramp[2]}"/><stop offset=".72" stop-color="${ramp[3]}"/><stop offset="1" stop-color="${ramp[4]}"/></linearGradient>`;
  weeks.forEach((v, i) => {
    const x = x0 + i * step + (step - bw) / 2;
    if (v <= 0 || peak <= 0) {
      parts2.push(`<rect x="${n(x)}" y="${n(bottom - 3)}" width="${n(bw)}" height="3" rx="1.5" fill="${p.empty}"/>`);
      return;
    }
    const h = Math.max(4, v / peak * bh);
    parts2.push(
      `<rect class="st-bar" ${delay(0.25 + i * 0.012)} x="${n(x)}" y="${n(bottom - h)}" width="${n(bw)}" height="${n(h)}" rx="${n(rx)}" fill="url(#st-bars)"/>`
    );
  });
  if (peak > 0) {
    const avg = weeks.reduce((s, v) => s + v, 0) / weeks.length;
    const avgY = bottom - avg / peak * bh;
    const avgText = `avg ${compact(avg)} / week`;
    const lw = 22 + textWidth(avgText, 11.5, { mono: true });
    const lx = x0 + (cw - lw) / 2;
    parts2.push(
      `<line class="fade" ${delay(0.9)} x1="${n(x0)}" y1="${n(avgY)}" x2="${n(x0 + cw)}" y2="${n(avgY)}" stroke="${p.muted}" stroke-opacity=".7" stroke-dasharray="3 4"/>`,
      `<g class="fade" ${delay(0.9)}><line x1="${n(lx)}" y1="${n(box.axisY - 4)}" x2="${n(lx + 14)}" y2="${n(box.axisY - 4)}" stroke="${p.muted}" stroke-dasharray="3 3"/><text x="${n(lx + 22)}" y="${n(box.axisY)}" class="mono" font-size="11.5" fill="${p.muted}">${esc(avgText)}</text></g>`
    );
    const pi = weeks.indexOf(peak);
    const peakText = `peak ${compact(peak)}`;
    const pw = textWidth(peakText, 11, { mono: true });
    const pcx = Math.min(x0 + cw - pw / 2, Math.max(x0 + pw / 2, x0 + pi * step + step / 2));
    parts2.push(
      `<text class="mono fade" ${delay(0.9)} x="${n(pcx)}" y="${n(top - 8)}" text-anchor="middle" font-size="11" fill="${p.muted}">${esc(peakText)}</text>`
    );
  } else {
    const cy = top + bh / 2;
    parts2.push(
      `<g class="fade" ${delay(0.3)}><text x="${n(x0 + cw / 2)}" y="${n(cy - 4)}" text-anchor="middle" class="sans" font-size="16" font-weight="600" fill="${p.text}">No contributions yet</text><text x="${n(x0 + cw / 2)}" y="${n(cy + 18)}" text-anchor="middle" class="sans" font-size="13" fill="${p.muted}">Each week of activity will rise here as a bar.</text></g>`
    );
  }
  parts2.push(
    `<text x="${n(x0)}" y="${n(box.axisY)}" class="mono" font-size="11.5" fill="${p.muted}">${esc(monthYear(f.weeksStart))}</text>`,
    `<text x="${n(x0 + cw)}" y="${n(box.axisY)}" text-anchor="end" class="mono" font-size="11.5" fill="${p.muted}">now</text>`
  );
  return { svg: parts2.join(""), defs };
}
var DEFAULT_TITLE = "Activity \xB7 last 12 months";
function render2(ctx) {
  const p = ctx.palette;
  const o = readOptions(ctx.options);
  const chart = o.oneOf("chart", ["weekly", "none"], "weekly");
  const showTitle = !o.boolean("hideTitle", false);
  const title = o.optionalString("title") ?? DEFAULT_TITLE;
  const keys = parseMetrics(o.list("metrics", DEFAULT_METRICS));
  const facts = computeFacts(ctx.data, ctx.now);
  const tiles2 = (keys.length ? keys : DEFAULT_METRICS).map((k) => buildTile(k, facts));
  const heroTop = showTitle ? 80 : PAD4;
  const heroBaseline = heroTop + 43;
  const parts2 = [];
  const defs = [];
  let H3;
  if (chart === "weekly") {
    const leftW = 504;
    const dividerX = PAD4 + leftW + 40;
    const chartX = dividerX + 40;
    if (showTitle) parts2.push(label(PAD4, 56, fitLabel(title, leftW), p));
    const h = hero(facts.yearTotal, PAD4, heroBaseline, leftW, p);
    defs.push(h.defs);
    parts2.push(h.svg);
    const tilesTop = heroBaseline + 28;
    const grid = tileGrid(tiles2, PAD4, tilesTop, leftW, p);
    parts2.push(grid.svg);
    H3 = tilesTop + grid.height + PAD4;
    parts2.push(`<line x1="${dividerX}" y1="${PAD4}" x2="${dividerX}" y2="${n(H3 - PAD4)}" stroke="${p.border}"/>`);
    const axisY = H3 - PAD4 - 2;
    const top = (showTitle ? 78 : PAD4) + 22;
    const c = weeklyChart(facts, { x: chartX, width: W4 - PAD4 - chartX, headerY: showTitle ? 56 : null, top, bottom: axisY - 22, axisY }, ctx);
    defs.push(c.defs);
    parts2.push(c.svg);
  } else {
    const leftW = 360;
    const dividerX = PAD4 + leftW + 40;
    const tilesX = dividerX + 40;
    const heroBlock = (showTitle ? 40 : 0) + 43;
    const rows = Math.ceil(tiles2.length / (tiles2.length === 4 ? 2 : 3));
    const gridH = rows * TILE_H + (rows - 1) * GAP3;
    const contentH = Math.max(heroBlock + 14, gridH);
    H3 = PAD4 * 2 + contentH;
    const blockTop = PAD4 + (contentH - heroBlock) / 2 - 4;
    if (showTitle) parts2.push(label(PAD4, blockTop + 12, fitLabel(title, leftW), p));
    const h = hero(facts.yearTotal, PAD4, blockTop + heroBlock, leftW, p);
    defs.push(h.defs);
    parts2.push(h.svg);
    parts2.push(`<line x1="${dividerX}" y1="${PAD4}" x2="${dividerX}" y2="${n(H3 - PAD4)}" stroke="${p.border}"/>`);
    parts2.push(tileGrid(tiles2, tilesX, PAD4 + (contentH - gridH) / 2, W4 - PAD4 - tilesX, p).svg);
  }
  const who = ctx.data.name || ctx.data.login || "GitHub user";
  const summary = tiles2.map((t) => `${t.label}: ${t.value}${t.unit ? ` ${t.unit}` : ""}`).join(", ");
  const headline = `${heroNumber(facts.yearTotal)} ${plural(facts.yearTotal, "contribution")} in the last 12 months`;
  const style = ".st-bar{transform-box:fill-box;transform-origin:50% 100%;animation:st-grow .9s cubic-bezier(.2,.7,.2,1) backwards}@keyframes st-grow{from{transform:scaleY(0)}}";
  const svg = shell({
    width: W4,
    height: H3,
    palette: p,
    title: `${who}'s GitHub stats: ${headline}`,
    desc: summary,
    defs: defs.join(""),
    style,
    body: parts2.join(""),
    radius: 20,
    glow: { cx: 1, cy: 0, r: 1, color: p.accentB, opacity: p.glowOpacity * 0.35 },
    animate: ctx.animate
  });
  return [{ name: "stats", alt: `GitHub stats: ${headline}. ${summary}.`, svg, layout: "full" }];
}
var card8 = {
  id: "stats",
  title: "Stats",
  description: "Your last 12 months at a glance: a gradient hero number, a grid of metric tiles you pick and order (streaks, commits, PRs, stars and more) and a weekly contribution chart.",
  options: [
    {
      key: "metrics",
      type: "list",
      default: DEFAULT_METRICS,
      description: `Tiles to show, in order (3 to 9, laid out in rows of 3). Any of: ${METRIC_KEYS.join(", ")}.`
    },
    { key: "chart", type: "string", default: "weekly", description: '"weekly" shows 52 weekly bars; "none" makes a compact, numbers-only card.' },
    { key: "title", type: "string", default: DEFAULT_TITLE, description: "Header label text." },
    { key: "hideTitle", type: "boolean", default: false, description: "Hide the header label and tighten the layout." }
  ],
  render: render2
};

// src/cards/registry.ts
var CARDS = {
  stats: card8,
  languages: card,
  "3d": card2,
  grid: card3,
  repos: card5,
  hero: card4,
  stack: card7,
  socials: card6
};

// src/render.ts
function renderCards(req) {
  const theme = typeof req.theme === "object" ? req.theme : getTheme(req.theme);
  const modes = req.modes?.length ? req.modes : ["dark", "light"];
  const now = req.now ?? /* @__PURE__ */ new Date();
  const animate = req.animate ?? true;
  const files = [];
  for (const id of req.cards) {
    const card9 = CARDS[id];
    if (!card9) throw new Error(`Unknown card "${id}"`);
    for (const mode of modes) {
      const palette = applyOverrides(theme[mode], req.colors, mode === "dark" ? req.darkColors : req.lightColors);
      const images = card9.render({ data: req.data, theme, palette, mode, options: req.options?.[id] ?? {}, animate, now });
      for (const img of images) {
        files.push({
          card: id,
          name: img.name,
          mode,
          path: `${img.name}-${mode}.svg`,
          alt: img.alt,
          svg: img.svg,
          link: img.link,
          layout: img.layout ?? "full"
        });
      }
    }
  }
  return files;
}
function picture(baseUrl, group2, width) {
  const first = group2[0];
  const dark = group2.find((f) => f.mode === "dark");
  const light = group2.find((f) => f.mode === "light");
  const url = (f) => `${baseUrl.replace(/\/$/, "")}/${f.path}`;
  const fallback = light ?? dark ?? first;
  const img = `<img src="${esc(url(fallback))}" alt="${esc(first.alt)}" width="${width}" />`;
  const inner = dark && light ? `<picture>
  <source media="(prefers-color-scheme: dark)" srcset="${esc(url(dark))}" />
  ${img}
</picture>` : img;
  return first.link ? `<a href="${esc(first.link)}">
${inner}
</a>` : inner;
}
function readmeMarkup(files, baseUrl) {
  const groups = /* @__PURE__ */ new Map();
  for (const f of files) groups.set(f.name, [...groups.get(f.name) ?? [], f]);
  const blocks = [];
  const pending = [];
  const inline = [];
  const flushInline = () => {
    if (!inline.length) return;
    const items2 = inline.map((g) => picture(baseUrl, g, "auto").replace(' width="auto"', ""));
    blocks.push(`<p align="center">
${items2.join("\n")}
</p>`);
    inline.length = 0;
  };
  const flushHalves = () => {
    for (let i = 0; i < pending.length; i += 2) {
      const cells = pending.slice(i, i + 2).map((g) => `    <td width="50%">
${picture(baseUrl, g, "100%")}
    </td>`);
      blocks.push(`<table>
  <tr>
${cells.join("\n")}
  </tr>
</table>`);
    }
    pending.length = 0;
  };
  for (const group2 of groups.values()) {
    const layout2 = group2[0].layout;
    if (layout2 !== "inline") flushInline();
    if (layout2 !== "half") flushHalves();
    if (layout2 === "half") pending.push(group2);
    else if (layout2 === "inline") inline.push(group2);
    else blocks.push(picture(baseUrl, group2, "100%"));
  }
  flushInline();
  flushHalves();
  return blocks.join("\n\n");
}

// src/core/types.ts
var CARD_IDS = ["stats", "languages", "3d", "grid", "repos", "hero", "stack", "socials"];

// src/action/config.ts
var ACTION_INPUT_DEFAULTS = {
  username: "",
  token: "",
  cards: "stats,3d,languages,repos",
  theme: "aurora",
  modes: "dark,light",
  animate: "true",
  history: "full",
  hide_languages: "",
  exclude_repos: "",
  include_private: "true",
  repos: "",
  config: "",
  output_dir: "profilescape",
  publish: "branch",
  branch: "profilescape-output",
  commit_message: "chore: update profilescape cards",
  readme: "",
  github_token: ""
};
var INPUT_NAMES = Object.keys(ACTION_INPUT_DEFAULTS);
var DEFAULT_CARDS = ["stats", "3d", "languages", "repos"];
var ConfigError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
};
var CARD_ALIASES = {
  landscape: "3d",
  "3d-graph": "3d",
  contributions: "3d",
  stat: "stats",
  overview: "stats",
  language: "languages",
  langs: "languages",
  "top-languages": "languages",
  repo: "repos",
  repositories: "repos",
  projects: "repos",
  banner: "hero",
  header: "hero",
  tech: "stack",
  "tech-stack": "stack",
  techstack: "stack",
  social: "socials",
  badges: "socials",
  "contribution-grid": "grid",
  heatmap: "grid",
  snake: "grid"
};
var CONFIG_KEYS = [
  "$schema",
  "theme",
  "colors",
  "darkColors",
  "lightColors",
  "cards",
  "modes",
  "animate",
  "history",
  "hideLanguages",
  "excludeRepos",
  "includePrivate",
  "repos",
  "options"
];
var LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
var HEX_RE = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
function splitList(value) {
  return value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_2, j) => i === 0 ? j : j === 0 ? i : 0));
  const at = (i, j) => d[i][j];
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, at(i - 2, j - 2) + 1);
      d[i][j] = v;
    }
  }
  return at(a.length, b.length);
}
function suggest(input, candidates) {
  const needle = input.toLowerCase();
  let best;
  for (const c of candidates) {
    const d = editDistance(needle, c.toLowerCase());
    if (d <= Math.max(1, Math.floor(c.length / 3)) && (!best || d < best.d)) best = { c, d };
  }
  return best?.c;
}
var hint = (input, candidates) => {
  const s = suggest(input, candidates);
  return s ? ` (did you mean "${s}"?)` : "";
};
function parseBool(value, field) {
  if (typeof value === "boolean") return value;
  const v = String(value).trim().toLowerCase();
  if (["true", "yes", "y", "on", "1"].includes(v)) return true;
  if (["false", "no", "n", "off", "0"].includes(v)) return false;
  throw new ConfigError(`${field} must be true or false, got "${String(value)}".`);
}
function toList(value, field) {
  if (Array.isArray(value)) {
    return value.flatMap((v) => {
      if (typeof v !== "string" && typeof v !== "number") throw new ConfigError(`${field} must be a list of strings.`);
      return String(v).split(/[\r\n]+/).map((s) => s.trim());
    }).filter(Boolean);
  }
  if (typeof value === "string") return splitList(value);
  throw new ConfigError(`${field} must be a list (array or comma-separated string).`);
}
var isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var camel = (key) => key.replace(/[-_]+([a-z0-9])/gi, (_, c) => c.toUpperCase());
function stripJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") {
        out += " ";
        i++;
      }
      i--;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) out += text[i] === "\n" || text[i] === "\r" ? text[i] : " ";
      i--;
    } else {
      out += ch;
    }
  }
  let result = "";
  inString = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (inString) {
      result += ch;
      if (ch === "\\") result += out[++i] ?? "";
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    if (ch === ",") {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === "}" || out[j] === "]") {
        result += " ";
        continue;
      }
    }
    result += ch;
  }
  return result;
}
function findJsonError(text) {
  let i = 0;
  function fail(reason) {
    throw { pos: i, reason };
  }
  function ws() {
    while (i < text.length && /\s/.test(text[i])) i++;
  }
  function str() {
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i++;
        return;
      }
      if (c === "\\") i += 2;
      else if (c < " ") fail("Line breaks are not allowed inside strings");
      else i++;
    }
    fail("Unterminated string");
  }
  function value() {
    ws();
    const ch = text[i];
    if (ch === void 0) fail("Unexpected end of JSON (is a closing bracket missing?)");
    if (ch === "{") {
      i++;
      ws();
      if (text[i] === "}") {
        i++;
        return;
      }
      for (; ; ) {
        ws();
        if (text[i] !== '"') fail("Expected a property name in double quotes");
        str();
        ws();
        if (text[i] !== ":") fail('Expected ":" after the property name');
        i++;
        value();
        const end = i;
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "}") {
          i++;
          return;
        } else {
          i = end;
          fail('Expected "," or "}" after this value (is a comma missing?)');
        }
      }
    }
    if (ch === "[") {
      i++;
      ws();
      if (text[i] === "]") {
        i++;
        return;
      }
      for (; ; ) {
        value();
        const end = i;
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "]") {
          i++;
          return;
        } else {
          i = end;
          fail('Expected "," or "]" after this list item (is a comma missing?)');
        }
      }
    }
    if (ch === '"') return str();
    const num = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (num) {
      i += num[0].length;
      return;
    }
    for (const lit of ["true", "false", "null"]) {
      if (text.startsWith(lit, i)) {
        i += lit.length;
        return;
      }
    }
    if (ch === "'") fail("Strings must use double quotes");
    if (/[A-Za-z_]/.test(ch)) fail('Unexpected text; strings must be in double quotes, e.g. "stats"');
    fail(`Unexpected character ${JSON.stringify(ch)}`);
  }
  try {
    value();
    ws();
    if (i < text.length) fail("Unexpected content after the end of the JSON object");
    return null;
  } catch (e) {
    if (typeof e === "object" && e !== null && "pos" in e) return e;
    throw e;
  }
}
function parseConfigJson(text, source = "config") {
  const original = text.replace(/^\uFEFF/, "");
  const clean2 = stripJsonc(original);
  if (!clean2.trim()) return {};
  try {
    return JSON.parse(clean2);
  } catch (err) {
    const fault = findJsonError(clean2);
    if (!fault) throw new ConfigError(`Invalid JSON in ${source}: ${err.message}`);
    const before = clean2.slice(0, fault.pos);
    const line = before.split("\n").length;
    const col = fault.pos - before.lastIndexOf("\n");
    const srcLine = (original.split("\n")[line - 1] ?? "").replace(/\r$/, "").replace(/\t/g, " ");
    const gutter = String(line);
    const frame = `
  ${gutter} | ${srcLine.slice(0, 120)}
  ${" ".repeat(gutter.length)} | ${" ".repeat(Math.max(0, Math.min(col - 1, 120)))}^`;
    throw new ConfigError(`Invalid JSON in ${source} at line ${line}, column ${col}: ${fault.reason}${frame}`);
  }
}
function normalizeCards(list, field) {
  const valid2 = CARD_IDS;
  const out = [];
  const unknown = [];
  for (const raw of list) {
    const key = raw.trim().toLowerCase();
    if (key === "all") {
      for (const id2 of CARD_IDS) if (!out.includes(id2)) out.push(id2);
      continue;
    }
    const id = valid2.includes(key) ? key : CARD_ALIASES[key];
    if (!id) unknown.push(raw);
    else if (!out.includes(id)) out.push(id);
  }
  if (unknown.length) {
    const details = unknown.map((u) => `"${u}"${hint(u, valid2)}`).join(", ");
    throw new ConfigError(`Unknown card${unknown.length > 1 ? "s" : ""} in ${field}: ${details}. Valid cards: ${CARD_IDS.join(", ")} (or "all").`);
  }
  if (!out.length) throw new ConfigError(`${field} must list at least one card. Valid cards: ${CARD_IDS.join(", ")}.`);
  return out;
}
function normalizeModes(list, field) {
  const out = [];
  for (const raw of list) {
    const key = raw.trim().toLowerCase();
    const modes = key === "dark" || key === "light" ? [key] : key === "both" || key === "auto" ? ["dark", "light"] : void 0;
    if (!modes) throw new ConfigError(`Unknown mode "${raw}" in ${field}. Use "dark", "light" or "dark,light".`);
    for (const m of modes) if (!out.includes(m)) out.push(m);
  }
  if (!out.length) throw new ConfigError(`${field} must contain "dark", "light" or both.`);
  return out;
}
function normalizeHistory(value, field) {
  const v = value.trim().toLowerCase();
  if (v === "full" || v === "all") return "full";
  if (v === "year" || v === "1y") return "year";
  throw new ConfigError(`${field} must be "full" or "year", got "${value}".`);
}
function normalizeTheme(value, field, warnings) {
  const id = value.trim().toLowerCase();
  const ids = themeIds();
  if (ids.includes(id)) return id;
  warnings.push(`Unknown theme "${value}" in ${field}${hint(id, ids)}; using "${DEFAULT_THEME}". Available themes: ${ids.join(", ")}.`);
  return DEFAULT_THEME;
}
function paletteKeys() {
  const base = getTheme(DEFAULT_THEME).dark;
  const colors = [];
  const numbers = [];
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === "string") colors.push(k);
    else if (typeof v === "number") numbers.push(k);
  }
  return { colors, numbers, syntax: Object.keys(base.syntax) };
}
function normalizeColor(value, field) {
  if (typeof value !== "string" || !HEX_RE.test(value.trim())) {
    throw new ConfigError(`${field} must be a hex colour like "#8B7CFF", got ${JSON.stringify(value)}.`);
  }
  const v = value.trim();
  return v.startsWith("#") ? v : `#${v}`;
}
function normalizePalette(value, field, warnings) {
  if (value === void 0 || value === null) return {};
  if (!isObject(value)) throw new ConfigError(`${field} must be an object of colours, e.g. { "accentA": "#FF7A59" }.`);
  const keys = paletteKeys();
  const all = [...keys.colors, ...keys.numbers, "syntax"];
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (keys.colors.includes(k)) out[k] = normalizeColor(v, `${field}.${k}`);
    else if (keys.numbers.includes(k)) {
      const num = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
      if (!Number.isFinite(num) || num < 0 || num > 1) throw new ConfigError(`${field}.${k} must be a number between 0 and 1.`);
      out[k] = num;
    } else if (k === "syntax") {
      if (!isObject(v)) throw new ConfigError(`${field}.syntax must be an object of colours.`);
      const syntax = {};
      for (const [sk, sv] of Object.entries(v)) {
        if (keys.syntax.includes(sk)) syntax[sk] = normalizeColor(sv, `${field}.syntax.${sk}`);
        else warnings.push(`Ignoring unknown colour "${field}.syntax.${sk}"${hint(sk, keys.syntax)}.`);
      }
      out.syntax = syntax;
    } else {
      warnings.push(`Ignoring unknown colour "${field}.${k}"${hint(k, all)}. Known colours: ${all.join(", ")}.`);
    }
  }
  return out;
}
var BOOL_WORDS = ["true", "false", "yes", "no", "y", "n", "on", "off", "1", "0"];
function checkOptionType(doc, value, field, warnings) {
  if (value === void 0 || value === null) return;
  const bad = (expected) => warnings.push(`${field} must be ${expected}, got ${JSON.stringify(value)}; the card uses its default.`);
  if (doc.type === "number") {
    const num = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
    if (!Number.isFinite(num)) bad("a number");
  } else if (doc.type === "boolean") {
    if (typeof value !== "boolean" && !(typeof value === "string" && BOOL_WORDS.includes(value.trim().toLowerCase()))) bad("true or false");
  } else if (doc.type === "list") {
    if (!Array.isArray(value) && typeof value !== "string") bad("a list");
  } else if (doc.type === "object") {
    if (!isObject(value)) bad("an object");
  } else if (typeof value !== "string" && typeof value !== "number") {
    bad("a string");
  }
}
function normalizeCardOptions(id, field, value, warnings) {
  const docs = CARDS[id]?.options ?? [];
  const keys = docs.map((d) => d.key);
  const out = {};
  for (const [rawKey, v] of Object.entries(value)) {
    const key = camel(rawKey.trim());
    const doc = docs.find((d) => d.key.toLowerCase() === key.toLowerCase());
    if (!doc) {
      warnings.push(`Ignoring unknown option "${field}.${rawKey}"${hint(key, keys)}. Options for ${id}: ${keys.join(", ") || "none"}.`);
      continue;
    }
    checkOptionType(doc, v, `${field}.${doc.key}`, warnings);
    out[doc.key] = v;
  }
  return out;
}
function normalizeOptions(value, warnings) {
  if (value === void 0 || value === null) return {};
  if (!isObject(value)) throw new ConfigError('options must be an object keyed by card id, e.g. { "repos": { "layout": "detail" } }.');
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = k.trim().toLowerCase();
    const id = CARD_IDS.includes(key) ? key : CARD_ALIASES[key];
    if (!id) {
      warnings.push(`Ignoring options for unknown card "${k}"${hint(key, CARD_IDS)}. Valid cards: ${CARD_IDS.join(", ")}.`);
      continue;
    }
    if (!isObject(v)) throw new ConfigError(`options.${k} must be an object.`);
    out[id] = { ...out[id] ?? {}, ...normalizeCardOptions(id, `options.${k}`, v, warnings) };
  }
  return out;
}
function isValidBranchName(name) {
  return name.length > 0 && name.length <= 200 && !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name) && !name.includes("..") && !name.includes("@{") && !name.includes("//") && !name.startsWith("/") && !name.endsWith("/") && !name.startsWith("-") && !name.endsWith(".") && !name.endsWith(".lock") && !name.split("/").some((part) => part.startsWith("."));
}
function resolveConfig(inputs, json, opts = {}) {
  const warnings = [];
  if (json !== void 0 && json !== null && !isObject(json)) {
    throw new ConfigError('The config must be a JSON object, e.g. { "theme": "aurora", "cards": ["stats", "3d"] }.');
  }
  const file = {};
  for (const [rawKey, value] of Object.entries(json ?? {})) {
    const key = rawKey === "$schema" ? rawKey : camel(rawKey);
    if (CONFIG_KEYS.includes(key)) file[key] = value;
    else if (key === "username" || key === "user" || key === "login") {
      warnings.push('"username" in the config JSON is ignored; set the username input (Action) or --user (CLI).');
    } else warnings.push(`Ignoring unknown config key "${rawKey}"${hint(key, CONFIG_KEYS)}.`);
  }
  const explicit = (name) => {
    const v = (inputs[name] ?? "").trim();
    if (!v) return void 0;
    if (opts.ignoreDefaultInputs) {
      const norm2 = (s) => s.replace(/\s+/g, "").toLowerCase();
      if (norm2(v) === norm2(opts.inputDefaults?.[name] ?? ACTION_INPUT_DEFAULTS[name])) return void 0;
    }
    return v;
  };
  const has = (key) => file[key] !== void 0 && file[key] !== null;
  const sources = {};
  const overridden = [];
  function pick(key, input, fromInput, fromConfig, fallback) {
    const v = explicit(input);
    if (v !== void 0) {
      sources[key] = "input";
      if (has(key)) overridden.push(key);
      return fromInput(v, opts.inputLabel ? opts.inputLabel(input) : `the ${input} input`);
    }
    if (has(key)) {
      sources[key] = "config";
      return fromConfig(file[key], `config.${key}`);
    }
    sources[key] = "default";
    return fallback;
  }
  const cards = pick(
    "cards",
    "cards",
    (v, f) => normalizeCards(splitList(v.replace(/\s+/g, ",")), f),
    (v, f) => normalizeCards(toList(v, f), f),
    [...DEFAULT_CARDS]
  );
  const theme = pick(
    "theme",
    "theme",
    (v, f) => normalizeTheme(v, f, warnings),
    (v, f) => {
      if (typeof v !== "string") throw new ConfigError(`${f} must be a string (a theme id).`);
      return normalizeTheme(v, f, warnings);
    },
    DEFAULT_THEME
  );
  const modes = pick(
    "modes",
    "modes",
    (v, f) => normalizeModes(splitList(v.replace(/\s+/g, ",")), f),
    (v, f) => normalizeModes(toList(v, f), f),
    ["dark", "light"]
  );
  const animate = pick("animate", "animate", parseBool, parseBool, true);
  const history = pick(
    "history",
    "history",
    normalizeHistory,
    (v, f) => normalizeHistory(String(v), f),
    "full"
  );
  const hideLanguages = pick("hideLanguages", "hide_languages", (v) => splitList(v), toList, []);
  const excludeRepos = pick("excludeRepos", "exclude_repos", (v) => splitList(v), toList, []);
  const includePrivate = pick("includePrivate", "include_private", parseBool, parseBool, true);
  const repos = pick("repos", "repos", (v) => splitList(v), toList, []);
  for (const r of repos) {
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$|^[A-Za-z0-9._-]+$/.test(r)) {
      throw new ConfigError(`Invalid repository "${r}" in repos. Use "name" (your own repo) or "owner/name".`);
    }
  }
  const colors = normalizePalette(file.colors, "colors", warnings);
  const darkColors = normalizePalette(file.darkColors, "darkColors", warnings);
  const lightColors = normalizePalette(file.lightColors, "lightColors", warnings);
  const options = normalizeOptions(file.options, warnings);
  for (const id of Object.keys(options)) {
    if (!cards.includes(id)) warnings.push(`options.${id} is set but the "${id}" card is not enabled (cards: ${cards.join(", ")}).`);
  }
  const username = ((inputs.username ?? "").trim() || (opts.defaultUsername ?? "").trim()).replace(/^@/, "");
  if (username && !LOGIN_RE.test(username)) {
    throw new ConfigError(`"${username}" is not a valid GitHub username.`);
  }
  if (!username && (opts.requireUsername ?? true)) {
    throw new ConfigError("No username: set the username input (it defaults to the repository owner when running in GitHub Actions).");
  }
  const token = (inputs.token ?? "").trim();
  const publishRaw = (inputs.publish ?? "").trim().toLowerCase() || "branch";
  const publish = ["branch", "true", "yes", "on"].includes(publishRaw) ? "branch" : ["none", "false", "no", "off"].includes(publishRaw) ? "none" : void 0;
  if (!publish) throw new ConfigError(`publish must be "branch" or "none", got "${inputs.publish}".`);
  const branch = (inputs.branch ?? "").trim() || ACTION_INPUT_DEFAULTS.branch;
  if (!isValidBranchName(branch)) throw new ConfigError(`"${branch}" is not a valid branch name.`);
  const outputDir = (inputs.output_dir ?? "").trim() || ACTION_INPUT_DEFAULTS.output_dir;
  return {
    config: { username, cards, theme, colors, darkColors, lightColors, modes, animate, hideLanguages, excludeRepos, includePrivate, repos, options },
    settings: {
      token,
      githubToken: (inputs.github_token ?? "").trim(),
      history,
      outputDir,
      publish,
      branch,
      commitMessage: (inputs.commit_message ?? "").trim() || ACTION_INPUT_DEFAULTS.commit_message,
      readme: (inputs.readme ?? "").trim()
    },
    warnings,
    sources,
    overridden
  };
}

// src/action/io.ts
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
function getInput(name, env = process.env) {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}
function readInputs(env = process.env) {
  const out = {};
  for (const name of INPUT_NAMES) out[name] = getInput(name, env);
  return out;
}
function escapeData(value) {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function escapeProperty(value) {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}
function command(name, message, props = {}) {
  const entries = Object.entries(props).filter(([, v]) => v !== void 0 && v !== "");
  const propText = entries.length ? ` ${entries.map(([k, v]) => `${k}=${escapeProperty(String(v))}`).join(",")}` : "";
  return `::${name}${propText}::${escapeData(message)}`;
}
function formatKeyValue(name, value, delimiter = `ghadelimiter_${randomUUID()}`) {
  if (name.includes(delimiter) || value.includes(delimiter)) {
    throw new Error(`Output "${name}" contains its own delimiter; refusing to write it.`);
  }
  return `${name}<<${delimiter}
${value}
${delimiter}
`;
}
function neutralizeCommands(message) {
  return message.replace(/^(\s*):(?=:)/gm, "$1:\u200B");
}
function actionsLogger(write = (l) => process.stdout.write(`${l}
`), env = process.env) {
  return {
    info: (m) => write(neutralizeCommands(m)),
    debug: (m) => {
      if (env.RUNNER_DEBUG === "1" || env.ACTIONS_STEP_DEBUG === "true") write(command("debug", m));
    },
    warning: (m, p = {}) => write(command("warning", m, p)),
    error: (m, p = {}) => write(command("error", m, p)),
    group: (name) => write(command("group", name)),
    endGroup: () => write("::endgroup::"),
    mask: (secret) => {
      for (const line of secret.split(/\r?\n/)) if (line.trim()) write(command("add-mask", line.trim()));
    }
  };
}
function actionsOutputs(env = process.env, log) {
  return {
    set(name, value) {
      const file = env.GITHUB_OUTPUT;
      if (file) appendFileSync(file, formatKeyValue(name, value), "utf8");
      else log?.debug(`output ${name}=${value}`);
    },
    summary(markdown) {
      const file = env.GITHUB_STEP_SUMMARY;
      if (file) appendFileSync(file, markdown.endsWith("\n") ? markdown : `${markdown}
`, "utf8");
    }
  };
}
function loadConfigText(value, workspace, where = "action") {
  const v = value.trim();
  if (!v) return null;
  if (v.startsWith("{")) return { text: v, source: where === "cli" ? "--config" : "config input" };
  const path = isAbsolute(v) ? v : resolve(workspace, v);
  if (!existsSync(path)) {
    throw new ConfigError(
      where === "cli" ? `Config file "${v}" was not found (looked in ${path}). Paths are relative to the current directory; you can also pass the JSON inline.` : `Config file "${v}" was not found (looked in ${path}). Paths are relative to the repository root; make sure the workflow runs actions/checkout before Profilescape, or pass the JSON inline.`
    );
  }
  return { text: readFileSync(path, "utf8"), source: v };
}
function parseActionDefaults(yaml) {
  const out = {};
  const names = new Set(INPUT_NAMES);
  let inInputs = false;
  let current;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inInputs = /^inputs:\s*$/.test(line);
      current = void 0;
      continue;
    }
    if (!inInputs) continue;
    const input = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (input) {
      current = names.has(input[1]) ? input[1] : void 0;
      continue;
    }
    const def = /^ {4}default:\s*(.*?)\s*$/.exec(line);
    if (current && def) {
      const raw = def[1];
      let value = raw;
      if (raw.startsWith('"')) {
        try {
          value = JSON.parse(raw);
        } catch {
          continue;
        }
      } else if (raw.startsWith("'") && raw.endsWith("'")) value = raw.slice(1, -1).replace(/''/g, "'");
      out[current] = value;
    }
  }
  return out;
}
function runningActionDefaults(env) {
  const dir = env.GITHUB_ACTION_PATH;
  if (!dir) return void 0;
  for (const name of ["action.yml", "action.yaml"]) {
    try {
      return parseActionDefaults(readFileSync(join(dir, name), "utf8"));
    } catch {
    }
  }
  return void 0;
}
function displayPath(path, workspace) {
  const rel = relative(workspace, path);
  const out = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
  return out.split("\\").join("/");
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
function writeFiles(outDir, files) {
  const root = resolve(outDir);
  mkdirSync(root, { recursive: true });
  const written = [];
  for (const f of files) {
    const target = resolve(join(root, f.path));
    if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) {
      throw new Error(`Refusing to write "${f.path}" outside ${root}.`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content, "utf8");
    written.push(target);
  }
  return written;
}

// src/action/publish.ts
import { createHash } from "node:crypto";
var PublishError = class extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.name = "PublishError";
    this.status = status;
  }
};
var DEFAULT_API = "https://api.github.com";
var DEFAULT_SERVER = "https://github.com";
var encodeRef = (ref) => ref.split("/").map(encodeURIComponent).join("/");
function rawBaseUrl(repository, branch, serverUrl = DEFAULT_SERVER) {
  const server = serverUrl.replace(/\/+$/, "");
  let host = "";
  try {
    host = new URL(server).hostname.toLowerCase();
  } catch {
    host = "github.com";
  }
  if (host === "github.com" || host === "www.github.com") return `https://raw.githubusercontent.com/${repository}/${encodeRef(branch)}`;
  return `${server}/${repository}/raw/${encodeRef(branch)}`;
}
function branchWebUrl(repository, branch, serverUrl = DEFAULT_SERVER) {
  return `${serverUrl.replace(/\/+$/, "")}/${repository}/tree/${encodeRef(branch)}`;
}
var toBytes = (c) => typeof c === "string" ? Buffer.from(c, "utf8") : Buffer.from(c);
function gitBlobSha(content2) {
  const bytes = toBytes(content2);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
function gitTreeSha(files) {
  if (files.some((f) => f.path.includes("/") || !f.path)) return null;
  const sorted = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const parts2 = [];
  for (const f of sorted) parts2.push(Buffer.from(`100644 ${f.path}\0`, "utf8"), Buffer.from(f.sha, "hex"));
  const body = Buffer.concat(parts2);
  return createHash("sha1").update(`tree ${body.length}\0`).update(body).digest("hex");
}
function withSkipCi(message) {
  return /\[(skip ci|ci skip|no ci|skip actions|actions skip)\]/i.test(message) ? message : `${message.trim()} [skip ci]`;
}
var sleep2 = (ms) => ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
function describeFailure(status, body, action, ctx) {
  let message = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body);
    if (parsed.message) message = parsed.message;
  } catch {
  }
  const permissions = 'Grant the workflow write access by adding this to the workflow (or the job):\n\n  permissions:\n    contents: write\n\nor pass a github_token (e.g. a fine-grained PAT with "Contents: Read and write") that can push to the repository.';
  if (status === 401) {
    return `GitHub rejected github_token (401) while trying to ${action}. The token is invalid or has expired.`;
  }
  if (status === 403 && /rate limit/i.test(message)) {
    return `GitHub API rate limit reached while trying to ${action}: ${message}. Try again later.`;
  }
  if (status === 403) {
    return `GitHub refused to ${action} in ${ctx.repository} (403: ${message}).
${permissions}`;
  }
  if (status === 404) {
    return `GitHub could not ${action}: ${ctx.repository} was not found or github_token cannot access it (404).
${permissions}`;
  }
  if (status === 409 && /empty/i.test(message)) {
    return `Cannot ${action}: ${ctx.repository} has no commits yet. Push an initial commit first.`;
  }
  if (status === 422 && /protect/i.test(message)) {
    return `Cannot ${action}: branch "${ctx.branch}" is protected (${message}). Use a dedicated branch input such as "profilescape-output".`;
  }
  return `GitHub API responded ${status} while trying to ${action}: ${message}`;
}
function restClient(o) {
  const doFetch = o.fetchImpl ?? fetch;
  const root = (o.apiUrl || DEFAULT_API).replace(/\/+$/, "");
  const baseDelay = o.retryDelayMs ?? 600;
  return {
    async call(method, path, action, body, okStatuses = []) {
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await sleep2(baseDelay * 2 ** (attempt - 1));
        let res;
        try {
          res = await doFetch(`${root}${path}`, {
            method,
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${o.token}`,
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "profilescape",
              ...body === void 0 ? {} : { "Content-Type": "application/json" }
            },
            body: body === void 0 ? void 0 : JSON.stringify(body)
          });
        } catch (err) {
          lastError = new PublishError(`Network error while trying to ${action}: ${err.message}`);
          continue;
        }
        const text = await res.text();
        if (res.status >= 500) {
          lastError = new PublishError(describeFailure(res.status, text, action, { repository: o.repository, branch: o.branch }), res.status);
          continue;
        }
        if (!res.ok && !okStatuses.includes(res.status)) {
          throw new PublishError(describeFailure(res.status, text, action, { repository: o.repository, branch: o.branch }), res.status);
        }
        let data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
        }
        return { status: res.status, data };
      }
      throw lastError instanceof Error ? lastError : new PublishError(String(lastError));
    }
  };
}
async function assertReplaceable(api, repoPath, o, marker, commit) {
  const advice = `Publishing replaces the whole branch with a single commit of SVG files, so Profilescape only writes to a dedicated branch. Set the "branch" input to a new name such as "profilescape-output" (the default)`;
  const repo = await api.call("GET", repoPath, "read the repository settings");
  if (repo.data && repo.data.default_branch === o.branch) {
    throw new PublishError(
      `Refusing to publish to "${o.branch}": it is the default branch of ${o.repository}. ${advice}, and use the "readme" input to keep your README up to date.`
    );
  }
  let reason = (commit.parents ?? []).length ? "its latest commit has history" : "";
  if (!reason) {
    const tree = await api.call(
      "GET",
      `${repoPath}/git/trees/${commit.tree.sha}`,
      `read the files on "${o.branch}"`
    );
    if (!(tree.data?.tree ?? []).some((e) => e.path === marker && e.type === "blob")) reason = `it has no ${marker}`;
  }
  if (reason) {
    throw new PublishError(
      `Branch "${o.branch}" already exists and was not created by Profilescape (${reason}). ${advice}, or delete "${o.branch}" first if its contents are disposable.`
    );
  }
}
async function mapLimit2(items2, limit, fn) {
  const out = new Array(items2.length);
  let next = 0;
  const worker = async () => {
    while (next < items2.length) {
      const i = next++;
      out[i] = await fn(items2[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items2.length) }, worker));
  return out;
}
async function publishToBranch(o) {
  const log = o.log ?? (() => {
  });
  const [owner, repo, extra] = o.repository.split("/");
  if (!owner || !repo || extra !== void 0) {
    throw new PublishError(`Invalid repository "${o.repository}"; expected "owner/repo".`);
  }
  if (!o.files.length) throw new PublishError("Nothing to publish: no files were rendered.");
  const seen = /* @__PURE__ */ new Set();
  for (const f of o.files) {
    if (seen.has(f.path)) throw new PublishError(`Duplicate file path "${f.path}" in publish set.`);
    seen.add(f.path);
  }
  const api = restClient(o);
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const ref = encodeRef(o.branch);
  const baseUrl = rawBaseUrl(o.repository, o.branch, o.serverUrl);
  const branchUrl = branchWebUrl(o.repository, o.branch, o.serverUrl);
  const marker = o.markerFile ?? "README-snippet.md";
  const readHead = async () => {
    const current = await api.call(
      "GET",
      `${repoPath}/git/ref/heads/${ref}`,
      `read branch "${o.branch}"`,
      void 0,
      [404]
    );
    const sha = current.status === 200 && !Array.isArray(current.data) ? current.data?.object?.sha : void 0;
    if (!sha) return void 0;
    const commit2 = await api.call("GET", `${repoPath}/git/commits/${sha}`, `read the latest commit of "${o.branch}"`);
    return { ...commit2.data, sha };
  };
  const head = await readHead();
  const headSha = head?.sha;
  const existingTree = head?.tree.sha;
  const local = o.files.map((f) => ({ path: f.path, sha: gitBlobSha(f.content), content: f.content }));
  const localTree = gitTreeSha(local);
  if (headSha && existingTree && localTree === existingTree) {
    log(`Branch "${o.branch}" is already up to date (tree ${existingTree.slice(0, 7)}); nothing to publish.`);
    return { status: "unchanged", commitSha: headSha, treeSha: existingTree, baseUrl, branchUrl };
  }
  if (head) await assertReplaceable(api, repoPath, o, marker, head);
  const unique = [...new Map(local.map((f) => [f.sha, f])).values()];
  const uploaded = /* @__PURE__ */ new Map();
  await mapLimit2(unique, o.concurrency ?? 4, async (f) => {
    const res = await api.call("POST", `${repoPath}/git/blobs`, `upload ${f.path}`, {
      content: toBytes(f.content).toString("base64"),
      encoding: "base64"
    });
    uploaded.set(f.sha, res.data.sha);
  });
  const tree = await api.call("POST", `${repoPath}/git/trees`, "create the file tree", {
    tree: local.map((f) => ({ path: f.path, mode: "100644", type: "blob", sha: uploaded.get(f.sha) ?? f.sha })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  });
  const treeSha = tree.data.sha;
  if (headSha && existingTree === treeSha) {
    log(`Branch "${o.branch}" is already up to date (tree ${treeSha.slice(0, 7)}); nothing to publish.`);
    return { status: "unchanged", commitSha: headSha, treeSha, baseUrl, branchUrl };
  }
  const commit = await api.call("POST", `${repoPath}/git/commits`, "create the commit", {
    message: withSkipCi(o.message),
    tree: treeSha,
    parents: []
  });
  const commitSha = commit.data.sha;
  const update = () => api.call("PATCH", `${repoPath}/git/refs/heads/${ref}`, `update branch "${o.branch}"`, { sha: commitSha, force: true });
  if (headSha) {
    await update();
    log(`Updated branch "${o.branch}" -> ${commitSha.slice(0, 7)}.`);
    return { status: "updated", commitSha, treeSha, baseUrl, branchUrl };
  }
  const created = await api.call(
    "POST",
    `${repoPath}/git/refs`,
    `create branch "${o.branch}"`,
    { ref: `refs/heads/${o.branch}`, sha: commitSha },
    [422]
  );
  if (created.status === 422) {
    const message = created.data?.message ?? "";
    if (!/already exists/i.test(message)) {
      throw new PublishError(describeFailure(422, JSON.stringify({ message }), `create branch "${o.branch}"`, o), 422);
    }
    const raced = await readHead();
    if (raced) await assertReplaceable(api, repoPath, o, marker, raced);
    await update();
    log(`Updated branch "${o.branch}" -> ${commitSha.slice(0, 7)}.`);
    return { status: "updated", commitSha, treeSha, baseUrl, branchUrl };
  }
  log(`Created branch "${o.branch}" at ${commitSha.slice(0, 7)}.`);
  return { status: "created", commitSha, treeSha, baseUrl, branchUrl };
}

// src/action/readme.ts
var START_MARKER = "<!-- profilescape:start -->";
var END_MARKER = "<!-- profilescape:end -->";
var START_RE = /<!--\s*profilescape:start\s*-->/i;
var END_RE = /<!--\s*profilescape:end\s*-->/i;
function wrapWithMarkers(markup, eol = "\n") {
  const body = markup.replace(/\r\n?/g, "\n").trim();
  const lines = body ? [START_MARKER, "", body, "", END_MARKER] : [START_MARKER, END_MARKER];
  return lines.join("\n").split("\n").join(eol);
}
function replaceBetweenMarkers(content2, markup) {
  const start = START_RE.exec(content2);
  if (!start) return { content: content2, status: END_RE.test(content2) ? "misordered-markers" : "missing-markers" };
  const afterStart = start.index + start[0].length;
  const endRel = END_RE.exec(content2.slice(afterStart));
  if (!endRel) return { content: content2, status: END_RE.test(content2.slice(0, start.index)) ? "misordered-markers" : "missing-markers" };
  const endIndex = afterStart + endRel.index;
  const eol = content2.includes("\r\n") ? "\r\n" : "\n";
  const body = markup.replace(/\r\n?/g, "\n").trim();
  const inner = body ? `${eol}${eol}${body.split("\n").join(eol)}${eol}${eol}` : eol;
  const next = `${content2.slice(0, afterStart)}${inner}${content2.slice(endIndex)}`;
  return { content: next, status: next === content2 ? "unchanged" : "updated" };
}
function missingMarkersHelp(path) {
  return `${path} has no Profilescape markers, so it was not changed. Add these two lines where the cards should appear and the next run will fill them in:

${START_MARKER}
${END_MARKER}`;
}
function normalizeRepoPath(path) {
  return path.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
}
async function updateReadme(o) {
  const [owner, repo] = o.repository.split("/");
  if (!owner || !repo) throw new PublishError(`Invalid repository "${o.repository}"; expected "owner/repo".`);
  const path = normalizeRepoPath(o.path);
  if (!path || path.split("/").includes("..")) throw new PublishError(`Invalid readme path "${o.path}".`);
  const api = restClient({ ...o, branch: o.branch });
  const url = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const query = o.branch ? `?ref=${encodeURIComponent(o.branch)}` : "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await api.call("GET", `${url}${query}`, `read ${path}`, void 0, [404]);
    if (res.status === 404) {
      throw new PublishError(`README "${path}" was not found in ${o.repository}. Check the readme input (paths are relative to the repository root).`, 404);
    }
    const file = res.data;
    if (Array.isArray(file) || file.type !== "file") throw new PublishError(`readme input "${path}" is not a file.`);
    if (file.encoding !== "base64" || typeof file.content !== "string") {
      throw new PublishError(`${path} is too large to update through the contents API (over 1 MB).`);
    }
    const current = Buffer.from(file.content, "base64").toString("utf8");
    const result = replaceBetweenMarkers(current, o.markup);
    if (result.status !== "updated") return { status: result.status, path };
    const put = await api.call(
      "PUT",
      url,
      `update ${path}`,
      {
        message: withSkipCi(o.message),
        content: Buffer.from(result.content, "utf8").toString("base64"),
        sha: file.sha,
        ...o.branch ? { branch: o.branch } : {}
      },
      [409]
    );
    if (put.status === 409) {
      o.log?.(`${path} changed while updating; retrying.`);
      continue;
    }
    o.log?.(`Updated ${path}.`);
    return { status: "updated", path, commitSha: put.data?.commit?.sha };
  }
  throw new PublishError(`${path} kept changing while Profilescape tried to update it; it will be retried on the next run.`, 409);
}

// src/action/main.ts
var PROJECT_URL = "https://github.com/chethandvg/profilescape";
var SNIPPET_FILE = "README-snippet.md";
function snippetDocument(markup) {
  return `${wrapWithMarkers(markup)}
`;
}
function branchReadme(login, files, markup) {
  return [
    "# Profilescape cards",
    "",
    `Generated by [Profilescape](${PROJECT_URL}) for [@${login}](https://github.com/${login}).`,
    "This branch is rewritten by every run as a single commit with no history, so please do not edit it by hand.",
    "",
    "## Preview",
    "",
    readmeMarkup(files, "."),
    "",
    "## Use in a README",
    "",
    `Paste this where the cards should appear. Keep the markers if you want the \`readme\` input to keep it up to date.`,
    "",
    "```html",
    wrapWithMarkers(markup),
    "```",
    ""
  ].join("\n");
}
function friendlyError(err) {
  if (err instanceof ConfigError || err instanceof PublishError) return err.message;
  if (err instanceof GitHubError) {
    if (err.status === 401) {
      return `${err.message}
The "token" input is used to read your profile. If it comes from a secret such as PROFILESCAPE_TOKEN, the personal access token has probably expired or been revoked: create a new one and update the secret, or remove the "token" input to fall back to the workflow token (public data only).`;
    }
    if (err.type === "ORGANIZATION") {
      return `${err.message}
The "username" input defaults to the repository owner; in an organization's repository, set it to your personal login.`;
    }
    if (err.status === 404) return `${err.message}
Check the "username" input (it defaults to the repository owner).`;
    if (err.status === 403 || err.status === 429) {
      return `${err.message}
If this is a rate limit, the next scheduled run will succeed; otherwise check that the "token" input can read the profile.`;
    }
    return err.message;
  }
  const e = err;
  return `Unexpected error: ${e?.stack ?? String(err)}
Please report this at ${PROJECT_URL}/issues`;
}
function repositoryIsPrivate(env) {
  if (!env.GITHUB_EVENT_PATH) return false;
  try {
    const event = JSON.parse(readFileSync2(env.GITHUB_EVENT_PATH, "utf8"));
    return event.repository?.private === true;
  } catch {
    return false;
  }
}
function graphqlUrl(env) {
  if (env.GITHUB_GRAPHQL_URL) return env.GITHUB_GRAPHQL_URL;
  const api = env.GITHUB_API_URL?.replace(/\/+$/, "");
  if (!api || api === "https://api.github.com") return void 0;
  return api.replace(/\/v3$/, "") + "/graphql";
}
function describeConfig(r) {
  const { config: c, settings: s, sources } = r;
  const src = (k) => sources[k] === "default" ? "" : `  (${sources[k]}${r.overridden.includes(k) ? `; overrides config.${k}` : ""})`;
  const list = (v) => v.length ? v.join(", ") : "-";
  return [
    `username         ${c.username}`,
    `cards            ${c.cards.join(", ")}${src("cards")}`,
    `theme            ${c.theme}${src("theme")}`,
    `modes            ${c.modes.join(", ")}${src("modes")}`,
    `animate          ${c.animate}${src("animate")}`,
    `history          ${s.history}${src("history")}`,
    `include_private  ${c.includePrivate}${src("includePrivate")}`,
    `hide_languages   ${list(c.hideLanguages)}${src("hideLanguages")}`,
    `exclude_repos    ${list(c.excludeRepos)}${src("excludeRepos")}`,
    `repos            ${list(c.repos)}${src("repos")}`,
    `output_dir       ${s.outputDir}`,
    `publish          ${s.publish === "branch" ? `branch "${s.branch}"` : "none"}`,
    `readme           ${s.readme || "-"}`
  ];
}
function summaryMarkdown(args) {
  const { files, publish } = args;
  const images = new Set(files.map((f) => f.name)).size;
  const where = publish ? ` and published them to [\`${args.branch}\`](${publish.branchUrl}) (${publish.status === "unchanged" ? "no changes since the last run" : publish.status})` : "";
  const readmeLine = args.readme?.status === "updated" ? `

Updated \`${args.readme.path}\` between the Profilescape markers.` : args.readme?.status === "unchanged" ? `

\`${args.readme.path}\` is already up to date.` : args.readme ? `

> [!WARNING]
> \`${args.readme.path}\` has no \`${START_MARKER}\` / \`${END_MARKER}\` markers, so it was not changed.` : "";
  const table = files.map((f, i) => `| \`${args.displayed[i] ?? f.path}\` | ${f.card} | ${f.mode} | ${formatBytes(new TextEncoder().encode(f.svg).length)} |`);
  return [
    "## Profilescape",
    "",
    `Rendered **${images}** ${images === 1 ? "image" : "images"} (${files.length} files) for [@${args.login}](https://github.com/${args.login}) with the **${getTheme(args.theme).label}** theme${where}.${readmeLine}`,
    "",
    ...publish ? [args.markup, ""] : [],
    "<details><summary>README snippet</summary>",
    "",
    "```html",
    wrapWithMarkers(args.markup),
    "```",
    "",
    "</details>",
    "",
    "<details><summary>Files</summary>",
    "",
    "| File | Card | Mode | Size |",
    "| --- | --- | --- | --- |",
    ...table,
    "",
    "</details>",
    ""
  ].join("\n");
}
async function run(deps = {}) {
  const env = deps.env ?? process.env;
  const baseLog = deps.log ?? actionsLogger(void 0, env);
  let groupOpen = false;
  const log = {
    ...baseLog,
    group: (name) => {
      if (groupOpen) baseLog.endGroup();
      baseLog.group(name);
      groupOpen = true;
    },
    endGroup: () => {
      if (groupOpen) baseLog.endGroup();
      groupOpen = false;
    }
  };
  const outputs = deps.outputs ?? actionsOutputs(env, log);
  const workspace = resolve2(env.GITHUB_WORKSPACE || deps.cwd || process.cwd());
  const fetchProfile2 = deps.fetchProfile ?? fetchProfile;
  const now = deps.now ?? /* @__PURE__ */ new Date();
  try {
    const inputs = readInputs(env);
    for (const secret of [inputs.token, inputs.github_token]) if (secret) log.mask(secret);
    const loaded = loadConfigText(inputs.config ?? "", workspace);
    const json = loaded ? parseConfigJson(loaded.text, loaded.source) : void 0;
    const resolved = resolveConfig(inputs, json, {
      defaultUsername: env.GITHUB_REPOSITORY_OWNER,
      ignoreDefaultInputs: true,
      // A single-purpose mirror declares its own cards default; it must count as "not set" too.
      inputDefaults: runningActionDefaults(env)
    });
    const { config, settings } = resolved;
    for (const w of resolved.warnings) log.warning(w, { title: "Profilescape config" });
    log.group("Configuration");
    if (loaded) log.info(`config           ${loaded.source}`);
    for (const line of describeConfig(resolved)) log.info(line);
    log.endGroup();
    if (!settings.token) {
      throw new ConfigError('No token: the "token" input is empty. It defaults to ${{ github.token }}; if you overrode it, check that the secret exists.');
    }
    const repository = env.GITHUB_REPOSITORY ?? "";
    if ((settings.publish === "branch" || settings.readme) && !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
      throw new ConfigError(
        'GITHUB_REPOSITORY is not set, so there is nowhere to publish. Run inside GitHub Actions, or set "publish: none" (and no "readme") to only write files.'
      );
    }
    if ((settings.publish === "branch" || settings.readme) && !settings.githubToken) {
      throw new ConfigError(
        'No github_token: the "github_token" input is empty, but publishing and README updates need it. It defaults to ${{ github.token }}; if you overrode it, check that the secret exists and is spelled correctly. The "token" input is only ever used to read.'
      );
    }
    log.group(`Fetching GitHub data for @${config.username}`);
    const workflowToken = settings.token.startsWith("ghs_");
    if (config.includePrivate && workflowToken) {
      log.info(
        'Using the workflow token, which sees public activity only. To include private contributions, pass a personal access token as the "token" input.'
      );
    }
    if (!config.includePrivate && !workflowToken) {
      log.warning(
        'include_private is false, so private repositories are left out of repository and language statistics. Contribution counts (calendar, totals and streaks) still include the private contributions this token can see. For public contribution counts only, remove the "token" input to use the workflow token.',
        { title: "Private contributions are still counted" }
      );
    }
    const data = await fetchProfile2({
      token: settings.token,
      login: config.username,
      history: settings.history,
      includePrivate: config.includePrivate,
      hideLanguages: config.hideLanguages,
      excludeRepos: config.excludeRepos,
      extraRepos: config.repos,
      now,
      apiUrl: graphqlUrl(env),
      log: (m) => log.info(m)
    });
    const totalAllTime = data.calendar.reduce((s, d) => s + d.count, 0);
    log.info(
      `@${data.login}: ${compact(data.year.contributions)} contributions in the last year` + (settings.history === "full" ? `, ${compact(totalAllTime)} all-time` : "") + `, ${data.repos.length} repositories, ${data.languages.length} languages.`
    );
    log.endGroup();
    log.group("Rendering cards");
    const files = renderCards({
      data,
      cards: config.cards,
      theme: config.theme,
      colors: config.colors,
      darkColors: config.darkColors,
      lightColors: config.lightColors,
      modes: config.modes,
      options: config.options,
      animate: config.animate,
      now
    });
    if (!files.length) throw new ConfigError("The selected cards produced no images.");
    const width = Math.max(...files.map((f) => f.path.length)) + 2;
    for (const f of files) log.info(`${f.path.padEnd(width)}${formatBytes(new TextEncoder().encode(f.svg).length).padStart(9)}`);
    log.endGroup();
    const outDir = resolve2(workspace, settings.outputDir);
    const relOut = relative2(workspace, outDir).split("\\").join("/");
    const baseUrl = settings.publish === "branch" ? rawBaseUrl(repository, settings.branch, env.GITHUB_SERVER_URL) : relOut && !relOut.startsWith("..") ? relOut : ".";
    const markup = readmeMarkup(files, baseUrl);
    const snippet = snippetDocument(markup);
    const written = writeFiles(outDir, [...files.map((f) => ({ path: f.path, content: f.svg })), { path: SNIPPET_FILE, content: snippet }]);
    const displayed = written.map((p) => displayPath(p, workspace));
    log.info(`Wrote ${written.length} files to ${displayPath(outDir, workspace) || "."}`);
    let published;
    if (settings.publish === "branch") {
      log.group(`Publishing to ${repository}@${settings.branch}`);
      published = await publishToBranch({
        token: settings.githubToken,
        repository,
        branch: settings.branch,
        message: settings.commitMessage,
        files: [
          ...files.map((f) => ({ path: f.path, content: f.svg })),
          { path: SNIPPET_FILE, content: snippet },
          { path: "README.md", content: branchReadme(data.login, files, markup) }
        ],
        apiUrl: env.GITHUB_API_URL,
        serverUrl: env.GITHUB_SERVER_URL,
        fetchImpl: deps.fetchImpl,
        retryDelayMs: deps.retryDelayMs,
        markerFile: SNIPPET_FILE,
        log: (m) => log.info(m)
      });
      log.info(`Cards are served from ${published.baseUrl}`);
      if (repositoryIsPrivate(env)) {
        log.warning(
          `${repository} is private, so visitors cannot load images from ${published.baseUrl}. Run Profilescape in a public repository (such as your ${env.GITHUB_REPOSITORY_OWNER ?? "username"}/${env.GITHUB_REPOSITORY_OWNER ?? "username"} profile repository).`,
          { title: "Images will not be visible" }
        );
      }
      log.endGroup();
    }
    let readme;
    if (settings.readme) {
      log.group(`Updating ${settings.readme}`);
      readme = await updateReadme({
        token: settings.githubToken,
        repository,
        path: settings.readme,
        markup,
        message: settings.commitMessage,
        apiUrl: env.GITHUB_API_URL,
        fetchImpl: deps.fetchImpl,
        retryDelayMs: deps.retryDelayMs,
        log: (m) => log.info(m)
      });
      if (readme.status === "unchanged") log.info(`${readme.path} is already up to date.`);
      else if (readme.status === "missing-markers") log.warning(missingMarkersHelp(readme.path), { title: "README not updated" });
      else if (readme.status === "misordered-markers") {
        log.warning(`${readme.path}: "${END_MARKER}" must come after "${START_MARKER}". The README was not changed.`, { title: "README not updated" });
      }
      log.endGroup();
    }
    outputs.summary(summaryMarkdown({ login: data.login, theme: config.theme, files, markup, displayed, publish: published, branch: settings.branch, readme }));
    outputs.set("files", JSON.stringify(displayed));
    outputs.set("markup", markup);
    outputs.set("base_url", baseUrl);
    if (settings.publish === "none" && !settings.readme) {
      log.info(`Done. Commit ${displayPath(outDir, workspace) || "."} to your repository, or paste ${SNIPPET_FILE} into your README.`);
    } else {
      log.info("Done.");
    }
    return 0;
  } catch (err) {
    log.endGroup();
    log.error(friendlyError(err), { title: "Profilescape failed" });
    return 1;
  }
}
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isEntryPoint()) {
  process.exitCode = await run();
}
export {
  PROJECT_URL,
  SNIPPET_FILE,
  branchReadme,
  friendlyError,
  repositoryIsPrivate,
  run,
  snippetDocument
};
