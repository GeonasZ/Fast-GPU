(() => {
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(
    /[&<>"']/g,
    character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character],
  );
  let recoveredInstances = [];
  let refreshTimer;

  async function request(url, options) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) throw Object.assign(
      new Error(data.error || `HTTP ${response.status}`),
      {code: data.code},
    );
    return data;
  }

  function notify(message) {
    if (typeof globalThis.toast === 'function') globalThis.toast(message);
  }

  function installFields() {
    const form = $('#hyperstackConfigForm');
    if (!form || $('#hyperstackImageUser')) return;
    const submit = form.querySelector('button[type="submit"]');
    const imageUser = document.createElement('label');
    imageUser.innerHTML =
      '镜像 SSH 用户 <span class="default-value-tag">默认值，可选修改</span>' +
      '<input id="hyperstackImageUser" autocomplete="username" value="ubuntu">';
    const tailscale = document.createElement('label');
    tailscale.innerHTML =
      'Tailscale Auth Key' +
      '<input id="hyperstackTailscaleAuthKey" type="password" autocomplete="new-password" ' +
      'placeholder="首次填写；以后留空则保留已保存的 Key">';
    const status = document.createElement('small');
    status.id = 'hyperstackTailscaleKeyStatus';
    status.textContent = '尚未配置 Tailscale Auth Key';
    submit.before(imageUser, tailscale, status);
    const cidr = $('#hyperstackAgentCidr');
    if (cidr?.parentElement) cidr.parentElement.hidden = true;
  }

  async function loadConfiguration() {
    installFields();
    const config = await request('/api/config/status');
    const hyperstack = config.providers?.find(provider => provider.id === 'hyperstack');
    const form = $('#hyperstackConfigForm');
    if (!hyperstack?.configured || !form) return;
    form.hidden = false;
    const saved = hyperstack.hyperstackConfig || {};
    const resources = await request('/api/providers/hyperstack/resources');
    const environment = $('#hyperstackEnvironment');
    const keypair = $('#hyperstackKeypair');
    const image = $('#hyperstackImage');
    environment.innerHTML = (resources.environments || []).map(item =>
      `<option value="${esc(item.name)}">${esc(item.name)} · ${esc(item.region || '未知区域')}</option>`,
    ).join('');
    keypair.innerHTML = (resources.keypairs || []).map(item =>
      `<option value="${esc(item.name)}" data-environment="${esc(item.environmentName || '')}">${esc(item.name)}</option>`,
    ).join('');
    image.innerHTML = (resources.images || []).map(item =>
      `<option value="${esc(item.name)}">${esc(item.name)}</option>`,
    ).join('');
    if (saved.environment) environment.value = saved.environment;
    if (saved.keyName) keypair.value = saved.keyName;
    if (saved.imageName) image.value = saved.imageName;
    const inferUser = () => {
      const name = image.value.toLowerCase();
      if (name.includes('debian')) return 'debian';
      if (name.includes('centos')) return 'centos';
      if (name.includes('rocky') || name.includes('alma')) return 'rocky';
      return 'ubuntu';
    };
    $('#hyperstackImageUser').value = saved.imageUser || inferUser();
    image.onchange = () => { $('#hyperstackImageUser').value = inferUser(); };
    $('#hyperstackTailscaleAuthKey').value = '';
    $('#hyperstackTailscaleKeyStatus').textContent =
      saved.tailscaleAuthKeyConfigured
        ? '已加密保存 Tailscale Auth Key；留空不会覆盖'
        : '尚未配置 Tailscale Auth Key';
    $('#hyperstackConfigStatus').textContent =
      `已读取 ${resources.environments?.length || 0} 个 Environment、` +
      `${resources.keypairs?.length || 0} 个 Keypair、` +
      `${resources.images?.length || 0} 个镜像`;
  }

  installFields();
  const originalBilling = globalThis.showBillingProvider;
  if (typeof originalBilling === 'function') {
    globalThis.showBillingProvider = function(provider) {
      originalBilling(provider);
      if (provider === 'hyperstack')
        loadConfiguration().catch(error => notify(`Hyperstack 配置读取失败：${error.message}`));
      else if ($('#hyperstackConfigForm'))
        $('#hyperstackConfigForm').hidden = true;
    };
  }

  const hyperstackForm = $('#hyperstackConfigForm');
  if (hyperstackForm) hyperstackForm.onsubmit = async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await request('/api/providers/hyperstack/config', {
        method: 'PUT',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          environment: $('#hyperstackEnvironment').value,
          keyName: $('#hyperstackKeypair').value,
          imageName: $('#hyperstackImage').value,
          imageUser: $('#hyperstackImageUser').value || 'ubuntu',
          tailscaleAuthKey: $('#hyperstackTailscaleAuthKey').value,
        }),
      });
      await loadConfiguration();
      notify('Hyperstack 无公网 IP + Tailscale 配置已保存');
    } catch (error) {
      notify(`配置保存失败：${error.message}`);
    } finally {
      button.disabled = false;
    }
  };

  function decorateInstances() {
    for (const instance of recoveredInstances) {
      const action = document.querySelector(
        `[data-action][data-id="${CSS.escape(String(instance.id))}"]`,
      );
      const card = action?.closest('.instance');
      const address = card?.querySelector('.instance-actions > .sub');
      const actions = card?.querySelector('.instance-actions > div');
      if (!card || !actions) continue;
      if (instance.accessType === 'tailscale' && address) {
        const text =
          `无公网 IP · 请到 Tailscale 后台获取 100.x.x.x · ` +
          (instance.sshCommand ||
            `ssh -i <private-key> ${instance.sshUser || '<image-user>'}@<tailscale-ip>`);
        if (address.textContent !== text) address.textContent = text;
      }
    }
  }

  async function refreshInstances() {
    try {
      const data = await request('/api/instances');
      recoveredInstances = data.instances || [];
      decorateInstances();
    } catch {
      // The main application already displays instance-list failures.
    }
  }

  const grid = $('#instanceGrid');
  if (grid) new MutationObserver(() => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshInstances, 50);
  }).observe(grid, {childList: true, subtree: true});
  refreshInstances();
})();
