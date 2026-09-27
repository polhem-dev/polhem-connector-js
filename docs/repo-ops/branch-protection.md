# Branch protection and repository settings

This document records how `main` of `polhem-dev/polhem-connector-js` is protected. It follows the framework
repository's setup (`docs/repo-ops/branch-protection-setup.md` in polhem-dev/polhem); only the required checks differ.

## Required status checks are the matrix job names

The CI workflow runs one `build` job per Node version, and GitHub names each matrix job after its values. The required
checks are therefore **`build (20)`** and **`build (22)`**, not `build`.

**Changing the Node matrix in `.github/workflows/ci.yml` requires changing the protection in the same step.** Otherwise:

- Removing a version leaves a required check that never reports again, and every pull request waits for it forever.
- Adding a version adds a job that runs but is not required, so a failure on it does not block a merge.

Update the list after the workflow change lands (adjust the versions):

```bash
gh api repos/polhem-dev/polhem-connector-js/branches/main/protection/required_status_checks \
  --method PATCH --input - <<'EOF'
{ "strict": true, "contexts": ["build (20)", "build (22)"] }
EOF
```

For the same reason the `pull_request` trigger of `ci.yml` has no `paths` filter: a required check must start on
every pull request.

## The rest of the protection

| Setting | Value |
|---------|-------|
| `required_status_checks.strict` | `true`: the branch must be up to date with `main` before it merges |
| `enforce_admins` | `true`: nobody pushes to `main` directly |
| `required_pull_request_reviews.required_approving_review_count` | `0`: a pull request is required, but no approval, while there is a single maintainer |
| `allow_force_pushes` / `allow_deletions` | `false` |
| Merge methods | Squash only; merged branches are deleted; auto-merge is allowed |

Show the current rules with `gh api repos/polhem-dev/polhem-connector-js/branches/main/protection`.
