#!/usr/bin/env node
// Snippet -> live GitHub Pages URL, in one form submit.
//
// Usage: node server.mjs   (then open http://localhost:5757)
// Requires: `gh` CLI already authed against the host of your repo's origin remote
//           (e.g. `gh auth status`, or `GH_HOST=<host> gh auth status` for GHES).
//
// Repo coordinates default to the public GitHub Pages repo vikas-peddinti/embedded-service-pages
// on github.com (branch main) — the host that serves the embedded widget. Override
// any field with env vars if publishing elsewhere:
//   GH_OWNER  GH_REPO  GH_BRANCH  GH_HOST  PORT

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

// Default publish target: the public GitHub Pages repo. Pages there serve the
// generated page anonymously (CORS-open, no frame block), so the embedded widget
// actually renders. The origin remote for this checkout is the SSO-gated git.soma
// repo, which can't serve the widget — so we default to the public repo rather than
// auto-detecting the remote. Override any field with env vars if publishing elsewhere.
const DEFAULT_REPO = {
  OWNER: 'vikas-peddinti',
  REPO: 'embedded-service-pages',
  BRANCH: 'main',
  GH_HOST: 'github.com',
}

function resolveRepoConfig() {
  return {
    OWNER: process.env.GH_OWNER || DEFAULT_REPO.OWNER,
    REPO: process.env.GH_REPO || DEFAULT_REPO.REPO,
    BRANCH: process.env.GH_BRANCH || DEFAULT_REPO.BRANCH,
    GH_HOST: process.env.GH_HOST || DEFAULT_REPO.GH_HOST,
  }
}

const { OWNER, REPO, BRANCH, GH_HOST } = resolveRepoConfig()
const PORT = Number(process.env.PORT) || 5757

// The current gh user's login, resolved once at startup (see resolveLogin).
// Each user runs their own instance; their generated pages are committed into a
// folder named after this login, so many users share one repo without colliding.
let LOGIN = null

if (!OWNER || !REPO) {
  console.error(
    'Could not determine repo coordinates. Run this from inside a git checkout with an origin remote,\n' +
    'or set GH_OWNER and GH_REPO env vars explicitly.',
  )
  process.exit(1)
}

// GitHub Pages URL shape depends on host:
//   github.com  -> https://<owner>.github.io/<repo>/<path>
//   GHES        -> https://<host>/pages/<owner>/<repo>/<path>
function pagesUrlBase() {
  return GH_HOST === 'github.com'
    ? `https://${OWNER}.github.io/${REPO}`
    : `https://${GH_HOST}/pages/${OWNER}/${REPO}`
}

function repoUrl() {
  return `https://${GH_HOST}/${OWNER}/${REPO}`
}

function gh(args, { stdinBody } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, {
      env: { ...process.env, GH_HOST },
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`gh ${args[0]} exited ${code}: ${stderr.trim()}`))
      resolve(stdout)
    })
    if (stdinBody != null) {
      child.stdin.write(stdinBody)
      child.stdin.end()
    }
  })
}

// Resolve the authenticated gh user's login. gh() injects GH_HOST, so this
// resolves against the same account that will author the commits. ~500ms
// network call — done once at startup and cached in LOGIN.
async function resolveLogin() {
  const login = (await gh(['api', 'user', '--jq', '.login'])).trim()
  if (!login) throw new Error('`gh api user` returned an empty login')
  return login
}

function detectSubstrate(...urls) {
  for (const u of urls.filter(Boolean)) {
    if (/pc-gcp/i.test(u)) return 'GCP'
    if (/pc-aws/i.test(u)) return 'AWS'
    if (/pc-rnd/i.test(u)) return 'RND'
    const m = u.match(/pc-(\w+)/i)
    if (m) return m[1].toUpperCase()
  }
  return 'UNKNOWN'
}

function detectInstance(url) {
  const m = String(url || '').match(/^https?:\/\/([^./]+)/)
  return m ? m[1] : 'org'
}

// Extract fields from a Setup "Get Code" ESW v5 snippet.

// Per-target-path lock while a generate is in flight. Keyed by the repo path
// (folder/filename) so two DIFFERENT files generate concurrently, while the SAME
// file is serialized — that prevents the read-then-PUT in commitFile from racing
// itself into a GitHub Contents-API 409. Entries auto-expire after
// LOCK_TIMEOUT_MS (safety net for crashes / hangs).
const locks = new Map() // key: repo path string -> { since: ISOString }
const LOCK_TIMEOUT_MS = 90_000

function isLockStale(since) {
  return Date.now() - new Date(since).getTime() > LOCK_TIMEOUT_MS
}

function currentLock(key) {
  const l = locks.get(key)
  if (l && isLockStale(l.since)) { locks.delete(key); return null }
  return l || null
}

