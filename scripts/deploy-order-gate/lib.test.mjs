import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeps, pickLatestEnvTag, isCarryOfPr, decide, prRefsFromSubject } from './lib.mjs';

const O = 'Jackalope-Productions';

test('no trailer is a no-op', () => {
  assert.deepEqual(parseDeps('Fixes a thing.\n\nCloses #12', O), { deps: [], errors: [] });
  assert.deepEqual(parseDeps(null, O), { deps: [], errors: [] });
});

test('parses single, multiple, owner-qualified and env-override items', () => {
  const { deps, errors } = parseDeps(
    'Depends-On-Deployed: frelardservice#2543\n**Depends-On-Deployed:** Other-Org/svc#7 @ Preview, gtg-store#9',
    O,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(deps, [
    { owner: O, repo: 'frelardservice', number: 2543, env: null },
    { owner: 'Other-Org', repo: 'svc', number: 7, env: 'preview' },
    { owner: O, repo: 'gtg-store', number: 9, env: null },
  ]);
});

test('ignores trailers in HTML comments and code', () => {
  const body = '<!-- Depends-On-Deployed: frelardservice#1 -->\n```\nDepends-On-Deployed: x#2\n```\nuse `Depends-On-Deployed: y#3`';
  assert.deepEqual(parseDeps(body, O), { deps: [], errors: [] });
});

test('malformed item fails closed', () => {
  const { deps, errors } = parseDeps('Depends-On-Deployed: frelardservice 2543', O);
  assert.equal(deps.length, 0);
  assert.equal(errors.length, 1);
});

test('full URL form is rejected rather than silently skipped', () => {
  const { errors } = parseDeps('Depends-On-Deployed: https://github.com/Jackalope-Productions/frelardservice/pull/2543', O);
  assert.equal(errors.length, 1);
});

test('list, checklist, numbered and prose forms all parse', () => {
  for (const line of [
    '1. Depends-On-Deployed: frelardservice#1',
    '+ Depends-On-Deployed: frelardservice#1',
    '- [ ] Depends-On-Deployed: frelardservice#1',
    'Note: Depends-On-Deployed: frelardservice#1',
    '​Depends-On-Deployed: frelardservice#1',
  ]) {
    const { deps, errors } = parseDeps(line, O);
    assert.equal(deps.length, 1, line);
    assert.deepEqual(errors, [], line);
  }
});

test('any unparsed mention of the trailer fails closed', () => {
  assert.equal(parseDeps('Depends-On-Deployed - frelardservice#1', O).errors.length, 1);
  assert.equal(parseDeps('Depends-On-Deployed:\nfrelardservice#1', O).errors.length, 1);
  assert.equal(parseDeps('~~~\nDepends-On-Deployed: x#2\n~~~', O).errors.length, 0);
  assert.deepEqual(parseDeps('Adds the Depends-On-Deployed gate', O), { deps: [], errors: [] });
  assert.deepEqual(parseDeps('Depends-On-Deployed: none', O), { deps: [], errors: [] });
  assert.deepEqual(parseDeps('Depends-On-Deployed - x#1', O, { strict: false }).errors, []);
  assert.deepEqual(parseDeps('```\nDepends-On-Deployed: x#2', O), { deps: [], errors: [] });
});

test('commit subject PR refs', () => {
  assert.deepEqual(prRefsFromSubject('fix(privacy): x (pbaces.com#705) (#2543)\n\nbody'), [2543]);
  assert.deepEqual(prRefsFromSubject('Merge pull request #2548 from Jackalope-Productions/cherry/x'), [2548]);
  assert.deepEqual(prRefsFromSubject('plain commit'), []);
});

test('latest env tag by date then numeric run, ignoring other prefixes', () => {
  const tags = [
    'staging-2026.10.10-4935-dbea415',
    'staging-2026.10.10-10001-aaaaaaa',
    'staging-2026.10.09-9999-bbbbbbb',
    'staging-rollback-2026.10.11-1-ccccccc',
    'pre-staging-2026.10.12-1-ddddddd',
    'preview-2026.10.12-1-eeeeeee',
  ];
  assert.equal(pickLatestEnvTag(tags, 'staging'), 'staging-2026.10.10-10001-aaaaaaa');
  assert.equal(pickLatestEnvTag(tags, 'prod'), null);
});

test('cherry-pick carry detection', () => {
  assert.ok(isCarryOfPr('fix(privacy): proxied signups (pbaces.com#705) (#2543)\n\nbody', 2543));
  assert.ok(!isCarryOfPr('Revert "fix(privacy): proxied signups (#2543)"', 2543));
  assert.ok(!isCarryOfPr('something (#25430)', 2543));
  assert.ok(!isCarryOfPr('follow-up to (#2543) for staging (#2600)', 2543));
  assert.ok(!isCarryOfPr('body mentions (#2543) only on line 2\n(#2543)', 999));
});

test('decide', () => {
  assert.equal(decide([], []).state, 'success');
  assert.equal(decide([{ met: true }], []).state, 'success');
  const f = decide([{ met: true }, { met: false, repo: 'frelardservice', number: 1, env: 'staging', reason: 'PR is not merged' }], []);
  assert.equal(f.state, 'failure');
  assert.match(f.description, /frelardservice#1 not on staging/);
  assert.equal(decide([{ met: true }], ['boom']).state, 'error');
  assert.ok(decide([], ['x'.repeat(300)]).description.length <= 140);
});
