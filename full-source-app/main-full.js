"use strict";

const fs = require("node:fs");
const path = require("node:path");

function writeBootstrapLog(message) {
  try {
    const dir = path.join(require("electron").app.getPath("userData"), "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "full-source-bootstrap.log"),
      `[${new Date().toISOString()}] ${message}\n`,
      "utf8",
    );
  } catch {
    /* ignore */
  }
}

process.env.INTEGRITY_VERIFY_ENABLED = "0";
process.env.CAPTCHA_PROVIDER = "cdp";
process.env.BROWSER_RUNTIME = process.env.BROWSER_RUNTIME || "chrome";

process.on("uncaughtException", (error) => {
  writeBootstrapLog(`uncaughtException ${error?.stack || error}`);
});

process.on("unhandledRejection", (error) => {
  writeBootstrapLog(`unhandledRejection ${error?.stack || error}`);
});

writeBootstrapLog("bootstrap start");
require("./apps/electron/dist/main/main.js");
writeBootstrapLog("main required");
