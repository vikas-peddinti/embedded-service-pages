# _tool/ — snippet-to-live-URL UI

Zero-dependency Node + vanilla-HTML tool. Paste a Setup "Get Code" snippet, get a live GitHub Pages URL for **your fork** of this repo.

## Requirements

- Node 18+ (uses `node:http`, `node:child_process`, ESM).
- `gh` CLI authed for the publish target:
  - **Default target:** `vikas-peddinti/embedded-service-pages` on `github.com` → `gh auth status` should show ✓
  - GHES (e.g. git.soma.salesforce.com) → `GH_HOST=<host> gh auth status` should show ✓
  - The tool resolves your publish folder from `GH_HOST=<host> gh api user --jq .login` at startup and will exit if `gh` is not authenticated.
- Pages enabled on the target repo (`Settings → Pages → Source: <branch>`).

No `npm install`, no dependencies.

## Run (one command — for sharing with others)

Anyone with Node 18+ and an authed `gh` CLI can run the tool without cloning:

```bash
npx github:vikas-peddinti/embedded-service-pages
```

This fetches the latest `main`, starts the server locally, and opens on
http://localhost:5757. Because it runs on **your** machine with **your** `gh`
auth, your pages are committed to **your own** `<login>/` folder — many people
can use it against the one shared repo without colliding, and every commit is
correctly attributed to whoever ran it. Nothing is hosted; there is no shared
token or server to maintain.

> First time only: run `gh auth login` (github.com). The tool exits with a
> clear message if `gh` isn't authenticated.

## Run (from a clone)

```bash
cd _tool
node server.mjs
```

Open http://localhost:5757, paste the snippet, submit. The tool:

1. Publishes to **`vikas-peddinti/embedded-service-pages` on `github.com` by default**, branch `main`.
   - **Why:** Public GitHub Pages serves pages anonymously (CORS-open, no SSO gate, no frame block) so the embedded messaging widget actually renders in the browser. The git.soma origin is SSO-gated and cannot serve the widget.
2. Parses org ID, deployment name, community site path, and substrate (GCP / AWS / RND / …) from the snippet.
3. Commits to `<login>/<orgId>-<deployment>.html` (a folder named after your `gh` login) via `gh api`.
4. Polls `/repos/.../pages/builds/latest` until the build for that commit reports `built`.
5. Returns the live URL:
   - **github.com**: `https://<owner>.github.io/<repo>/<login>/<orgId>-<deployment>.html`
   - **GHES**:       `https://<host>/pages/<owner>/<repo>/<login>/<orgId>-<deployment>.html`

## Publish Target Overrides

Override any of the four repo coordinates via env vars before running `node server.mjs`:

| Var         | Default                     | Override Example                                           |
| ----------- | --------------------------- | ---------------------------------------------------------- |
| `GH_OWNER`  | `vikas-peddinti`            | `GH_OWNER=someuser node server.mjs`                        |
| `GH_REPO`   | `embedded-service-pages`    | `GH_REPO=some-repo node server.mjs`                        |
| `GH_BRANCH` | `main`                      | `GH_BRANCH=staging node server.mjs`                        |
| `GH_HOST`   | `github.com`                | `GH_HOST=git.soma.salesforce.com node server.mjs`          |
| `PORT`      | `5757`                      |                                                            |

**Full override example:**

```bash
GH_OWNER=someuser GH_REPO=some-repo GH_BRANCH=main GH_HOST=github.com node server.mjs
```

Ensure `gh` CLI is authenticated for the target host (`gh auth status`).

## Overwriting

If the target file already exists in your own folder, the tool updates it in place (reads the existing SHA and passes it to the contents API). The "Live" banner will say "overwrote existing page". Re-generating the same org ID + deployment overwrites your page; it never touches other users' folders.

## When to skip the tool

For a one-off page it's still fine to copy `template.html` in the web UI, paste the snippet, and commit — the tool is just faster when you're iterating.
