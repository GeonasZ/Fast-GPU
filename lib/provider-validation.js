const { entries: cloudProviderEntries } = require('./cloud_compute/registry');
const { entries: s3ProviderEntries } = require('./s3/registry');

function validateProviderConfiguration(providerId, env, publicControlPlaneError) {
  const errors = [];
  if (env.BASE_URL) {
    const issue = publicControlPlaneError(env.BASE_URL);
    if (issue) errors.push(`公网 HTTPS BASE_URL（${issue}）`);
  }
  for (const entry of s3ProviderEntries()) {
    const enabled = entry.config.fields.find(field => field.id === 'enabled');
    if (!enabled || env[enabled.storageKey] !== '1') continue;
    if (entry.config.fields.some(field => field.required && !env[field.storageKey])) {
      errors.push(`完整 ${entry.config.validationLabel || entry.config.title} 配置`);
    }
  }
  const provider = cloudProviderEntries().find(entry => entry.id === providerId);
  for (const requirement of provider?.config.provisioningRequirements || []) {
    const anySatisfied = !requirement.anyOf?.length || requirement.anyOf.some(key => env[key]);
    const allSatisfied = !requirement.allOf?.length || requirement.allOf.every(key => env[key]);
    if (!anySatisfied || !allSatisfied) errors.push(requirement.label);
  }
  return errors;
}

module.exports = { validateProviderConfiguration };
