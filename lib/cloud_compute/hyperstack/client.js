registerProviderExtension('hyperstack', {
  async renderBilling({ host, provider, status, isCurrent, refresh }) {
    if (!status?.configured) return;
    const base = `/api/providers/${encodeURIComponent(provider.id)}`,
      saved = status.hyperstackConfig || {};
    host.innerHTML = `
      <form data-deployment-config class="provider-deployment-form">
        <div class="provider-extension-head"><strong>Hyperstack 部署配置</strong><button data-refresh type="button">刷新资源</button></div>
        <label>Environment<select data-environment></select></label>
        <label>SSH Keypair<select data-keypair></select></label>
        <div data-keypair-actions class="provider-extension-actions">
          <button data-create-keypair type="button">创建平台托管 Keypair</button>
          <button data-delete-keypair type="button" class="danger">删除所选 Keypair</button>
        </div>
        <fieldset data-registration><legend>Keypair 区域注册</legend>
          <label><input type="radio" name="keypairRegistrationMode" value="on-demand" checked> 按需自动注册</label>
          <label><input type="radio" name="keypairRegistrationMode" value="selected"> 仅注册到指定 Environment</label>
          <div data-environment-choices></div>
          <button data-save-registration type="button">保存注册策略</button>
        </fieldset>
        <label>宿主机系统<select data-image></select></label>
        <label>宿主机 SSH 用户<input data-user autocomplete="username" placeholder="例如 ubuntu、debian"></label>
        <label>SSH 来源 CIDR<input data-cidr placeholder="0.0.0.0/0"></label>
        <button class="primary" type="submit">保存部署配置</button>
        <small data-status></small>
      </form>`;
    const form = host.querySelector('[data-deployment-config]'),
      environment = form.querySelector('[data-environment]'),
      keypair = form.querySelector('[data-keypair]'),
      image = form.querySelector('[data-image]'),
      state = form.querySelector('[data-status]');
    let resources;
    const option = (value, label, selected = false) =>
      `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(label)}</option>`;
    function renderKeypairs() {
      const items = (resources?.keypairs || []).filter(item => item.environmentName === environment.value);
      keypair.innerHTML = items.map(item => option(
        item.id, `${item.name}${item.platformManaged ? ' · 平台托管' : ' · 仅厂商侧'}`,
        String(item.id) === String(saved.keypairId) || (!saved.keypairId && item.name === saved.keyName),
      )).join('');
      keypair.querySelectorAll('option').forEach((node, index) => {
        const item = items[index];
        node.dataset.name = item.name;
        node.dataset.managed = String(Boolean(item.platformManaged));
      });
      renderRegistration();
    }
    function selectedKeypair() {
      return (resources?.keypairs || []).find(item => String(item.id) === keypair.value);
    }
    function renderRegistration() {
      const selected = selectedKeypair(), registration = selected?.registrationPolicy || { mode: 'on-demand', environments: [] };
      const mode = form.querySelector(`[name="keypairRegistrationMode"][value="${registration.mode}"]`);
      if (mode) mode.checked = true;
      form.querySelector('[data-registration]').hidden = !selected?.platformManaged;
      form.querySelector('[data-environment-choices]').innerHTML = (resources?.environments || [])
        .filter(item => item.name !== selected?.environmentName)
        .map(item => `<label><input type="checkbox" value="${esc(item.name)}" ${registration.environments?.includes(item.name) ? 'checked' : ''}> ${esc(item.name)} · ${esc(item.region || '')}</label>`)
        .join('');
    }
    async function loadResources() {
      state.textContent = '正在从 Hyperstack 读取资源…';
      resources = await request(`${base}/resources`);
      if (!isCurrent()) return;
      environment.innerHTML = (resources.environments || []).map(item =>
        option(item.name, `${item.name}${item.region ? ` · ${item.region}` : ''}`, item.name === saved.environment),
      ).join('');
      image.innerHTML = (resources.images || []).map(item =>
        option(item.name, item.name, item.name === saved.imageName),
      ).join('');
      form.querySelector('[data-user]').value = saved.imageUser || 'ubuntu';
      form.querySelector('[data-cidr]').value = saved.agentCidr || '0.0.0.0/0';
      renderKeypairs();
      state.textContent = '资源已刷新';
    }
    environment.onchange = renderKeypairs;
    keypair.onchange = renderRegistration;
    form.querySelector('[data-refresh]').onclick = () => loadResources().catch(error => state.textContent = error.message);
    form.querySelector('[data-create-keypair]').onclick = async () => {
      const name = prompt('输入新 Keypair 名称', 'fast-gpu-managed');
      if (!name) return;
      try {
        await request(`${base}/keypairs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, environment: environment.value }) });
        await loadResources();
        toast('平台托管 Keypair 已创建');
      } catch (error) { toast(`创建失败：${error.message}`); }
    };
    form.querySelector('[data-delete-keypair]').onclick = async () => {
      const selected = selectedKeypair();
      if (!selected?.platformManaged) return toast('只能删除平台托管的 Keypair');
      if (!(await confirmAction(`确定删除 Keypair ${selected.name}？`, { title: '删除 SSH Keypair', confirmText: '删除' }))) return;
      try {
        await request(`${base}/keypairs/${encodeURIComponent(selected.id)}`, { method: 'DELETE' });
        await loadResources();
      } catch (error) { toast(`删除失败：${error.message}`); }
    };
    form.querySelector('[data-save-registration]').onclick = async () => {
      const selected = selectedKeypair(), mode = form.querySelector('[name="keypairRegistrationMode"]:checked').value;
      const environments = [...form.querySelectorAll('[data-environment-choices] input:checked')].map(input => input.value);
      try {
        await request(`${base}/keypairs/${encodeURIComponent(selected.id)}/registration`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, environments }),
        });
        toast('Keypair 注册策略已保存');
      } catch (error) { toast(`保存失败：${error.message}`); }
    };
    form.onsubmit = async event => {
      event.preventDefault();
      const selected = selectedKeypair();
      try {
        await request(`${base}/config`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            environment: environment.value, keyName: selected?.name,
            keypairId: selected?.id, imageName: image.value,
            imageUser: form.querySelector('[data-user]').value,
            agentCidr: form.querySelector('[data-cidr]').value,
          }),
        });
        toast('Hyperstack 部署配置已保存，可以创建虚拟机');
        await refresh();
      } catch (error) { toast(`配置保存失败：${error.message}`); }
    };
    try { await loadResources(); } catch (error) { state.textContent = `资源读取失败：${error.message}`; }
  },
});
