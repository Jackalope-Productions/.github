# Deploy-order gate

Stops a PR from merging into a deploy branch until a stated cross-repo dependency is confirmed
deployed to the same environment. Built after pbaces.com#706 reached staging 44 minutes before
frelardservice#2543 did (2026-10-10).

## Declaring a dependency

Add a line to the PR body:

```
Depends-On-Deployed: frelardservice#2543
```

- Several: one line each, or comma-separated. Another org: `owner/repo#N`.
- The env is **not** written in the trailer. It is the env this PR's base branch deploys to,
  from the caller's `branch_env_map`. Optional `@ env` overrides it on the PR's own body only.
- A malformed item fails the check. Trailers inside HTML comments and code are ignored.
- No trailer: the check goes green. Nothing else changes.

## How it decides

For each dependency, against the env `E` mapped from the base branch:

1. The dependency PR must be merged.
2. Find the latest `E-YYYY.MM.DD-<run>-<sha>` tag in the dependency repo (written by `auto-tag.yml`
   on every successful deploy). No tag for `E`: not confirmed.
3. Confirmed if the PR's merge commit is an ancestor of that tag, or if a commit in the tag's
   history since the merge has `(#N)` in its title (a cherry-pick of the squash merge; reverts excluded).

Promotion PRs (for example `staging -> main`) do not repeat the original PR bodies, so the gate also
reads the trailer from every merged PR whose commits the promotion carries, and checks it against the
promotion's own target env.

Result: commit status `deploy-order` on the PR head (`success`, `failure`, or `error`). Gate errors fail closed.

## Adopting it in a repo

```yaml
name: Deploy-order gate
on:
  pull_request:
    types: [opened, edited, synchronize, reopened, ready_for_review]
    branches: [staging, main]   # only the mapped deploy branches; keeps runner cost down
  schedule:
    - cron: '17 */2 * * *'   # re-checks open PRs once the dependency deploys
  workflow_dispatch:
permissions:
  contents: read
  pull-requests: read
  statuses: write
jobs:
  gate:
    uses: Jackalope-Productions/.github/.github/workflows/deploy-order-gate.yml@main
    with:
      branch_env_map: '{"staging":"staging","main":"prod"}'
      gate_ref: main            # keep equal to the @ref in `uses:`
    secrets:
      read_token: ${{ secrets.DEPLOY_ORDER_READ_TOKEN }}   # read-only on dependency repos
```

Then make `deploy-order` a required status check on each mapped branch. Without that it reports but
does not block. Add `.github/workflows/` to CODEOWNERS: on `pull_request` the caller file comes from
the PR head, so a PR could edit its own gate (the scheduled run from the default branch corrects the
status, but a merge could land first).

## Limits

- Scheduled re-check every 2 hours: after the dependency deploys, the status turns green by the next run, or at once
  with "Re-run" / `workflow_dispatch` / editing the PR.
- A dependency rolled back after the gate went green is caught on the next scheduled run, but not after merge.
- Direct pushes to a deploy branch bypass any PR check; branch protection is what prevents them.
- It is a seatbelt, not an authorization control: an author can remove the trailer.
- Cherry-pick detection trusts a commit title ending in `(#N)`; a squash of the dependency PR keeps that.
- Merge queues (`merge_group`) are not handled.
- A PR carrying more commits than the gate can page through (2000) fails closed; split the promotion.
- Only repos whose deploys call `auto-tag.yml` for the target env can be depended on.
