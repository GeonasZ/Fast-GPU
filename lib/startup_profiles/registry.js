const fs = require('node:fs');
const path = require('node:path');

let cached;
function entries(env = process.env) {
  const repository = String(
    env.FLEET_RUNTIME_IMAGE_REPOSITORY ||
      'ghcr.io/geonasz/gpu-scheduling-platform-runtime',
  ).replace(/\/+$/, '');
  if (cached?.repository === repository) return cached.entries;
  const profiles = fs.readdirSync(__dirname, { withFileTypes: true })
    .filter(item => item.isDirectory())
    .map(item => {
      const directory = path.join(__dirname, item.name),
        declaration = path.join(directory, 'profile.yaml'),
        script = path.join(directory, 'startup.sh');
      if (!fs.existsSync(declaration) || !fs.existsSync(script)) return null;
      const config = JSON.parse(fs.readFileSync(declaration, 'utf8'));
      if (config.directory !== item.name || !config.id || !config.name)
        throw new Error(`Invalid startup profile declaration: ${declaration}`);
      return Object.freeze({
        id: config.id,
        name: config.name,
        profileType: config.profileType,
        image: String(config.image || '').replaceAll('{repository}', repository),
        cudaMajor: Number(config.cudaMajor),
        kind: config.kind,
        recommended: Boolean(config.recommended),
        defaultRole: config.defaultRole || '',
        refreshWhenScriptShorterThan: Number(config.refreshWhenScriptShorterThan || 0),
        script: fs.readFileSync(script, 'utf8'),
      });
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
  cached = { repository, entries: Object.freeze(profiles) };
  return cached.entries;
}

function defaultScript(role, env = process.env) {
  const profile = entries(env).find(item => item.defaultRole === role);
  if (!profile) throw new Error(`Missing startup profile default role: ${role}`);
  return profile.script;
}

module.exports = { entries, defaultScript };
