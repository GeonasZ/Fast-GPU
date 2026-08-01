registerProviderExtension('autodl', {
  async renderBilling({ host, provider, status }) {
    if (!status?.configured) return;
    const base = `/api/providers/${encodeURIComponent(provider.id)}`;
    host.innerHTML = `
      <button type="button" data-image-import-open>实验性社区镜像转存</button>
      <dialog data-image-import-dialog><form method="dialog">
        <button class="close" value="cancel" formnovalidate>×</button>
        <span class="eyebrow">EXPERIMENTAL · AUTODL</span>
        <h2>社区镜像转存到个人镜像</h2>
        <p>平台会创建临时按量实例、关机保存镜像，确认个人镜像可用后再释放实例。</p>
        <label>社区镜像 UUID<input data-source required placeholder="image-xxxxxxxxxx"></label>
        <label>保存后的个人镜像名称<input data-name required maxlength="80" value="community-image-copy"></label>
        <fieldset><legend>GPU 选择方式</legend>
          <label><input name="providerImageSelectionMode" type="radio" value="manual" checked> 用户手动选择</label>
          <label><input name="providerImageSelectionMode" type="radio" value="auto"> 在最高时价内自动选择最低价</label>
        </fieldset>
        <label data-manual>临时实例 GPU<select data-product></select></label>
        <label data-auto hidden>最高时价（人民币/小时）<input data-price type="number" min="0.01" step="0.01" value="2.00"></label>
        <div data-status class="provision-warning"></div>
        <label><span><input data-confirm type="checkbox"> 我确认此操作会产生实例运行费，并可能产生镜像存储费。</span></label>
        <menu><button value="cancel" formnovalidate>取消</button><button type="submit" class="primary">确认并开始转存</button></menu>
      </form></dialog>`;
    const dialog = host.querySelector('[data-image-import-dialog]'),
      form = dialog.querySelector('form'),
      statusNode = dialog.querySelector('[data-status]'),
      mode = () => form.querySelector('[name="providerImageSelectionMode"]:checked').value;
    async function loadOptions() {
      const current = mode();
      form.querySelector('[data-manual]').hidden = current !== 'manual';
      form.querySelector('[data-auto]').hidden = current !== 'auto';
      statusNode.textContent = '正在读取可用 GPU…';
      const data = await request(`${base}/image-import/options?mode=${current}`);
      form.querySelector('[data-product]').innerHTML = (data.products || [])
        .map(item => `<option value="${esc(item.productId)}">${esc(item.gpu)} · ${formatPrice(item)}</option>`)
        .join('');
      statusNode.textContent = data.warning || '';
    }
    async function poll(id) {
      try {
        const job = await request(`${base}/image-imports/${encodeURIComponent(id)}`);
        statusNode.textContent = job.message || job.status;
        if (!['completed', 'failed', 'cancelled'].includes(job.status))
          setTimeout(() => poll(id), 3000);
      } catch (error) {
        statusNode.textContent = `读取任务状态失败：${error.message}`;
      }
    }
    form.querySelectorAll('[name="providerImageSelectionMode"]').forEach(
      input => input.onchange = () => loadOptions().catch(error => statusNode.textContent = error.message),
    );
    host.querySelector('[data-image-import-open]').onclick = async () => {
      form.querySelector('[data-confirm]').checked = false;
      dialog.showModal();
      try { await loadOptions(); } catch (error) { statusNode.textContent = error.message; }
    };
    form.onsubmit = async event => {
      event.preventDefault();
      if (!form.querySelector('[data-confirm]').checked) return toast('请先确认费用风险');
      try {
        const job = await request(`${base}/image-imports`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceImageUuid: form.querySelector('[data-source]').value,
            imageName: form.querySelector('[data-name]').value,
            selectionMode: mode(),
            productId: form.querySelector('[data-product]').value,
            maxPrice: Number(form.querySelector('[data-price]').value),
            confirmCost: true,
          }),
        });
        statusNode.textContent = '任务已创建，正在确定 GPU…';
        poll(job.id);
      } catch (error) { statusNode.textContent = `提交失败：${error.message}`; }
    };
  },
});
