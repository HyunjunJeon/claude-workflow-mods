// semgrep --test fixture for rules/kisa-javascript.yaml: "ruleid" lines must match, "ok" lines must not.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const { exec, execFile } = require("child_process");
const express = require("express");

const app = express();

app.get("/user", async (req, res) => {
  const name = req.query.name;
  // ruleid: kisa-1-1-sql-injection-js
  const rows = await db.query(`SELECT * FROM users WHERE name = '${name}'`);
  // ok: kisa-1-1-sql-injection-js
  const safe = await db.query("SELECT * FROM users WHERE name = $1", [name]);
  res.json({ rows, safe });
});

app.post("/calc", (req, res) => {
  // ruleid: kisa-1-2-code-injection-js
  const value = eval(req.body.expr);
  // ok: kisa-1-2-code-injection-js
  const fixed = eval("1 + 1");
  res.json({ value, fixed });
});

app.get("/file", (req, res) => {
  // ruleid: kisa-1-3-path-traversal-js
  const body = fs.readFileSync("/srv/files/" + req.query.name, "utf8");
  // ok: kisa-1-3-path-traversal-js
  const clean = fs.readFileSync(path.join("/srv/files", path.basename(req.query.name)), "utf8");
  res.json({ body, clean });
});

app.get("/hello", (req, res) => {
  // ruleid: kisa-1-4-xss-js
  res.send(`<h1>Hello ${req.query.name}</h1>`);
});

app.get("/hello-json", (req, res) => {
  // ok: kisa-1-4-xss-js
  res.send({ name: req.query.name });
});

app.get("/ping", (req, res) => {
  // ruleid: kisa-1-5-os-command-injection-js
  exec(`ping -c 1 ${req.query.host}`);
  // ok: kisa-1-5-os-command-injection-js
  execFile("ping", ["-c", "1", req.query.host]);
  res.end();
});

app.get("/go", (req, res) => {
  // ruleid: kisa-1-7-open-redirect-js
  res.redirect(req.query.next);
});

app.get("/home", (req, res) => {
  // ok: kisa-1-7-open-redirect-js
  res.redirect("/");
});

app.get("/fetch", async (req, res) => {
  // ruleid: kisa-1-12-ssrf-js
  const upstream = await fetch(req.query.url);
  // ok: kisa-1-12-ssrf-js
  const fixed = await axios.get("https://api.example.com/status");
  res.json({ status: upstream.status, fixed: fixed.status });
});

function digests(data, password) {
  // ruleid: kisa-2-4-weak-crypto-js
  crypto.createHash("md5").update(data).digest("hex");
  // ruleid: kisa-2-4-weak-crypto-js
  crypto.createCipheriv("aes-128-ecb", key, null);
  // ok: kisa-2-4-weak-crypto-js
  crypto.createHash("sha256").update(data).digest("hex");
  // ruleid: kisa-2-14-unsalted-password-hash-js
  return crypto.createHash("sha256").update(password).digest("hex");
}

// ruleid: kisa-2-6-hardcoded-secret-js
const DB_PASSWORD = "s3cr3t-pass";
// ruleid: kisa-2-6-hardcoded-secret-js
const config = { apiKey: "sk-live-1234567890" };
// ok: kisa-2-6-hardcoded-secret-js
const dbPasswordFromEnv = process.env.DB_PASSWORD;
// ok: kisa-2-6-hardcoded-secret-js
const tokenHeader = "";

function tokens() {
  // ruleid: kisa-2-8-insecure-random-js
  const resetToken = Math.random().toString(36).slice(2);
  // ok: kisa-2-8-insecure-random-js
  const sessionToken = crypto.randomBytes(32).toString("hex");
  // ok: kisa-2-8-insecure-random-js
  const jitter = Math.random() * 100;
  return { resetToken, sessionToken, jitter };
}

function claims(token) {
  // ruleid: kisa-2-10-jwt-signature-not-verified-js
  const unverified = jwt.decode(token);
  // ruleid: kisa-2-10-jwt-signature-not-verified-js
  const none = jwt.verify(token, key, { algorithms: ["HS256", "none"] });
  // ok: kisa-2-10-jwt-signature-not-verified-js
  const verified = jwt.verify(token, key, { algorithms: ["HS256"] });
  return { unverified, none, verified };
}

// ruleid: kisa-2-11-tls-verification-disabled-js
const agent = new https.Agent({ rejectUnauthorized: false });
// ok: kisa-2-11-tls-verification-disabled-js
const trusted = new https.Agent({ ca: fs.readFileSync("/etc/ssl/internal-ca.pem") });

app.post("/login", (req, res) => {
  // ruleid: kisa-2-12-insecure-cookie-js
  res.cookie("sid", sessionId, { httpOnly: false, secure: true });
  // ok: kisa-2-12-insecure-cookie-js
  res.cookie("sid", sessionId, { httpOnly: true, secure: true, sameSite: "lax" });
  res.end();
});

app.get("/report", (req, res) => {
  try {
    res.json(buildReport());
  } catch (error) {
    // ruleid: kisa-4-1-error-detail-exposed-js
    res.status(500).send(error.stack);
  }
});

app.get("/report-safe", (req, res) => {
  try {
    res.json(buildReport());
  } catch (error) {
    console.error(error);
    // ok: kisa-4-1-error-detail-exposed-js
    res.status(500).send("internal error");
  }
});

function cleanup(file) {
  // ruleid: kisa-4-2-swallowed-exception-js
  try {
    fs.unlinkSync(file);
  } catch (error) {}
  // ok: kisa-4-2-swallowed-exception-js
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function inspect(value) {
  // ruleid: kisa-6-2-debug-code-js
  debugger;
  return value;
}

module.exports = { app, digests, tokens, claims, cleanup, inspect, agent, trusted, config, DB_PASSWORD, dbPasswordFromEnv, tokenHeader };
