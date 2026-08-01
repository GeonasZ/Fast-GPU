const storage = require('../common');
function normalizeEndpoint(value) { return String(value || '').trim().replace(/\/+$/, ''); }
module.exports = {
  ...storage,
  normalizeEndpoint,
  defaultRegion: '',
  rcloneProvider: 'Alibaba',
  resolveRegion(value) { return value || ''; },
};
