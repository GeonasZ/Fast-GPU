const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {resolveCustomRuntimeImage} = require('./runtime-images');

const DEFAULT_RUNTIME_REPOSITORY = 'ghcr.io/geonasz/gpu-scheduling-platform-runtime';
const DEFAULT_STARTUP_SCRIPT = `#!/usr/bin/env bash
set -Eeuo pipefail

# Fast GPU default startup script. CUDA and PyTorch belong in the image.
if ! command -v sshd >/dev/null 2>&1; then
  apt-get update
  apt-get install -y --no-install-recommends openssh-server
fi
`;
const BASE_IMAGE_SCRIPT = `${DEFAULT_STARTUP_SCRIPT}
apt-get update
apt-get install -y --no-install-recommends \\
  ca-certificates curl git jq build-essential cmake python3 python3-pip nodejs npm
npm install -g --bin-links=true @openai/codex@latest @anthropic-ai/claude-code@latest
`;

function presetDefinitions(env = process.env) {
  const repository = String(env.FLEET_RUNTIME_IMAGE_REPOSITORY || DEFAULT_RUNTIME_REPOSITORY).replace(/\/+$/, '');
  return [
    {id:'preset-pytorch-2.11',name:'PyTorch 2.11 / CUDA 13.2 完整环境',image:`${repository}:pytorch-2.11-cuda13.2-ngc26.03`,cudaMajor:13,kind:'complete',recommended:true,script:DEFAULT_STARTUP_SCRIPT},
    {id:'preset-pytorch-2.10',name:'PyTorch 2.10 / CUDA 13.1 完整环境',image:`${repository}:pytorch-2.10-cuda13.1-ngc26.01`,cudaMajor:13,kind:'complete',script:DEFAULT_STARTUP_SCRIPT},
    {id:'preset-pytorch-2.7',name:'PyTorch 2.7 / CUDA 12.8 完整环境',image:`${repository}:pytorch-2.7-cuda12.8-ngc25.03`,cudaMajor:12,kind:'complete',script:DEFAULT_STARTUP_SCRIPT},
    {id:'preset-ngc-25.01',name:'NGC 25.01 基础环境 + 开发工具',image:'nvcr.io/nvidia/pytorch:25.01-py3',cudaMajor:12,kind:'base',script:BASE_IMAGE_SCRIPT},
    {id:'preset-ngc-24.10',name:'NGC 24.10 基础环境 + 开发工具',image:'nvcr.io/nvidia/pytorch:24.10-py3',cudaMajor:12,kind:'base',script:BASE_IMAGE_SCRIPT},
  ];
}

function parseInstallPlan(script, downloads = []) {
  const text = String(script || '').replace(/\\\r?\n/g, ' ');
  const results = downloads.map(value => ({type:'download', value}));
  const patterns = [
    ['apt', /(?:apt-get|apt)\s+install(?:\s+-[^\s]+)*\s+([^;&\n]+)/g],
    ['pip', /(?:pip3?|python3?\s+-m\s+pip)\s+install(?:\s+-[^\s]+)*\s+([^;&\n]+)/g],
    ['npm', /npm\s+install(?:\s+-[^\s]+)*\s+([^;&\n]+)/g],
    ['download', /(?:curl|wget)\b[^\n]*(https?:\/\/[^\s'";]+)/g],
  ];
  for (const [type, pattern] of patterns) {
    for (const match of text.matchAll(pattern)) {
      const values = type === 'download' ? [match[1]] : match[1].trim().split(/\s+/).filter(value => !value.startsWith('-'));
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
  const presets = presetDefinitions(env);
  const insert = db.prepare('INSERT INTO image_profiles (id,name,image,cuda_major,kind,downloads_json,startup_script,is_preset,recommended,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const now = new Date().toISOString();
  for (const preset of presets) {
    if (!db.prepare('SELECT 1 FROM image_profiles WHERE id=?').get(preset.id))
      insert.run(preset.id,preset.name,preset.image,preset.cudaMajor,preset.kind,'[]',preset.script,1,preset.recommended?1:0,now,now);
  }
  const row = record => {
    if (!record) return null;
    let downloads=[]; try { downloads=JSON.parse(record.downloads_json||'[]'); } catch {}
    const preset=presets.find(item=>item.id===record.id);
    return {id:record.id,name:record.name,image:record.image,cudaMajor:Number(record.cuda_major),kind:record.kind,downloads,startupScript:record.startup_script,isPreset:Boolean(record.is_preset),recommended:Boolean(record.recommended),presetScript:preset?.script||DEFAULT_STARTUP_SCRIPT,installPlan:parseInstallPlan(record.startup_script,downloads),createdAt:record.created_at,updatedAt:record.updated_at};
  };
  const getStatement=db.prepare('SELECT * FROM image_profiles WHERE id=?');
  function validate(input) {
    const name=String(input.name||'').trim();
    if(!name||name.length>120)throw Object.assign(Error('配置名称长度必须为 1-120 个字符'),{status:400});
    const image=resolveCustomRuntimeImage(input.image,input.cudaMajor);
    const downloads=Array.isArray(input.downloads)?input.downloads.map(value=>String(value).trim()).filter(Boolean):[];
    if(downloads.length>30||downloads.some(value=>value.length>2048||!/^https?:\/\//i.test(value)))throw Object.assign(Error('下载地址必须是 HTTP/HTTPS URL，最多 30 条'),{status:400});
    const startupScript=String(input.startupScript??'');
    if(Buffer.byteLength(startupScript,'utf8')>256*1024)throw Object.assign(Error('启动脚本不能超过 256 KiB'),{status:400});
    return{name,image:image.image,cudaMajor:image.cudaMajor,downloads,startupScript,kind:['complete','base','custom'].includes(input.kind)?input.kind:'custom'};
  }
  return {
    list(){return db.prepare('SELECT * FROM image_profiles ORDER BY recommended DESC,is_preset DESC,rowid').all().map(row)},
    get(id){return row(getStatement.get(String(id||'')))},
    create(input){const value=validate(input),id=`profile-${randomUUID()}`,at=new Date().toISOString();insert.run(id,value.name,value.image,value.cudaMajor,value.kind,JSON.stringify(value.downloads),value.startupScript,0,0,at,at);return this.get(id)},
    update(id,input){const existing=this.get(id);if(!existing)throw Object.assign(Error('镜像配置不存在'),{status:404});const value=validate(input),at=new Date().toISOString();db.prepare('UPDATE image_profiles SET name=?,image=?,cuda_major=?,kind=?,downloads_json=?,startup_script=?,updated_at=? WHERE id=?').run(value.name,value.image,value.cudaMajor,value.kind,JSON.stringify(value.downloads),value.startupScript,at,id);return this.get(id)},
    remove(id){const existing=this.get(id);if(!existing)throw Object.assign(Error('镜像配置不存在'),{status:404});if(existing.isPreset)throw Object.assign(Error('系统预设不可删除，可以修改或重新载入预设脚本'),{status:409});db.prepare('DELETE FROM image_profiles WHERE id=?').run(id)},
    defaults(){return {startupScript:DEFAULT_STARTUP_SCRIPT,baseImageScript:BASE_IMAGE_SCRIPT,presets}},
    close(){db.close()},
  };
}

module.exports={createImageProfileStore,presetDefinitions,parseInstallPlan,DEFAULT_STARTUP_SCRIPT,BASE_IMAGE_SCRIPT};