function acquireLock(key) {
  if (currentLock(key)) return false
  locks.set(key, { since: new Date().toISOString() })
  return true
}

function releaseLock(key) { locks.delete(key) }

export function parseEswSnippet(snippet) {
  // embedded_svc.init('https://...my.salesforce.com', 'https://...site.com/<PATH>', gslbBaseURL, '<ORG_ID>', '<DEPLOYMENT_NAME>', {...})
  const initMatch = snippet.match(
    /embedded_svc\.init\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*[^,]+,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/,
  )
  if (!initMatch) throw new Error("Could not find `embedded_svc.init(...)` in the snippet. Is this a v5 ESW snippet from Setup > Embedded Service Deployments > View > Get Code?")
  const [, orgUrl, communityUrl, orgId, deploymentName] = initMatch

  const communityPathMatch = communityUrl.match(/site\.com\/([^/?#]+)/)
  const communityPath = communityPathMatch ? communityPathMatch[1] : 'ESWSite'

  const laMatch = snippet.match(/baseLiveAgentContentURL\s*:\s*['"]([^'"]+)['"]/)
  const substrate = detectSubstrate(laMatch?.[1], orgUrl, communityUrl)
  const instance = detectInstance(orgUrl)

  return {
    kind: 'esw',
    orgUrl,
    communityUrl,
    communityPath,
    orgId,
    deploymentName,
    substrate,
    instance,
    filename: `${orgId}${communityPath}.html`,
    folder: substrate,
  }
}

// Extract fields from a MIAW (Messaging for In-App and Web) snippet.
// Standard shape: embeddedservice_bootstrap.init('<ORG_ID>', '<DEPLOYMENT_DEV_NAME>', '<SITE_URL>', { scrt2URL: '<SCRT2_URL>' })
export function parseMiawSnippet(snippet) {
  const initMatch = snippet.match(
    /embeddedservice_bootstrap\.init\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*\{([\s\S]*?)\}\s*\)/,
  )
  if (!initMatch) throw new Error("Could not find `embeddedservice_bootstrap.init(...)` in the snippet. Is this a MIAW snippet from Setup > Embedded Service Deployments (Messaging channel) > Install Code?")
  const [, orgId, deploymentName, siteUrl, initOpts] = initMatch

  const scrt2Match = initOpts.match(/scrt2URL\s*:\s*['"]([^'"]+)['"]/)
  const scrt2URL = scrt2Match ? scrt2Match[1] : ''

  const sitePathMatch = siteUrl.match(/\/([^/?#]+)\/?$/)
  const sitePath = sitePathMatch ? sitePathMatch[1] : 'MIAWSite'

  const substrate = detectSubstrate(scrt2URL, siteUrl)
  const instance = detectInstance(siteUrl)

  return {
    kind: 'miaw',
    orgId,
    deploymentName,
    siteUrl,
    scrt2URL,
    sitePath,
    substrate,
    instance,
    filename: `${orgId}-${deploymentName}.html`,
    folder: substrate,
  }
}

export function parseSnippet(snippet, kind = 'esw') {
  return kind === 'miaw' ? parseMiawSnippet(snippet) : parseEswSnippet(snippet)
}

// Regex string that strips the Pages path prefix from window.location.pathname,
// leaving just the file path within the repo. Differs between github.com and GHES.
function pagesPathStripRegex() {
  return GH_HOST === 'github.com'
    ? `/^\\/${REPO}/`
    : `/^\\/pages\\/${OWNER}\\/${REPO}/`
}

function editUrlPrefix() {
  return `https://${GH_HOST}/${OWNER}/${REPO}/edit/${BRANCH}`
}

function buildEswPage(parsed, snippet) {
  return `<!DOCTYPE HTML>
<html>
\t<head>
\t\t<meta charset="utf-8">
\t\t<br><br>
\t\t<title>${parsed.substrate} ESW End user Page — ${parsed.instance} ${parsed.deploymentName}</title>
\t\t<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=0">
\t</head>

\t<body>
\t\t<p>
\t\t\t<a id="editThisPageLink" target="_blank" style="color:red">Edit this page</a>
\t\t</p>
\t\t
\t\t<script>
\t\t\tdocument.getElementById('editThisPageLink').href = "${editUrlPrefix()}" + window.location.pathname.replace(${pagesPathStripRegex()}, "");
\t\t</script>
\t\t<br>
\t\t<h2 align="center"><font color="green">${parsed.substrate} ESW End user Page — ${parsed.instance} / ${parsed.deploymentName} (orgId ${parsed.orgId})</font></h2>

\t\t<br/>

\t\t<!-- 5.0 snippet -->
${snippet.trim()}
\t
\t</body>
</html>
`
}

// MIAW page shell — mirrors the proven layout from ESW1234/esw1234.github.io MIAW pages.
// The pasted snippet is expected to already contain BOTH scripts (init function + bootstrap loader).
// Byte-for-byte match of the venkatesh MIAW shell (SDB3/00DSB00000DyYSLLANG.html
// and the newer example the user provided). Quirks preserved intentionally:
//   - No <!DOCTYPE HTML>, no <meta charset>
//   - Viewport meta ends with the "+Sheet2!B21>" paste artifact
//   - <h1> hardcoded to "admin username" (never templated in venkatesh's pages)
//   - The commented-out asyncclient/bootstrap.js line stays
// Only the pasted snippet varies per page.
function buildMiawPage(parsed, snippet) {
  return `<html>
<head>
<title>InApp</title>
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1"+Sheet2!B21>
</head>
<body>
<h1> In APP Web Client for Org: "admin username"</h1>
<p><a id="editThisPageLink" target="_blank" style="color:blue">Edit this page</a></p>
<script>document.getElementById('editThisPageLink').href = "${editUrlPrefix()}" + window.location.pathname.replace(${pagesPathStripRegex()}, "");</script>
<!-- <script type='text/javascript' src='https://service.force.com/asyncclient/bootstrap.js'>> -->
${snippet.trim()}
</body>
</html>
`
}

function buildPage(parsed, snippet) {
  return parsed.kind === 'miaw' ? buildMiawPage(parsed, snippet) : buildEswPage(parsed, snippet)
}

// Read the current blob SHA for a path (null if it doesn't exist yet).
async function fetchSha(apiPath) {
  try {
    const raw = await gh(['api', `/repos/${OWNER}/${REPO}/contents/${apiPath}?ref=${BRANCH}`])
    const meta = JSON.parse(raw)
    return meta && meta.sha ? meta.sha : null
  } catch (e) {
    return null // 404 is expected for new files.
  }
}

// Commit a file via the Contents API, retrying on HTTP 409. Concurrent commits
// to one repo collide two ways: a stale blob SHA (same path written twice) and a
// branch-ref conflict (different paths, same branch — GitHub serializes ref
// updates and rejects the loser). Both are 409s and both are fixed by re-reading
// the current SHA and re-PUTting, so many users can commit to one repo safely.
async function commitFile({ folder, filename, content, message }) {
  const path = folder ? `${folder}/${filename}` : filename
  const apiPath = encodeURIComponent(path).replace(/%2F/g, '/')
  // Encode the file as base64 to safely pass through gh's --field system.
  const b64 = Buffer.from(content, 'utf8').toString('base64')

  const MAX_ATTEMPTS = 6
  let existingSha = await fetchSha(apiPath)
  const existedInitially = !!existingSha

  for (let attempt = 1; ; attempt++) {
    const args = [
      'api', '--method', 'PUT',
      `/repos/${OWNER}/${REPO}/contents/${apiPath}`,
      '-f', `message=${message}`,
      '-f', `branch=${BRANCH}`,
      '-f', `content=${b64}`,
    ]
    if (existingSha) args.push('-f', `sha=${existingSha}`)

    try {
      const out = await gh(args)
      const parsed = JSON.parse(out)
      return { commitSha: parsed.commit.sha, path, existed: existedInitially }
    } catch (e) {
      const isConflict = /HTTP 409|\bis at\b.*\bexpected\b/i.test(String(e.message || e))
      if (!isConflict || attempt >= MAX_ATTEMPTS) throw e
      // Someone else advanced the branch (or the file). Re-read the SHA and retry
      // with a little jittered backoff to avoid lockstep collisions.
      await new Promise(r => setTimeout(r, 150 * attempt + attempt * 37))
      existingSha = await fetchSha(apiPath)
    }
  }
}

async function waitForPagesBuild(commitSha, timeoutMs = 90_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const raw = await gh(['api', `/repos/${OWNER}/${REPO}/pages/builds/latest`])
      const build = JSON.parse(raw)
      if (build.status === 'built') {
        if (build.commit === commitSha) return { ok: true, build }
        // Many instances commit to one repo, so builds/latest can advance past
        // our commit. If our commit is in the repo history, a newer successful
        // build has already deployed the whole tree at-or-after it — our file is
        // live. Verify reachability with one cheap call (only on the race path).
        try {
          await gh(['api', `/repos/${OWNER}/${REPO}/commits/${commitSha}`])
          return { ok: true, build, superseded: true }
        } catch (_) { /* our commit not visible yet — keep polling */ }
      }
      // Only treat an errored build as our failure when it is OUR commit.
      if (build.commit === commitSha && build.status === 'errored') {
        return { ok: false, build, error: build.error?.message || 'Pages build errored' }
      }
    } catch (_) { /* transient — keep polling */ }
    await new Promise(r => setTimeout(r, 2000))
  }
  return { ok: false, error: 'Timed out waiting for Pages build (90s).' }
}

const INDEX_HTML_PATH = join(__dirname, 'index.html')

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    // Re-read on every request so edits to index.html show up without restart.
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(readFileSync(INDEX_HTML_PATH, 'utf8'))
    return
  }

  if (req.method === 'GET' && req.url === '/config') {
    respondJson(res, 200, {
      owner: OWNER,
      repo: REPO,
      branch: BRANCH,
      host: GH_HOST,
      login: LOGIN,
      repoUrl: repoUrl(),
      pagesBase: pagesUrlBase(),
    })
    return
  }

  if (req.method === 'POST' && req.url === '/generate') {
    let body = ''
    for await (const chunk of req) body += chunk
    let payload
    try { payload = JSON.parse(body) } catch { return respondJson(res, 400, { error: 'Invalid JSON.' }) }

    const snippet = (payload.snippet || '').trim()
    if (!snippet) return respondJson(res, 400, { error: 'Snippet is required.' })
    const kind = payload.kind === 'miaw' ? 'miaw' : 'esw'

    let parsed
    try { parsed = parseSnippet(snippet, kind) } catch (e) {
      return respondJson(res, 400, { error: e.message })
    }

    // Save one page per org id + deployment inside this user's folder, e.g.
    // <login>/00DSB000016WIvV-MiawChannelJul22.html. Including the deployment
    // name avoids collisions when an org has multiple deployments, or both an
    // ESW and a MIAW page; the per-user folder keeps distinct users apart.
    const safeDeployment = String(parsed.deploymentName || '').replace(/[^A-Za-z0-9_-]/g, '_')
    const filename = `${parsed.orgId}-${safeDeployment}.html`
    const folder = LOGIN.replace(/[^A-Za-z0-9-]/g, '') // gh logins are already [A-Za-z0-9-]
    parsed.folder = folder
    parsed.filename = filename
    const lockKey = `${folder}/${filename}`

    // Serialize only concurrent generates for THIS EXACT file — two different
    // files generate in parallel. Prevents commitFile's read-then-PUT from
    // racing itself into a GitHub 409 sha-mismatch.
    if (!acquireLock(lockKey)) {
      return respondJson(res, 409, { error: 'locked' })
    }

    try {
      const page = buildPage(parsed, snippet)
      const kindLabel = kind === 'miaw' ? 'MIAW' : 'ESW'
      const message = `Update ${filename} for ${kindLabel} ${parsed.instance} ${parsed.deploymentName}`

      const { commitSha, path, existed } = await commitFile({
        folder,
        filename,
        content: page,
        message,
      })
      const buildResult = await waitForPagesBuild(commitSha)
      const liveUrl = `${pagesUrlBase()}/${path}`
      const editUrl = `${repoUrl()}/edit/${BRANCH}/${path}`
      // The GitHub page for the committed file itself (source view), e.g.
      // https://github.com/<owner>/<repo>/blob/main/<login>/<orgId>-<deployment>.html
      const fileUrl = `${repoUrl()}/blob/${BRANCH}/${path}`

      respondJson(res, 200, {
        parsed,
        commitSha,
        existed,
        buildStatus: buildResult.ok ? 'built' : 'error',
        buildError: buildResult.ok ? null : buildResult.error,
        liveUrl,
        editUrl,
        fileUrl,
      })
    } catch (e) {
      respondJson(res, 500, { error: String(e.message || e) })
    } finally {
      releaseLock(lockKey)
    }
    return
  }

  res.writeHead(404).end('not found')
})

function respondJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

// Run when invoked directly (`node server.mjs`) OR via an npx/npm bin symlink
// (`npx github:owner/repo`). npx points process.argv[1] at a symlink in
// node_modules/.bin, so compare the RESOLVED real paths, not the raw strings.
function isMainModule() {
  const invoked = process.argv[1]
  if (!invoked) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked)
  } catch {
    return import.meta.url === `file://${invoked}`
  }
}

if (isMainModule()) {
  // Resolve the gh login BEFORE listening so LOGIN is a non-null invariant for
  // every request. Fail fast with a clear message if gh isn't authed.
  resolveLogin()
    .then(login => {
      LOGIN = login
      server.listen(PORT, () => {
        console.log(`\nESW page tool ready — publishing as ${LOGIN}/  Open http://localhost:${PORT}\n`)
      })
    })
    .catch(err => {
      console.error(
        'Could not resolve your GitHub login via `gh api user`.\n' +
        `Run \`GH_HOST=${GH_HOST} gh auth status\` and make sure you're logged in, then retry.\n` +
        String(err.message || err),
      )
      process.exit(1)
    })
}
