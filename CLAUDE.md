# polhem-connector-js — guidance for coding agents

The TypeScript client for the [Polhem](https://github.com/polhem-dev/polhem) JSON-RPC API. Build and test commands,
the pull request workflow and the language policy are in `CONTRIBUTING.md`; follow them. Everything here is written
in English.

## What an agent gets wrong here

- **The server is the authority for the wire.** `src/contracts/` is synced from the framework release named in
  `scripts/framework-ref.mjs` with `npm run contracts:update`; never edit it by hand. The wire fixtures under `test/fixtures/` are downloaded by
  `npm run test:wire` and never committed. A change that seems to need either belongs in the framework repository.
- **A contract diff is an API change for callers.** After `contracts:update`, read the diff and adapt the code, the
  tests and both READMEs (`README.md` is the source, `README.zh-TW.md` the translation; change them together).
- **No runtime dependencies.** Cryptography and compression use the platform's Web Crypto and compression streams.
- **The Node matrix in `.github/workflows/ci.yml` is tied to branch protection** (`docs/repo-ops/branch-protection.md`).
- **Every change reaches `main` through a pull request**, and the CI jobs must pass. `npm run smoke` needs a running
  server and is not in CI; run it when the change touches the transport, the handshake or the error handling.
