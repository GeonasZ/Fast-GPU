const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {resolveCustomRuntimeImage} = require('./runtime-images');

const startupProfiles = require('./startup_profiles/registry');

function presetDefinitions(env = process.env) {
  return startupProfiles.entries(env).map(profile => ({ ...profile }));
}

const DEFAULT_STARTUP_SCRIPT = startupProfiles.defaultScript('docker');
const BASE_IMAGE_SCRIPT = startupProfiles.defaultScript('base');
const DEFAULT_VM_STARTUP_SCRIPT = startupProfiles.defaultScript('vm');

function parseInstallPlan(script) {
  const text = String(script || '').replace(/\\\r?\n/g, ' ');
  const results = [];
  const patterns = [
    ['apt', /(?:apt-get|apt)\s+install(?:\s+-[^\s]+)*\s+([^;&\n]+)/g],
    ['pip', /(?:pip3?|python3?\s+-m\s+pip)\s+install(?:\s+-[^\s]+)*\s+([^;&\n]+)/g],
    ['npm', /npm\s+install(?:\s+-[^\s]+)*\s+([^;&\n]+)/g],
    ['fetch', /(?:curl|wget)\b[^\n]*?\b(https?:\/\/[^\s'";|]+)/g],
  ];
  for (const [type, pattern] of patterns) {
    for (const match of text.matchAll(pattern)) {
      const values = type === 'fetch' ? [match[1]] : match[1].trim().split(/\s+/).filter(value => !value.startsWith('-'));
      for (const value of values) results.push({type, value});
    }
  }
  return results.filter((item, index) =>
    results.findIndex(other => other.type === item.type && other.value === item.value) === index
  ).slice(0, 80);
}

function createImageProfileStore(env = process.env) {
  const filename = path.resolve(env.FLEET_DATABASE_PATH || path.join(__dirname, '..', '.data', 'fleet.sqlite'));
  fs.mkdirSync(path.dirname(filename), {recursive:true});
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS image_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      image TEXT NOT NULL,
      cuda_major INTEGER NOT NULL,
      kind TEXT NOT NULL,
      downloads_json TEXT NOT NULL DEFAULT '[]',
      startup_script TEXT NOT NULL,
      is_preset INTEGER NOT NULL DEFAULT 0,
      recommended INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(image_profiles)').all().map(column => column.name));
  if (!columns.has('startup_script_path'))
    db.exec("ALTER TABLE image_profiles ADD COLUMN startup_script_path TEXT NOT NULL DEFAULT ''");
  if (!columns.has('profile_type'))
    db.exec("ALTER TABLE image_profiles ADD COLUMN profile_type TEXT NOT NULL DEFAULT 'docker'");
  const presets = presetDefinitions(env);
  const insert = db.prepare('INSERT INTO image_profiles (id,name,image,cuda_major,kind,downloads_json,startup_script,startup_script_path,profile_type,is_preset,recommended,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const now = new Date().toISOString();
  for (const preset of presets) {
    if (!db.prepare('SELECT 1 FROM image_profiles WHERE id=?').get(preset.id))
      insert.run(preset.id,preset.name,preset.image,preset.cudaMajor,preset.kind,'[]',preset.script,'',preset.profileType,1,preset.recommended?1:0,now,now);
  }
  const refreshPresetScript = db.prepare(
    'UPDATE image_profiles SET startup_script=?,updated_at=? WHERE id=? AND is_preset=1 AND length(startup_script)<?',
  );
  for (const preset of presets)
    if (preset.refreshWhenScriptShorterThan > 0)
      refreshPresetScript.run(
        preset.script,
        now,
        preset.id,
        preset.refreshWhenScriptShorterThan,
      );
  const row = record => {
    if (!record) return null;
    const preset=presets.find(item=>item.id===record.id);
    const startupScriptPath=String(record.startup_script_path||'');
    let localFileExists=true,planScript=record.startup_script;
    if(startupScriptPath){try{const stat=fs.statSync(startupScriptPath);localFileExists=stat.isFile();if(localFileExists&&stat.size<=256*1024)planScript=fs.readFileSync(startupScriptPath,'utf8')}catch{localFileExists=false}}
    return {id:record.id,name:record.name,profileType:record.profile_type||'docker',image:record.image,cudaMajor:Number(record.cuda_major),kind:record.kind,downloads:[],startupScript:record.startup_script,startupScriptPath,scriptSource:startupScriptPath?'local':'editor',localFileExists,systemSteps:['ssh'],isPreset:Boolean(record.is_preset),recommended:Boolean(record.recommended),presetScript:preset?.script||(record.profile_type==='vm'?DEFAULT_VM_STARTUP_SCRIPT:DEFAULT_STARTUP_SCRIPT),installPlan:parseInstallPlan(planScript),createdAt:record.created_at,updatedAt:record.updated_at};
  };
  const getStatement=db.prepare('SELECT * FROM image_profiles WHERE id=?');
  function validate(input) {
    const name=String(input.name||'').trim();
    if(!name||name.length>120)throw Object.assign(Error('配置名称长度必须为 1-120 个字符'),{status:400});
    const profileType=input.profileType==='vm'?'vm':'docker';
    const imageValue=String(input.image||'').trim();
    const cudaMajor=Number(input.cudaMajor)||13;
    if(profileType==='docker'&&!imageValue)throw Object.assign(Error('Docker 配置必须选择镜像'),{status:400,code:'docker_image_required'});
    if(![12,13].includes(cudaMajor))throw Object.assign(Error('配置必须注明 CUDA 12 或 CUDA 13'),{status:400,code:'invalid_custom_image_cuda'});
    const image=imageValue?resolveCustomRuntimeImage(imageValue,cudaMajor):{image:'',cudaMajor};
    const downloads=[];
    const startupScript=String(input.startupScript??'');
    if(Buffer.byteLength(startupScript,'utf8')>256*1024)throw Object.assign(Error('启动脚本不能超过 256 KiB'),{status:400});
    const startupScriptPath=String(input.startupScriptPath||'').trim();
    if(startupScriptPath&&(!path.isAbsolute(startupScriptPath)||startupScriptPath.length>4096))throw Object.assign(Error('本地启动脚本必须使用有效的绝对路径'),{status:400,code:'invalid_local_startup_script'});
    return{name,profileType,image:image.image,cudaMajor:image.cudaMajor,downloads,startupScript:startupScriptPath?'':startupScript,startupScriptPath,kind:profileType==='vm'?'vm':['complete','base','custom'].includes(input.kind)?input.kind:'custom'};
  }
  return {
    list(){return db.prepare('SELECT * FROM image_profiles ORDER BY recommended DESC,is_preset DESC,rowid').all().map(row)},
    get(id){return row(getStatement.get(String(id||'')))},
    create(input){const value=validate(input),id=`profile-${randomUUID()}`,at=new Date().toISOString();insert.run(id,value.name,value.image,value.cudaMajor,value.kind,JSON.stringify(value.downloads),value.startupScript,value.startupScriptPath,value.profileType,0,0,at,at);return this.get(id)},
    update(id,input){const existing=this.get(id);if(!existing)throw Object.assign(Error('开机行为不存在'),{status:404});const value=validate(input),at=new Date().toISOString();db.prepare('UPDATE image_profiles SET name=?,image=?,cuda_major=?,kind=?,downloads_json=?,startup_script=?,startup_script_path=?,profile_type=?,updated_at=? WHERE id=?').run(value.name,value.image,value.cudaMajor,value.kind,JSON.stringify(value.downloads),value.startupScript,value.startupScriptPath,value.profileType,at,id);return this.get(id)},
    resolveStartupScript(profileOrId){const profile=typeof profileOrId==='string'?this.get(profileOrId):profileOrId;if(!profile)throw Object.assign(Error('镜像配置不存在'),{status:404});if(!profile.startupScriptPath)return profile.startupScript||'';let stat;try{stat=fs.statSync(profile.startupScriptPath)}catch{throw Object.assign(Error(`本地启动脚本不存在：${profile.startupScriptPath}`),{status:409,code:'local_startup_script_missing',profileId:profile.id})}if(!stat.isFile())throw Object.assign(Error(`本地启动脚本不是文件：${profile.startupScriptPath}`),{status:409,code:'local_startup_script_invalid',profileId:profile.id});if(stat.size>256*1024)throw Object.assign(Error('本地启动脚本不能超过 256 KiB'),{status:409,code:'local_startup_script_too_large',profileId:profile.id});return fs.readFileSync(profile.startupScriptPath,'utf8')},
    remove(id){const existing=this.get(id);if(!existing)throw Object.assign(Error('镜像配置不存在'),{status:404});if(existing.isPreset)throw Object.assign(Error('系统预设不可删除，可以修改或重新载入预设脚本'),{status:409});db.prepare('DELETE FROM image_profiles WHERE id=?').run(id)},
    defaults(){return {startupScript:DEFAULT_STARTUP_SCRIPT,vmStartupScript:DEFAULT_VM_STARTUP_SCRIPT,baseImageScript:BASE_IMAGE_SCRIPT,presets}},
    close(){db.close()},
  };
}

module.exports={createImageProfileStore,presetDefinitions,parseInstallPlan,DEFAULT_STARTUP_SCRIPT,DEFAULT_VM_STARTUP_SCRIPT,BASE_IMAGE_SCRIPT};
