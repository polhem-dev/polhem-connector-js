# Contributing to polhem-connector-js

**English** | [繁體中文](CONTRIBUTING.zh-TW.md)

Thank you for your interest in the Polhem TypeScript connector. This guide describes how changes reach the
repository and the conventions they follow.

## Before you start

- For a bug fix or a small improvement, open a pull request directly.
- For a larger change (a new connector method, a change to the public API, a new dependency), open an issue first
  so the approach can be agreed on before you spend time on it.
- The server this package talks to is [polhem](https://github.com/polhem-dev/polhem). The wire format and the API
  contract are defined there, not here.

## Workflow

1. Fork the repository, or create a branch if you have write access, from the latest `main`.
2. Make the change, with tests.
3. Run the checks below.
4. Open a pull request against `main`.

`main` only accepts changes through pull requests. The CI build must pass on every Node version in its matrix before
a pull request can merge, and review is requested from the code owners listed in
[`.github/CODEOWNERS`](.github/CODEOWNERS).

## Build and test

```sh
npm ci
npm run contracts:check   # the synced API contract still matches the framework
npm run typecheck
npm test                  # offline unit tests
npm run build
npm run test:wire         # fetches the framework's wire fixtures and verifies the codec against them
```

These are the steps CI runs, in the same order (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).
`contracts:check` and `test:wire` read from GitHub; set `GITHUB_TOKEN` if you hit the unauthenticated rate limit.

`npm run smoke` runs the connector against a live server. It is not part of CI; the
[README](README.md#testing-against-a-real-backend) explains how to start one.

## When the framework's wire contract changes

`src/contracts/` and the wire fixtures come from one framework release, the tag in
[`scripts/framework-ref.mjs`](scripts/framework-ref.mjs). A wire change on the framework's `main` does not reach
this repository until the framework releases it. When it does:

1. Change `FRAMEWORK_REF` to the new tag and run `npm run contracts:update`. Do not edit `src/contracts/` by hand.
2. Read the diff. A renamed or removed property, or a member that became optional, is a breaking change for callers
   of this package.
3. Adapt the code and the tests until the checks above pass, and update the README if behaviour changed.

The wire fixtures are fetched, never committed: a copy here would be a second authority for the wire format.

## Conventions

- **Language**: code, comments, test names and commit messages are in English. Public documents (`README`,
  `CONTRIBUTING`) are bilingual: the English file is the source and the `.zh-TW.md` file next to it is the
  translation. Change both in the same pull request.
- **Commit messages**: English, in the imperative mood, with a subject that says what changed. Use the body to
  explain why.
- **Dependencies**: the package has no runtime dependencies. Everything cryptographic uses the platform's Web Crypto
  and compression streams; do not add a library for them.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
