# Examples

[繁體中文](README.zh-TW.md)

Two small programs that use this package the way an application would: one for Node, one for the browser. Both run
the same walk-through, in [`demo.mjs`](demo.mjs):

1. `System.Ping`, without signing in.
2. Sign in, which installs the session key; every call after it is encrypted.
3. Enter a company, which form calls need.
4. List the `Staff` form.
5. Create a staff record with a phone number, read it back, rename it and add a second phone, then delete it, so the
   demo database stays as it was.

They import `@polhem/connector` by name, which resolves to this repository's build, so the code reads as it would in
your own project.

## Start a server

The examples talk to the framework's QuickStart.Server, which signs in `demo` / `demo` and has the `Staff` form. Use
the framework release this package is verified against, the tag in [`scripts/framework-ref.mjs`](../scripts/framework-ref.mjs):

```sh
git clone --branch <tag> https://github.com/polhem-dev/polhem.git
cd polhem
dotnet run --project samples/QuickStart.Server
```

It listens on `http://localhost:5050`.

## Node

```sh
npm run example:node
```

This builds the package and runs [`node/quickstart.mjs`](node/quickstart.mjs). To use another server, set
`POLHEM_ENDPOINT`, `POLHEM_API_KEY`, `POLHEM_USER`, `POLHEM_PASSWORD` and `POLHEM_COMPANY`.

## Browser

```sh
npm run example:browser
```

This builds the package and serves the page on <http://localhost:5173/examples/browser/>. Open it and press **Run**;
the fields change the server and the account. The page and the API are on different origins, which QuickStart.Server
allows.

The page loads the package through an import map, with no bundler:

```html
<script type="importmap">
  { "imports": { "@polhem/connector": "/dist/index.js" } }
</script>
```

In an application built with a bundler, install the package and import it as usual instead.

## Type checking

The examples are plain JavaScript with `// @ts-check`. `npm run examples:check` type-checks them against the build, and
CI runs it, so an API change that breaks an example fails the build.
