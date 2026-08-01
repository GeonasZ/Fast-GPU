let ppioInstancePricingOffers = [];

registerProviderExtension('ppio', {
  renderOfferRow({ offer, details, price }) {
    const loaded = Array.isArray(offer.regionalOffers);
    return `<tr data-offer-row="${esc(offer.id)}"><td><strong>${offer.gpuCount || 1}× ${esc(offer.gpu)}</strong><span class="sub">${esc(details)}</span></td><td><span class="provider"><i>P</i>${esc(offer.providerName)}</span></td><td>${loaded ? offer.regionalOffers.length : offer.regions?.length || 0} 个地区</td><td class="sub">${loaded ? '展开后查看' : '按需查询库存'}</td><td><span class="score">${loaded ? '实时' : '待查询'}</span></td><td>${loaded ? '已加载' : '点击查看地区'}</td><td class="price"><strong>${esc(price)}</strong><span class="sub">参考价</span></td><td><button class="launch" data-provider-regions="${esc(offer.id)}">查看地区 ↓</button></td></tr>`;
  },

  bindOfferRows({ getOffers, setOffers, chooseOffer, showLaunch }) {
    document.querySelectorAll('[data-provider-regions]').forEach(button => {
      button.onclick = async () => {
        let offer = getOffers().find(item => item.id === button.dataset.providerRegions);
        const row = button.closest('tr'), existing = row.nextElementSibling;
        if (existing?.classList.contains('region-detail')) {
          existing.remove();
          button.textContent = '查看地区 ↓';
          return;
        }
        button.disabled = true;
        button.textContent = Array.isArray(offer?.regionalOffers) ? '展开中…' : '查询库存…';
        try {
          if (!Array.isArray(offer?.regionalOffers)) {
            const regional = await request(`/api/providers/${encodeURIComponent(offer.provider)}/regional-inventory`),
              byId = new Map(regional.offers.map(item => [item.id, item]));
            setOffers(getOffers().map(item => byId.get(item.id) || item));
            offer = getOffers().find(item => item.id === button.dataset.providerRegions);
            this.applyInstancePrices(offer.provider, regional.offers);
          }
          const detail = document.createElement('tr');
          detail.className = 'region-detail';
          const labels = { none: '无库存', low: '库存紧张', normal: '库存一般', high: '库存充足', unknown: '查询失败' };
          detail.innerHTML = `<td colspan="8"><div class="region-grid">${(offer.regionalOffers || []).map((region, index) => {
            const canLaunch = region.inventory !== 'none' && region.inventory !== 'unknown';
            return `<article><div><strong>${esc(region.region)}</strong><span class="availability ${region.inventory === 'low' ? 'limited' : canLaunch ? '' : 'unavailable'}">● ${esc(labels[region.inventory] || region.inventory)}</span></div><div class="region-price">${formatPrice({ ...offer, ...region }, '价格未知')}</div><button class="launch" data-provider-region-index="${index}" ${canLaunch ? '' : 'disabled'}>${canLaunch ? region.deployable ? '立即创建' : '尝试创建' : '无库存'}</button></article>`;
          }).join('') || '没有可用地区数据'}</div></td>`;
          row.after(detail);
          detail.querySelectorAll('[data-provider-region-index]').forEach(action => {
            action.onclick = () => {
              const region = offer.regionalOffers[Number(action.dataset.providerRegionIndex)];
              chooseOffer({ ...offer, clusterId: region.clusterId, region: region.region, price: region.price, inventory: region.inventory, deployable: region.deployable });
              showLaunch();
            };
          });
          button.textContent = '收起地区 ↑';
        } catch (error) {
          toast(error.message);
          button.textContent = '重试展开';
        } finally { button.disabled = false; }
      };
    });
  },

  instancesLoaded({ instances: currentInstances }) {
    this.applyInstancePrices('ppio', undefined, currentInstances);
  },

  applyInstancePrices(providerId, regionalOffers, currentInstances = instances) {
    if (Array.isArray(regionalOffers)) ppioInstancePricingOffers = regionalOffers;
    const normalize = value => String(value || '').toLowerCase().replace(/nvidia|geforce|\s|-/g, '');
    for (const instance of currentInstances) {
      if (instance.provider !== providerId) continue;
      const product = ppioInstancePricingOffers.find(item => String(item.productId) === String(instance.productId)) ||
        ppioInstancePricingOffers.find(item => normalize(item.gpu) === normalize(instance.gpu));
      const regional = product?.regionalOffers?.find(item => String(item.clusterId) === String(instance.clusterId) || item.region === instance.region);
      const price = Number(regional?.price), fallback = Number(product?.price);
      instance.price = price > 0 ? price : fallback > 0 ? fallback : undefined;
      instance.priceSource = price > 0 ? 'regional-inventory' : fallback > 0 ? 'product-fallback' : 'unavailable';
      const element = document.getElementById(`price-${instance.id}`);
      if (element) element.textContent = formatPrice(instance, '—');
    }
  },

  async refreshOffers({ definition, getOffers, setOffers, render }) {
    const regional = await request(`/api/providers/${encodeURIComponent(definition.id)}/regional-inventory?refresh=1`),
      byId = new Map(regional.offers.map(item => [item.id, item]));
    setOffers(getOffers().map(item => byId.get(item.id) || item));
    render();
    this.applyInstancePrices(definition.id, regional.offers);
  },
});
