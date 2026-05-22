# Actions Storage Policy

GitHub Actions artifacts and logs count against a shared org quota (50 GB on our plan). When usage approaches the ceiling, workflows that upload artifacts start failing — which means deployments break. This doc is the policy that prevents that, plus what to do when the [monitor](./.github/workflows/actions-storage-monitor.yml) raises an alarm.

## Retention tiers

| Tier | Use case | Retention | How |
|---|---|---:|---|
| **Short** | PR / feature-branch CI, test outputs, coverage reports | **7 days** | Explicit per-workflow `retention-days: 7` |
| **Medium (org default)** | Deploy zips for stable branches, release candidates | **30 days** | Org default — set in Settings → Actions → General |
| **Long-term** | Release builds, signed binaries, anything to roll back to >30 days later | **Not in Actions storage** | Use GitHub Releases, ACR, or GHCR |

## How to set retention on a new workflow

Always set `retention-days` explicitly on `actions/upload-artifact`. The org default is the fallback, but explicit beats implicit:

```yaml
- uses: actions/upload-artifact@v4
  with:
    name: build-output
    path: dist/
    retention-days: 7
```

## Rules of thumb

1. **No downstream consumer in the same run? Don't upload.** Coverage that won't be sent to Codecov: drop the upload, use the [job summary](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions#adding-a-job-summary) instead.
2. **Deploy target is a container registry (ACR / GHCR)? Don't upload as an artifact.** The image in the registry is the artifact.
3. **Artifact consumed by a later job in the same workflow? `retention-days: 1`.** Long enough for the dependent job; gone after.
4. **Need history beyond 30 days? Use [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).** Releases don't count toward Actions storage.

## The monitor

[`.github/workflows/actions-storage-monitor.yml`](./.github/workflows/actions-storage-monitor.yml) runs every Monday at 14:00 UTC and tallies active artifact bytes across every org repo. Thresholds:

| Total active | Action |
|---|---|
| ≥ 25 GB | Opens or comments on a tracking issue in this repo |
| ≥ 40 GB | Adds the `urgent` label to that issue |
| ≥ 50 GB | (Ceiling — uploads start failing) |

You can also trigger it manually: Actions → Actions Storage Monitor → Run workflow.

## When the monitor fires

1. Open the issue. The body has a per-repo table — there's usually one outlier.
2. Identify the offending workflow (link in the table goes to that repo's Actions/artifacts page). Most common causes:
   - `retention-days` missing on an `upload-artifact` step
   - Artifact uploaded on every PR with no downstream consumer
   - Auto-generated Azure Function App template (`main_*.yml`) without `retention-days`
3. Open a PR adding `retention-days: 7` (or appropriate value per the tiers above).
4. To clear the existing backlog: list and delete via the [REST API](https://docs.github.com/en/rest/actions/artifacts). Use age (>14 days) and branch (non-`main`/`release`) as filters. Artifacts can't be recovered after deletion — when in doubt, leave them.
5. Re-run the monitor (`workflow_dispatch`) to confirm.

## History

- **2026-05-19** — first incident. Org hit 45 GB / 50 GB. One repo (`frelardservice`) held ~57 GB of `deployment` artifacts because the workflow uploaded a 97 MB zip on every push (and every PR) at 90-day default retention. Phase 1 deleted 525 artifacts (47.8 GB freed). Phase 2 added explicit retention on the auto-generated Azure Function App templates (purpose-project-admin, h2all-services, h2all-hubspot-services) and shipped this monitor + doc.
