const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createImageProfileStore, parseInstallPlan} = require('../lib/image-profile-store');

test('image profile store seeds five editable system presets', () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-image-profile-'));
  const store=createImageProfileStore({FLEET_DATABASE_PATH:path.join(directory,'fleet.sqlite')});
  try {
    const profiles=store.list();
    assert.equal(profiles.length,5);
    assert.equal(profiles.filter(item=>item.kind==='complete').length,3);
    assert.equal(profiles.filter(item=>item.kind==='base').length,2);
    assert.ok(profiles.every(item=>item.isPreset&&item.presetScript));
    assert.throws(()=>store.remove(profiles[0].id),error=>error.status===409);
  } finally {store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('custom image profiles persist scripts and validated downloads', () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-image-profile-'));
  const filename=path.join(directory,'fleet.sqlite');
  let store=createImageProfileStore({FLEET_DATABASE_PATH:filename});
  try {
    const profile=store.create({name:'Research image',image:'ubuntu:24.04',cudaMajor:13,downloads:['https://example.test/model.bin'],startupScript:'apt-get install -y git\npip install torchmetrics'});
    assert.equal(profile.downloads.length,1);
    assert.ok(profile.installPlan.some(item=>item.type==='apt'&&item.value==='git'));
    store.close();
    store=createImageProfileStore({FLEET_DATABASE_PATH:filename});
    assert.equal(store.get(profile.id).startupScript.includes('torchmetrics'),true);
    assert.throws(()=>store.create({...profile,name:'bad',downloads:['file:///etc/passwd']}),error=>error.status===400);
  } finally {store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('startup script parser presents common package managers without claiming completeness', () => {
  const plan=parseInstallPlan('apt-get install -y curl git\nnpm install -g @openai/codex\ncurl -fsSL https://example.test/a.sh');
  assert.ok(plan.some(item=>item.type==='apt'&&item.value==='curl'));
  assert.ok(plan.some(item=>item.type==='npm'&&item.value==='@openai/codex'));
  assert.ok(plan.some(item=>item.type==='download'&&item.value==='https://example.test/a.sh'));
});

test('launch UI and bootstrap carry a selected image profile script', () => {
  const root=path.join(__dirname,'..');
  const read=file=>fs.readFileSync(path.join(root,file),'utf8');
  assert.match(read('public/providers-page.js'),/imageProfileId:/);
  assert.match(read('server.js'),/instanceLaunchProfiles/);
  assert.match(read('agent/bootstrap.sh'),/run_configured_startup/);
  assert.match(read('lib/provider-startup/hyperstack.js'),/FLEET_STARTUP_SCRIPT_B64/);
});
