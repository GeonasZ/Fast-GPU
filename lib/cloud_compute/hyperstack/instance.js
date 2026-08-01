const { createInstanceCapabilities } = require('../common/instance-capabilities');

module.exports = createInstanceCapabilities({
  allowDefaultPort: true,
  useInternalPort: true,
  defaultAdoptionUser: 'ubuntu',
});
