// Compatibility facade. Provider implementations live exclusively under
// cloud_compute/<provider>; new code should import the registry directly.
const { adapters, entries } = require('./cloud_compute/registry');
const {
  ProviderError,
  normalizeStatus,
} = require('./cloud_compute/common');

const legacyExports = Object.assign(
  {},
  ...entries().map(entry => entry.implementation.legacyExports || {}),
);
module.exports = {
  adapters,
  ProviderError,
  normalizeStatus,
  ...legacyExports,
};
