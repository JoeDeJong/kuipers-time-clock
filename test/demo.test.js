'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('../demo/build');

test('demo builds from the current app pages', () => {
  const { full } = build();
  assert.match(full, /^<!doctype html>/);
  assert.ok(full.includes('id="kioskApp"') && full.includes('id="adminApp"'));
});

test('docs/index.html is up to date (run "npm run build:demo")', () => {
  const docs = fs.readFileSync(path.join(__dirname, '..', 'docs', 'index.html'), 'utf8');
  assert.equal(docs, build().full, 'docs/index.html is stale: run "npm run build:demo" and commit the result');
});
