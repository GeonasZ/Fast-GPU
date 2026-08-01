const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createImageProfileStore, parseInstallPlan, DEFAULT_VM_STARTUP_SCRIPT} = require('../lib/image-profile-store');

test('startup behavior store seeds five Docker presets and one VM preset', () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-image-profile-'));
  const store=createImageProfileStore({FLEET_DATABASE_PATH:path.join(directory,'fleet.sqlite')});
  try {
    const profiles=store.list();
    assert.equal(profiles.length,6);
    assert.equal(profiles.filter(item=>item.profileType==='docker').length,5);
    assert.equal(profiles.filter(item=>item.profileType==='vm').length,1);
    assert.equal(profiles.filter(item=>item.kind==='complete').length,3);
    assert.equal(profiles.filter(item=>item.kind==='base').length,2);
    assert.ok(profiles.every(item=>item.isPreset&&item.presetScript));
    assert.ok(profiles.every(item=>item.systemSteps.includes('ssh')));
    assert.doesNotMatch(profiles.find(item=>item.id==='preset-pytorch-2.11').startupScript,/openssh-server/);
    assert.match(profiles.find(item=>item.id==='preset-vm-default').startupScript,/@openai\/codex/);
    assert.match(DEFAULT_VM_STARTUP_SCRIPT,/build-essential/);
    assert.match(DEFAULT_VM_STARTUP_SCRIPT,/torch torchvision torchaudio/);
    assert.throws(()=>store.remove(profiles[0].id),error=>error.status===409);
  } finally {store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('custom image profiles persist scripts and discard the removed predownload field', () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-image-profile-'));
  const filename=path.join(directory,'fleet.sqlite');
  let store=createImageProfileStore({FLEET_DATABASE_PATH:filename});
  try {
    const profile=store.create({name:'Research image',image:'ubuntu:24.04',cudaMajor:13,downloads:['https://example.test/model.bin'],startupScript:'apt-get install -y git\npip install torchmetrics'});
    assert.equal(profile.downloads.length,0);
    assert.ok(profile.installPlan.some(item=>item.type==='apt'&&item.value==='git'));
    store.close();
    store=createImageProfileStore({FLEET_DATABASE_PATH:filename});
    assert.equal(store.get(profile.id).startupScript.includes('torchmetrics'),true);
    assert.equal(store.create({...profile,name:'without downloads',downloads:['https://example.test/ignored.bin']}).downloads.length,0);
  } finally {store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('Docker startup behavior requires an image while VM may use the platform default', () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-image-profile-'));
  const store=createImageProfileStore({FLEET_DATABASE_PATH:path.join(directory,'fleet.sqlite')});
  try {
    assert.throws(()=>store.create({name:'Script only',profileType:'docker',image:'',cudaMajor:12,startupScript:'echo ready'}),error=>error.code==='docker_image_required');
    const profile=store.create({name:'VM script only',profileType:'vm',image:'',cudaMajor:13,startupScript:'echo ready'});
    assert.equal(profile.image,'');
    assert.equal(profile.profileType,'vm');
  } finally {store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('startup script parser presents common package managers without claiming completeness', () => {
  const plan=parseInstallPlan('apt-get install -y curl git\nnpm install -g @openai/codex\ncurl -fsSL https://deb.nodesource.com/setup_22.x | bash -');
  assert.ok(plan.some(item=>item.type==='apt'&&item.value==='curl'));
  assert.ok(plan.some(item=>item.type==='npm'&&item.value==='@openai/codex'));
  assert.ok(plan.some(item=>item.type==='fetch'&&item.value==='https://deb.nodesource.com/setup_22.x'));
});

test('local startup scripts persist only their path and are reread before launch', () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-image-profile-'));
  const scriptPath=path.join(directory,'startup.sh');
  fs.writeFileSync(scriptPath,'echo first\n');
  const store=createImageProfileStore({FLEET_DATABASE_PATH:path.join(directory,'fleet.sqlite')});
  try {
    const profile=store.create({name:'Local script',image:'ubuntu:24.04',cudaMajor:12,startupScript:'echo stale',startupScriptPath:scriptPath});
    assert.equal(profile.startupScript,'');
    assert.equal(profile.startupScriptPath,scriptPath);
    assert.equal(profile.localFileExists,true);
    assert.equal(store.resolveStartupScript(profile.id),'echo first\n');
    fs.writeFileSync(scriptPath,'echo updated\n');
    assert.equal(store.resolveStartupScript(profile.id),'echo updated\n');
    fs.unlinkSync(scriptPath);
    assert.equal(store.get(profile.id).localFileExists,false);
    assert.throws(()=>store.resolveStartupScript(profile.id),error=>error.code==='local_startup_script_missing');
  } finally {store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('desktop image management supports choosing and dropping a local startup script', () => {
  const root=path.join(__dirname,'..');
  const read=file=>fs.readFileSync(path.join(root,file),'utf8');
  assert.match(read('electron-preload.js'),/getPathForFile/);
  assert.match(read('local-client.js'),/dialog:pick-startup-script/);
  assert.match(read('public/image-management.js'),/localStartupScriptDrop/);
  assert.match(read('public/image-management.js'),/missing-local-file/);
  assert.match(read('public/image-management.js'),/lastFocusedImageProfileId/);
  assert.match(read('public/image-management.js'),/profileType === "vm" \? '<option value="">/);
  assert.match(read('public/providers-page.js'),/localFileExists\s*===\s*false/);
});

test('launch UI and bootstrap carry a selected image profile script', () => {
  const root=path.join(__dirname,'..');
  const read=file=>fs.readFileSync(path.join(root,file),'utf8');
  assert.match(read('public/providers-page.js'),/imageProfileId:/);
  assert.match(read('public/providers-page.js'),/launch\.profileType!=="docker"/);
  assert.match(read('server.js'),/launch\.profileType === "docker"/);
  assert.match(read('server.js'),/launch\.profileType === "vm"/);
  assert.match(read('server.js'),/instanceLaunchProfiles/);
  assert.match(read('agent/bootstrap.sh'),/run_configured_startup/);
  assert.match(read('server.js'),/values\.FLEET_STARTUP_SCRIPT_B64/);
  assert.match(read('lib/cloud_compute/hyperstack/runtime.js'),/values\.FLEET_VM_STARTUP_SCRIPT_B64/);
  assert.match(read('lib/cloud_compute/hyperstack/agent/hyperstack.sh'),/run_vm_startup/);
  assert.match(read('server.js'),/d\.imageUrl = vmProfile\.image \|\| resolveCuda13Image/);
});
