const config = require("../config");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/* TEST-ONLY ENDPOINT OVERRIDE.
 *
 * The token and userinfo endpoints are Google's, and were hardcoded — which
 * made the callback impossible to exercise over HTTP. The email-verification
 * check added in the final closure phase lives INSIDE that callback, so
 * without a seam it could only be tested by assuming what the callback does,
 * which is exactly what the mandate forbids.
 *
 * The override is refused outside NODE_ENV=test, so production can never be
 * pointed at an attacker-supplied identity provider by an environment
 * variable. Same double-gating as the /__test/ai-stub route.
 */
function endpoint(envVar, real) {
  if (process.env.NODE_ENV === "test" && process.env[envVar]) return process.env[envVar];
  return real;
}

const GOOGLE_TOKEN_URL = () =>
  endpoint("TEST_GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token");
const GOOGLE_USERINFO_URL = () =>
  endpoint("TEST_GOOGLE_USERINFO_URL", "https://www.googleapis.com/oauth2/v3/userinfo");

function buildAuthUrl(state) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", config.googleClientId);
  url.searchParams.set("redirect_uri", config.googleRedirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("state", state);
  return url.toString();
}

async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    code,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    redirect_uri: config.googleRedirectUri,
    grant_type: "authorization_code"
  });

  const response = await fetch(GOOGLE_TOKEN_URL(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  const data = await response.json();
  if (!response.ok || data.error || !data.access_token) {
    throw new Error(data.error_description || data.error || `token_exchange_${response.status}`);
  }
  return data;
}

async function fetchUserInfo(accessToken) {
  const response = await fetch(GOOGLE_USERINFO_URL(), {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `userinfo_${response.status}`);
  }
  return {
    sub: data.sub,
    email: data.email || null,
    emailVerified: Boolean(data.email_verified),
    name: data.name || null,
    picture: data.picture || null
  };
}

module.exports = {
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchUserInfo
};
