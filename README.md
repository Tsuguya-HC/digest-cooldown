# digest-cooldown

A GitHub Action that holds external container-image digest bumps for a cooldown
period, reported as a `digest-cooldown` commit status.

## Why

Renovate's `minimumReleaseAge` can only gate an update when the datasource
exposes a `releaseTimestamp`. Docker digests never expose one
([renovatebot/renovate#38656](https://github.com/renovatebot/renovate/issues/38656)),
so a pure digest bump — same `image:tag`, new `sha256:` — slips straight past
the native age gate and into an automerge. Version bumps are barely better: the
timestamp comes from `org.opencontainers.image.created`, which whoever pushed
the image controls, so it can be back-dated.

This action supplies the missing clock. It records when *it* first saw each
digest, in a PR comment, and keeps the commit status `pending` until that
observation is old enough. The clock is its own, so it cannot be back-dated.

Judgement comes purely from the PR diff — no PR-body parsing, no execution of
the head-side code.

## Usage

```yaml
name: Digest cooldown

on:
  pull_request_target:
    types: [opened, synchronize, reopened, labeled, unlabeled, edited]
  schedule:
    - cron: "23 * * * *"
  workflow_dispatch:

permissions: {}

jobs:
  cooldown:
    runs-on: ubuntu-latest
    permissions:
      statuses: write        # post the digest-cooldown commit status
      pull-requests: write   # store first-seen dates in a PR comment
      contents: read         # read the diff
    steps:
      - uses: Tsuguya/digest-cooldown@<sha>  # v1.0.0
        with:
          cooldown-days: 3
          skip-registries: registry.example.com,ghcr.io/myorg
          gate-version-bumps: true
          gate-authors: my-renovate-app[bot]
          always-report: true
```

Run it on `pull_request_target`, not `pull_request`: the workflow definition
then comes from the base branch, so a PR cannot weaken the gate that is judging
it. The action never checks out or runs head-side code, so this adds no
execution risk.

The `schedule` entry is what flips a cooled digest from `pending` to `success` —
without a PR event nothing else re-evaluates it. Pick a cadence you are happy
waiting for.

## Inputs

See [`action.yml`](action.yml) for the full contract. The ones that matter most:

| input | default | notes |
|---|---|---|
| `cooldown-days` | `3` | measured in hours (`3` = 72h), not calendar days |
| `skip-registries` | *(empty)* | trusted prefixes, matched on path-segment boundaries |
| `gate-version-bumps` | `false` | `true` gates every newly-introduced digest, not just same-tag bumps |
| `gate-authors` | `renovate[bot]` | who gets the broad strategy — **see the gotcha below** |
| `always-report` | `false` | post `success` on PRs with nothing to gate, so the status can be a *required* check |
| `bypass-label` | *(empty)* | emergency override label |
| `bypass-requires-status` | *(empty)* | a status that must be `success` before the label counts |

## Making it a required status check

With `always-report: true` the action reports on every PR against a gated base,
including the ones with no digests. That is the prerequisite for listing
`digest-cooldown` as a required status check: without it, a PR that never gets
the status sits at "Waiting for status to be reported" forever.

Required is strictly stronger than advisory. Renovate's own automerge honours
non-required statuses, but GitHub's native auto-merge (`platformAutomerge`)
only waits for the required ones.

### Merge queue

A merge queue re-runs the required checks on a temporary commit
(`gh-readonly-queue/<base>/pr-<N>-<base_sha>`), and the status must be
reported on *that* commit. Subscribe the workflow to `merge_group` as well:

```yaml
on:
  pull_request_target:
    types: [opened, synchronize, reopened, labeled, unlabeled, edited]
  merge_group:
```

On a `merge_group` run the action does not re-evaluate the diff. A PR cannot
enter the queue until `digest-cooldown` is success on its head, and the group
carries exactly that head's digests, so the action reads the latest
`digest-cooldown` status on the PR head, requires it to be success and posted
by a trusted creator (`merge-group-status-creators`, default
`github-actions[bot]`), and mirrors it onto the merge-group head. Anything
else — missing, pending, an untrusted creator, an unparseable queue ref, an
API failure — posts pending, so the entry waits rather than merges.

## Gotchas

**A self-hosted Renovate is not `renovate[bot]`.** Running Renovate as your own
GitHub App means its PRs are authored by that App's login. The default
`gate-authors` then matches nothing and every PR silently falls back to the
pure-digest-bump baseline, which is exactly the mode that misses version bumps.
Check what the API reports:

```console
$ gh api repos/OWNER/REPO/pulls/123 --jq .user.login
my-renovate-app[bot]
```

**Don't make `bypass-requires-status` a required check.** The status it names
(typically a provenance verification) is not posted on every PR, so requiring
it deadlocks unrelated PRs.

**First-seen state lives in a PR comment.** Only comments authored by
`trusted-comment-author` (default `github-actions[bot]`) are read, so the dates
can't be forged by another commenter. If you pass a custom `github-token`, set
that input to the identity it posts as, or the action won't find its own state.

## Failure posture

Every unjudgeable input fails closed — the status goes `pending`, never
`success`:

- the diff can't be read, or comes back in an unexpected shape
- a line is too long to scan safely (`MAX_SCAN_LINE`)
- a digest uses an algorithm this action doesn't understand (anything but
  `sha256`)
- the comment API fails (the status is still written)
- anything else throws while evaluating a PR

## Tests

```console
node tests/test.mjs
```

No dependencies, no network: the suite extracts the `github-script` bridge from
`action.yml` and runs the shipped `impl.mjs` against stubs, so it exercises the
same load path as production.

## Credits

Derived from the digest-cooldown action in
[`animalife/github-actions`](https://github.com/animalife/github-actions),
which is where most of the hardening in `impl.mjs` was worked out. This fork
adds instant-precision cooldown accounting and the unknown-digest-algorithm
gate.
