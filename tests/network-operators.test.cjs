const test = require('node:test');
const assert = require('node:assert/strict');
const {networkOperator} = require('../electron/network-operators.mjs');

test('an identified channel on a shared server uses its own operator and country', () => {
  const nrj = networkOperator({url: 'https://streaming.nrjaudio.fm/oumvmk8fnozc?origine=radiodns'});
  assert.equal(nrj.country, 'FR');
  assert.equal(nrj.operatorName, 'NRJ Group');
  assert.equal(networkOperator({url: 'https://streaming.nrjaudio.fm/another-station'}), undefined);
  assert.equal(networkOperator({url: 'https://streaming.nrjaudio.fm.unrelated.example/oumvmk8fnozc'}), undefined);
});
