# Contributing to @hwip/mcp-server

Bug reports, fixes and docs improvements are welcome. For a larger change, open an
issue first so we can agree on the approach before you write it.

## Set up

You need Node.js 18.17 or later. CI builds and tests on Node 20.

```bash
git clone https://github.com/hwipit/mcp-server.git
cd mcp-server
npm ci
```

## Build and test

```bash
npm run build        # tsc: type-check and emit dist/
npm test             # vitest run
npm run test:watch   # vitest in watch mode
```

Run `npm run build` and `npm test` before you open a pull request; CI runs both.

To try your build in an MCP client, point the client at `node /path/to/mcp-server/dist/index.js`
(the `hwip-mcp` binary). Credentials come from `~/.hwip/config.json` or the
environment variables listed in the [README](./README.md).

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/):
  `<type>(<scope>): <description>`, for example `fix(ask): ...`. Releases are cut by
  semantic-release from these messages, so the type decides
  whether a release is cut. While Hwip is 0.x every release is a patch bump —
  `feat` and breaking changes included (`releaseRules` in `package.json`).
- Open pull requests against `main`.
- A DCO sign-off is not required. By contributing you agree that your work is
  licensed under the Apache License 2.0, as in [LICENSE](./LICENSE).

Report security problems privately, as described in [SECURITY.md](./SECURITY.md).
