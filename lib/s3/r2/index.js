const storage = require('../common');
function normalizeEndpoint(value) { return String(value || '').trim().replace(/\/+$/, ''); }
module.exports = {
  ...storage,
  normalizeEndpoint,
  defaultRegion: 'auto',
  rcloneProvider: 'Cloudflare',
  resolveRegion(value) { return value || 'auto'; },
};
