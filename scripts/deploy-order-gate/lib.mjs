// Pure helpers for the deploy-order gate. No I/O here so they can be unit tested.

export const TRAILER = 'Depends-On-Deployed';

const ITEM_RE = /^(?:([A-Za-z0-9_.-]+)\/)?([A-Za-z0-9_.-]+)#(\d+)(?:\s*@\s*([A-Za-z0-9_-]+))?$/;

// Example trailers in HTML comments or code fences must never count as real dependencies.
export function stripNonProse(body) {
  return (body || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/(```|~~~)[\s\S]*$/, '')
    .replace(/`[^`\n]*`/g, '');
}

// Returns { deps, errors }. A malformed item is an error so a typo fails closed instead of passing.
export function parseDeps(body, defaultOwner, { strict = true } = {}) {
  const deps = [];
  const errors = [];
  // Matched anywhere on a line so list, checklist and prose forms cannot slip past the gate.
  const lineRe = new RegExp(`${TRAILER}\\**[ \\t]*:\\**[ \\t]*(.*)$`, 'gim');
  const text = stripNonProse(body);
  for (const m of text.matchAll(lineRe)) {
    if (/^\s*(none|n\/a)\s*$/i.test(m[1])) continue;
    if (!m[1].trim()) errors.push(`${TRAILER} with no dependency listed`);
    for (const raw of m[1].split(',')) {
      const item = raw.trim().replace(/[*_]+$/g, '').replace(/^[*_]+/g, '').trim();
      if (!item) continue;
      const im = item.match(ITEM_RE);
      if (!im) {
        errors.push(`unparseable ${TRAILER} item "${item}" (expected repo#123 or repo#123 @ env)`);
        continue;
      }
      deps.push({
        owner: im[1] || defaultOwner,
        repo: im[2],
        number: Number(im[3]),
        env: im[4] ? im[4].toLowerCase() : null,
      });
    }
  }
  // Catches near-miss separators like "Depends-On-Deployed - x#1"; plain prose mentions are fine.
  if (strict && !deps.length && !errors.length && new RegExp(`${TRAILER}\\**[ \\t]*[-=\u2013\u2014]`, 'i').test(text)) {
    errors.push(`${TRAILER} mentioned but not in the form "${TRAILER}: repo#123"`);
  }
  return { deps, errors };
}

const tagRe = (env) => new RegExp(`^${env}-(\\d{4})\\.(\\d{2})\\.(\\d{2})-(\\d+)-[0-9a-f]{7,40}$`);

// Tags come from the org auto-tag workflow: <env>-YYYY.MM.DD-<run>-<sha7>. Latest = highest date, then run.
export function pickLatestEnvTag(tagNames, env) {
  const re = tagRe(env);
  let best = null;
  for (const name of tagNames) {
    const m = name.match(re);
    if (!m) continue;
    const key = [Number(m[1] + m[2] + m[3]), Number(m[4])];
    if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && key[1] > best.key[1])) {
      best = { name, key };
    }
  }
  return best ? best.name : null;
}

// A cherry-pick of a squash merge keeps "(#N)" in its title; a revert of it must not count.
export function isCarryOfPr(message, number) {
  const first = (message || '').split('\n')[0];
  if (/^revert\b/i.test(first)) return false;
  return new RegExp(`\\(#${number}\\)\\s*$`).test(first);
}

// PR numbers a commit subject names: squash "title (#N)" or "Merge pull request #N from ...".
export function prRefsFromSubject(message) {
  const first = (message || '').split('\n')[0];
  const refs = [];
  const squash = first.match(/\(#(\d+)\)\s*$/);
  if (squash) refs.push(Number(squash[1]));
  const merge = first.match(/^Merge pull request #(\d+)\b/);
  if (merge) refs.push(Number(merge[1]));
  return refs;
}

export function depKey(d) {
  return `${d.owner}/${d.repo}#${d.number}@${d.env}`;
}

export function decide(results, errors) {
  if (errors.length) return { state: 'error', description: truncate(`Gate error: ${errors[0]}`) };
  if (!results.length) return { state: 'success', description: 'No deploy-order dependencies' };
  const unmet = results.filter((r) => !r.met);
  if (!unmet.length) return { state: 'success', description: truncate(`All ${results.length} deploy-order dependencies confirmed deployed`) };
  const u = unmet[0];
  return {
    state: 'failure',
    description: truncate(`${u.repo}#${u.number} not on ${u.env}: ${u.reason}${unmet.length > 1 ? ` (+${unmet.length - 1} more)` : ''}`),
  };
}

function truncate(s) {
  return s.length > 140 ? s.slice(0, 137) + '...' : s;
}
