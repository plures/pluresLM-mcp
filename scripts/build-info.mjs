#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
let gitSha = 'unknown';
try { gitSha = execSync('git rev-parse --short HEAD').toString().trim(); } catch {}

writeFileSync('dist/BUILD_INFO.json', JSON.stringify({
  version: pkg.version,
  gitSha,
  buildTime: new Date().toISOString(),
}, null, 2));

console.log(`BUILD_INFO: v${pkg.version} (${gitSha})`);
