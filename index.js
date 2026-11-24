'use strict';
/**
 * Root entry point for hosts that look for index.js / server.js.
 * Uses the compiled output and builds it first when it is missing, so a skipped build step
 * on the server cannot leave the app without a `dist` folder.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const entry = path.join(__dirname, 'dist', 'interfaces', 'http', 'server.js');

if (!fs.existsSync(entry)) {
  console.log('dist/ not found - running "npm run build" first');
  execSync('npm run build', { stdio: 'inherit', cwd: __dirname });
}

require(entry);
