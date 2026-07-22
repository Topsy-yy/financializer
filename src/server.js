const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const session = require("express-session");
const config = require("./config");
const apiRouter = require("./routes/api");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
app.use(session({
  secret: config.sessionSecret || "finguard-dev-session-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 14 * 24 * 60 * 60 * 1000 }
}));

// Every visitor -- logged in or not (demo mode, pre-login) -- gets a stable
// anonymous identity so their data never leaks into another visitor's session.
app.use((req, res, next) => {
  if (!req.cookies.fg_guest_id) {
    const guestId = crypto.randomBytes(16).toString("hex");
    res.cookie("fg_guest_id", guestId, {
      maxAge: 400 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax"
    });
    req.cookies.fg_guest_id = guestId;
  }
  next();
});

const publicDir = path.resolve(process.cwd(), "public");

// The marketing landing page lives at "/"; the actual app (onboarding,
// dashboard, everything behind FinGuardWallet/hash routing) lives at "/app".
app.get("/", (req, res) => res.sendFile(path.join(publicDir, "landing.html")));
app.get("/app", (req, res) => res.sendFile(path.join(publicDir, "index.html")));

app.use(express.static(publicDir, { index: false }));
app.use("/api", apiRouter);

app.listen(config.port, () => {
  // Startup log is intentionally concise for local and cloud logs.
  console.log(`FinGuard AI running on port ${config.port}`);
  if (!config.enableGoogleAuth) {
    console.log("Google auth not configured -- login disabled, guest/demo mode only. Set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET to enable.");
  }
});
