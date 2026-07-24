# embedded-service-pages

Personal test harness for Salesforce **Embedded Service (ESW)** and **Messaging for In-App and Web (MIAW)** "Get Code" snippets. Publishes each snippet as a live HTML page on GitHub Pages so you can validate the widget end-to-end.

Modeled after the `esw1234/esw1234.github.io` layout — one folder per substrate (or org), one HTML page per deployment.

## Quick start (paste-a-snippet, get-a-URL)

If you just want to turn a "Get Code" snippet into a live URL, run the tool with one command — no clone needed:

```bash
npx github:vikas-peddinti/embedded-service-pages
```

Requires Node 18+ and an authed `gh` CLI (`gh auth login` for github.com). It runs
locally on your machine with your own `gh` auth and publishes your pages into a
folder named after your GitHub login — so many people can share this one repo
without colliding, and nothing needs to be hosted. Open http://localhost:5757.

See [`_tool/README.md`](_tool/README.md) for full details.

## Fork & use

1. **Fork** this repo (or clone into a new empty repo of your own).
2. Enable **GitHub Pages** for the repo (`Settings → Pages → Source: master branch`).
3. Auth `gh` against the publish target:
   - Default → `gh auth login` for `github.com`
   - GHES → `GH_HOST=<host> gh auth login` if overriding
4. Run the tool (see `_tool/README.md`) or hand-author pages from `template.html`.

The page-generator tool (`_tool/`) defaults to publishing to **`vikas-peddinti/embedded-service-pages` on `github.com`** (branch `main`) for both ESW and MIAW pages — the public GitHub Pages host serves anonymously (CORS-open, no SSO gate) so the embedded widget can render. See `_tool/README.md` for details on overriding the publish target.

## Layout

```
<REPO>/
├── template.html           # copy this for every new hand-authored page
├── .nojekyll               # keep as-is (disables Jekyll on Pages)
├── _tool/                  # optional: paste-a-snippet-get-a-URL Node UI
├── GCP/                    # substrate folders — created on demand by the tool,
├── AWS/                    #   or by you when hand-authoring
└── SDB6001/                # or one folder per org, whichever you prefer
    └── <orgId><label>.html
```

## Per-test workflow (hand-authored)

1. Create the folder if it doesn't exist yet (e.g. `GCP/`, `AWS/`, `SDB6001/`).
2. Copy `template.html` to `<FOLDER>/<orgId><label>.html`.
3. Paste the Setup "Get Code" snippet between the two marker comments in the copy.
4. Commit + push. Wait ~30–60s for GitHub Pages to publish.
5. Open the live URL:

   - **github.com**: `https://<owner>.github.io/<repo>/<FOLDER>/<file>.html`
   - **Default (tool)**: `https://vikas-peddinti.github.io/embedded-service-pages/<login>/<orgId>-<deployment>.html`
   - **GHES**:       `https://<host>/pages/<owner>/<repo>/<FOLDER>/<file>.html`

The `_tool/` UI automates all of steps 2–5 and publishes to `vikas-peddinti/embedded-service-pages` by default.

## URL notes

- GHES Pages typically require being on the corresponding network (VPN for `git.soma.salesforce.com`, etc.). The widget itself talks to Salesforce endpoints directly from the tester's browser, so it works fine as long as the tester can reach both the Pages host and the Salesforce org.
- For pages a partner or customer needs to hit from the open internet, use a `github.com` fork instead of GHES.

## 404 on chat button click?

Usually means the snippet's `communityEndpointURL` (second arg to `embedded_svc.init`) doesn't match an active Experience Site in the target org. Verify in Setup → Digital Experiences → All Sites, then re-copy the snippet from Setup.
