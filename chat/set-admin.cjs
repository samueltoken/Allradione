// Run interactively from a terminal with the Allradione Cloudflare profile.
'use strict';
const { randomBytes, pbkdf2Sync } = require('node:crypto');
const { Writable } = require('node:stream');
const { createInterface } = require('node:readline/promises');
const { spawn } = require('node:child_process');
const path = require('node:path');
function makeVerifier(id, password) {
  const proof = pbkdf2Sync(password,'Allradione admin login v1:'+id,600000,32,'sha256');
  const salt = randomBytes(32);
  const input = Buffer.from(JSON.stringify([id,proof.toString('base64')]));
  try {
    const hash = pbkdf2Sync(input,salt,100000,32,'sha256');
    return JSON.stringify({v:1,iterations:100000,salt:salt.toString('base64'),hash:hash.toString('base64')});
  } finally { input.fill(0); proof.fill(0); }
}
async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Open an interactive terminal.');
  const silent = new Writable({write(_chunk,_enc,done){ done(); }});
  const rl = createInterface({input:process.stdin,output:silent,terminal:true,historySize:0});
  async function ask(label) {
    process.stdout.write(label);
    try { return await rl.question(''); } finally { process.stdout.write('\n'); }
  }
  let verifier;
  try {
    const id = await ask('Administrator ID (hidden): ');
    const password = await ask('New password (hidden): ');
    const again = await ask('Confirm new password (hidden): ');
    if (!id || id.length>128 || password.length<12 || password!==again) throw new Error('Check the ID, password length (12 or more) and confirmation.');
    verifier = makeVerifier(id,password);
  } finally { rl.close(); }
  const config = path.join(__dirname,'wrangler.jsonc');
  const env = {...process.env, WRANGLER_SEND_METRICS:'false'};
  if (process.platform==='win32') env.XDG_CONFIG_HOME = path.join(process.env.LOCALAPPDATA,'Allradione-Cloudflare');
  const cli = path.join(__dirname,'node_modules','wrangler','bin','wrangler.js');
  const child = spawn(process.execPath,[cli,'secret','put','ADMIN_VERIFIER','--config',config],{
    cwd:__dirname, env, stdio:['pipe','inherit','inherit'],shell:false
  });
  const exit = new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);child.stdin.once('error',reject);});
  child.stdin.end(verifier);
  if (await exit !== 0) throw new Error('Secret update failed.');
}
module.exports={makeVerifier};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
