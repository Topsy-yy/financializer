// Test harness: boots the real Express app in a child process on a free port.
//
// The app calls app.listen() at require time, so it cannot be imported directly
// without binding a port. Spawning keeps the tests honest — they exercise the
// real server, real middleware and real routes — at the cost of a process.

const { spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..", "..");

async function startServer(env = {}) {
  const port = 8200 + Math.floor(Math.random() * 700);
  // Isolate every run: a throwaway REPORTS_DIR so tests never read or write
  // real user data in data/reports/.
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), "finguard-test-"));

  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      REPORTS_DIR: reportsDir,
      ENABLE_AI_ANALYSIS: "false",
      SESSION_SECRET: "test-session-secret",
      SECRETS_KEY: "test-secrets-key-0123456789abcdef",
      NODE_ENV: "test"
    }, env),
    stdio: ["ignore", "pipe", "pipe"]
  });

  const logs = [];
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${logs.join("")}`);
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.join("")}`);
    await new Promise((r) => setTimeout(r, 120));
  }

  return {
    base,
    port,
    reportsDir,
    logs,
    /** fetch with an isolated cookie jar per client. */
    /**
     * A fresh client with an isolated cookie jar.
     *
     * `prime` performs one safe request so the server issues a CSRF token and a
     * guest identity, which is exactly what a browser does on first page load.
     */
    client() { return makeClient(base); },
    async primedClient() {
      const c = makeClient(base);
      await c.get("/api/health/live");
      return c;
    },
    async stop() {
      child.kill("SIGKILL");
      try { fs.rmSync(reportsDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };
}

function makeClient(base) {
  const jar = new Map();

  function cookieHeader() {
    return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
  }
  function capture(res) {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    set.forEach((line) => {
      const [pair] = line.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    });
  }

  /**
   * The CSRF token the server issued, read from the jar.
   *
   * The harness behaves like the real browser client: it echoes the
   * double-submit token on every mutating request. A test that wants to prove
   * CSRF rejection suppresses it explicitly (see `noCsrf`).
   */
  function csrfToken() {
    const raw = jar.get("fg_csrf");
    return raw ? decodeURIComponent(raw) : "";
  }

  /** One safe request, to obtain a CSRF token and a guest identity. */
  async function primeToken() {
    const cookies = cookieHeader();
    const res = await fetch(`${base}/api/health/live`, {
      method: "GET",
      headers: cookies ? { cookie: cookies } : {}
    });
    capture(res);
    await res.text();
  }

  /* REDIRECTS ARE NOT FOLLOWED BY DEFAULT.
     fetch() follows them transparently, which silently made an OAuth test
     request the REAL accounts.google.com and report its 200 as the app's
     response. Every test here cares about the redirect the app issued -- the
     Location header IS the assertion -- so the jar-based client keeps them
     manual. `raw()` is unchanged. */
  async function request(method, pathname, body, extraHeaders = {}) {
    const headers = Object.assign({}, extraHeaders);
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
    // Prime BEFORE the cookie header is built, so the token cookie travels with
    // this request rather than only being present for the next one.
    if (mutating && headers["x-csrf-token"] === undefined && !csrfToken()) {
      await primeToken();
    }
    const cookies = cookieHeader();
    if (cookies) headers.cookie = headers.cookie ? `${headers.cookie}; ${cookies}` : cookies;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (mutating && !headers["x-csrf-token"] && headers["x-csrf-token"] !== null) {
      /* LAZY PRIMING, mirroring a real browser. A browser loads the page (a safe
         request), receives the CSRF cookie, and only then POSTs. A test that
         starts with a POST has no token yet, so one safe request is made first.
         A test proving CSRF rejection passes `x-csrf-token: null` to opt out. */
      const token = csrfToken();
      if (token) headers["x-csrf-token"] = token;
    }
    // An explicit null means "send no token", for the rejection tests.
    if (headers["x-csrf-token"] === null) delete headers["x-csrf-token"];
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers,
      redirect: "manual",
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    capture(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }

  /** Upload a file the way the real client does: multipart/form-data. */
  async function upload(pathname, { filename = "upload.csv", content = "", fields = {} }) {
    const form = new FormData();
    form.append("file", new Blob([content], { type: "text/csv" }), filename);
    Object.entries(fields).forEach(([k, v]) => form.append(k, String(v)));
    // Prime BEFORE building the cookie header, or the freshly-issued fg_csrf
    // cookie is minted into the jar but not sent with this request.
    if (!csrfToken()) await primeToken();
    const headers = {};
    const cookies = cookieHeader();
    if (cookies) headers.cookie = cookies;
    const token = csrfToken();
    if (token) headers["x-csrf-token"] = token;
    const res = await fetch(`${base}${pathname}`, { method: "POST", headers, body: form });
    capture(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }

  return {
    jar,
    csrfToken,
    upload,
    get: (p, h) => request("GET", p, undefined, h),
    post: (p, b, h) => request("POST", p, b === undefined ? {} : b, h),
    put: (p, b, h) => request("PUT", p, b === undefined ? {} : b, h),
    del: (p, h) => request("DELETE", p, undefined, h),
    /** Raw request with NO cookie jar — for forging/unauthenticated tests. */
    raw: (method, p, b, h) => {
      const headers = Object.assign({}, h);
      if (b !== undefined) headers["content-type"] = "application/json";
      return fetch(`${base}${p}`, { method, headers, body: b === undefined ? undefined : JSON.stringify(b) })
        .then(async (res) => {
          const text = await res.text();
          let json = null;
          try { json = JSON.parse(text); } catch { /* not json */ }
          return { status: res.status, json, text, headers: res.headers };
        });
    }
  };
}

module.exports = { startServer };
