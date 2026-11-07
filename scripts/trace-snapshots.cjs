'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Test diagnostics only. A reader may keep a completed snapshot open on Windows;
// later events must never replace, rename or delete that reader's file.
function createTraceWriter(directory) {
  let sequence = 0;
  return value => {
    const name = String(++sequence).padStart(8, '0');
    const snapshot = path.join(directory, `${name}.json`);
    fs.writeFileSync(snapshot, JSON.stringify(value, null, 2), { flag: 'wx' });
    // writeFileSync has closed the JSON file before it becomes visible to readers.
    fs.writeFileSync(path.join(directory, `${name}.complete`), '', { flag: 'wx' });
  };
}

async function readLatestTrace(directory) {
  const completed = (await fs.promises.readdir(directory))
    .filter(name => /^\d{8}\.complete$/.test(name))
    .sort();
  if (!completed.length) {
    const error = new Error('No completed trace snapshot');
    error.code = 'ENOENT';
    throw error;
  }
  const snapshot = completed.at(-1).replace(/\.complete$/, '.json');
  return JSON.parse(await fs.promises.readFile(path.join(directory, snapshot), 'utf8'));
}

module.exports = { createTraceWriter, readLatestTrace };
