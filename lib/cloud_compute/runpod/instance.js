const { createInstanceCapabilities } = require('../common/instance-capabilities');

module.exports = createInstanceCapabilities({
  allowDefaultPort: false,
  defaultAdoptionUser: 'root',
});
