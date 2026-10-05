/**
 * The framework release this package is verified against.
 *
 * `contracts.mjs` and `fetch-fixtures.mjs` both read it, so the synced contract and the wire
 * fixtures always come from the same framework version. A release tag rather than `main`: a given
 * version of this package then states which wire it speaks, and a wire change on the framework's
 * `main` does not reach this repository until it is released and adopted here.
 *
 * When the framework releases a new version, change this to the new tag, then follow
 * "When the framework's wire contract changes" in CONTRIBUTING.md.
 */
export const FRAMEWORK_REF = 'd35be485e69ba8ea680c9285b756603a503ef0c6';
