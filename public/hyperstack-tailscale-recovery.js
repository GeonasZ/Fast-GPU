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

  const decode = value => {
    const binary = atob(value), bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++)
      bytes[index] = binary.charCodeAt(index);
    return bytes;
  };
  const encode = value => {
    let binary = '';
    for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
    return btoa(binary);
  };

  async function downloadKey(instance) {
    const pair = await crypto.subtle.generateKey({
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    }, true, ['encrypt', 'decrypt']);
    const publicKey = encode(await crypto.subtle.exportKey('spki', pair.publicKey));
    const envelope = await request(
      `/api/instances/${encodeURIComponent(instance.id)}/ssh/key?provider=${encodeURIComponent(instance.provider)}`,
      {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({publicKey}),
      },
    );
    const rawKey = await crypto.subtle.decrypt(
      {name: 'RSA-OAEP'}, pair.privateKey, decode(envelope.wrappedKey),
    );
    const aesKey = await crypto.subtle.importKey(
      'raw', rawKey, {name: 'AES-GCM'}, false, ['decrypt'],
    );
    const ciphertext = decode(envelope.ciphertext), tag = decode(envelope.tag);
    const combined = new Uint8Array(ciphertext.length + tag.length);
    combined.set(ciphertext);
    combined.set(tag, ciphertext.length);
    const plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: decode(envelope.iv), tagLength: 128,
    }, aesKey, combined);
    const url = URL.createObjectURL(new Blob([plaintext], {
      type: envelope.contentType || 'application/x-pem-file',
    }));
    const link = document.createElement('a');
    link.href = url;
    link.download = envelope.filename ||
      `gpu-fleet-${instance.provider}-${instance.id}.pem`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

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
      if (
        !instance.platformManaged ||
        actions.querySelector('[data-managed-key], [data-ssh-key]')
      )
        continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.managedKey = String(instance.id);
      button.textContent = '下载 SSH Key';
      button.title = '下载平台为该实例自动生成的 SSH 私钥';
      actions.prepend(button, document.createTextNode(' '));
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

  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-managed-key]');
    if (!button) return;
    const instance = recoveredInstances.find(
      item => String(item.id) === String(button.dataset.managedKey),
    );
    if (!instance) return;
    button.disabled = true;
    try {
      await downloadKey(instance);
      notify('SSH 私钥已通过临时加密下载');
    } catch (error) {
      notify(`私钥下载失败：${error.message}`);
    } finally {
      button.disabled = false;
    }
  });
})();
