const { createAutoDLImageImportManager } = require('./image-imports');

const PROVIDER_ID = 'autodl';

function estimateMissingPrices(items, env) {
  const usdCny = Number(env.USD_CNY_ESTIMATE_RATE) || 7.2;
  const normalize = value => String(value || '').toLowerCase()
    .replace(/nvidia|geforce|rtx|\s|[-_()]/g, '');
  const gpuModel = value => {
    const normalized = normalize(value);
    const aliases = [
      ['rtxpro6000', /(?:rtx)?pro6000/], ['4090d', /4090d/],
      ['4080s', /4080(?:super|s)/], ['5090', /5090/], ['4090', /4090/],
      ['4080', /4080/], ['3090', /3090/], ['h800', /h800/], ['h200', /h200/],
      ['h100', /h100/], ['a100', /a100/], ['l40s', /l40s/], ['l40', /l40/],
      ['l20', /l20/], ['a800', /a800/], ['v100', /v100/],
    ];
    return aliases.find(([, pattern]) => pattern.test(normalized))?.[0] || normalized;
  };
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const comparable = items.filter(item =>
    item.provider !== PROVIDER_ID && Number(item.price) > 0 &&
    String(item.priceUnit || '').endsWith('/hour'),
  );
  return items.map(item => {
    if (item.provider !== PROVIDER_ID || Number(item.price) > 0) return item;
    const model = gpuModel(item.gpu || item.productId);
    const gpuCount = Number(item.gpuCount) || 1;
    const byProvider = new Map();
    for (const candidate of comparable) {
      if (gpuModel(candidate.gpu || candidate.productId) !== model ||
          (Number(candidate.gpuCount) || 1) !== gpuCount ||
          (item.vram != null && candidate.vram != null && Number(candidate.vram) !== Number(item.vram)) ||
          (item.cpu != null && candidate.cpu != null && Number(candidate.cpu) !== Number(item.cpu)) ||
          (item.ram != null && candidate.ram != null && Number(candidate.ram) !== Number(item.ram))) continue;
      const currency = String(candidate.priceUnit).split('/')[0];
      const cny = Number(candidate.price) * (currency === 'USD' ? usdCny : currency === 'CNY' ? 1 : NaN);
      if (Number.isFinite(cny) && cny > 0) {
        const values = byProvider.get(candidate.provider) || [];
        values.push(cny);
        byProvider.set(candidate.provider, values);
      }
    }
    const samples = [...byProvider.values()].map(median);
    if (!samples.length) return {
      ...item,
      priceEstimated: false,
      priceEstimateUnavailable: true,
      note: '其他厂商没有同型号、同配置的可比实例，无法预估价格；创建后显示实际价格',
    };
    const providersUsed = [...byProvider.keys()];
    return {
      ...item,
      price: median(samples),
      priceUnit: 'CNY/hour',
      priceSource: 'cross-provider-median',
      priceEstimated: true,
      estimateProviders: providersUsed,
      estimateUsdCnyRate: usdCny,
      note: `参考其他厂商同型号 GPU 的中位数估价（${providersUsed.join('、')}）；创建后以实际价格为准`,
    };
  });
}

function createRuntime({ env, adapter }) {
  const imageImports = createAutoDLImageImportManager(adapter);

  async function handleRequest(req, url, readBody) {
    const base = `/api/providers/${PROVIDER_ID}`;
    if (req.method === 'GET' && url.pathname === `${base}/image-import/options`) {
      const discovery = await adapter.discover();
      const mode = url.searchParams.get('mode') || 'manual';
      if (mode !== 'auto') return { status: 200, data: { products: discovery.products, experimental: false } };
      try {
        return { status: 200, data: {
          products: discovery.products,
          offers: await adapter.listExperimentalWebOffers(),
          experimental: true,
          warning: '报价来自实验性网页接口，可能随时失效；创建后会用实例详情复核实际价格。',
        } };
      } catch (error) {
        return { status: 200, data: {
          products: discovery.products, offers: [], experimental: true,
          unavailable: true, warning: error.message, code: error.code,
        } };
      }
    }
    if (req.method === 'GET' && url.pathname === `${base}/image-imports`) {
      return { status: 200, data: { jobs: imageImports.list() } };
    }
    const jobRoute = url.pathname.match(new RegExp(`^${base}/image-imports/([^/]+)$`));
    if (req.method === 'GET' && jobRoute) {
      const job = imageImports.get(decodeURIComponent(jobRoute[1]));
      if (!job) throw Object.assign(Error('镜像转存任务不存在'), { status: 404 });
      return { status: 200, data: job };
    }
    if (req.method === 'POST' && url.pathname === `${base}/image-imports`) {
      const input = await readBody(req);
      const sourceImageUuid = String(input.sourceImageUuid || '').trim();
      const imageName = String(input.imageName || '').trim();
      const selectionMode = input.selectionMode === 'auto' ? 'auto' : 'manual';
      if (input.confirmCost !== true) throw Object.assign(Error('必须明确确认实例运行费和可能产生的镜像存储费'), { status: 400, code: 'cost_confirmation_required' });
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{5,127}$/.test(sourceImageUuid)) throw Object.assign(Error('社区镜像 UUID 格式无效'), { status: 400 });
      if (!imageName || imageName.length > 80) throw Object.assign(Error('个人镜像名称长度必须为 1-80 个字符'), { status: 400 });
      if (selectionMode === 'manual' && !String(input.productId || '').trim()) throw Object.assign(Error('手动模式必须选择 GPU'), { status: 400 });
      if (selectionMode === 'auto' && (!Number.isFinite(Number(input.maxPrice)) || Number(input.maxPrice) <= 0)) throw Object.assign(Error('自动模式必须设置大于 0 的最高时价'), { status: 400 });
      return { status: 202, data: imageImports.start({
        sourceImageUuid, imageName, selectionMode,
        productId: String(input.productId || '').trim(),
        maxPrice: Number(input.maxPrice), confirmCost: true,
      }) };
    }
    return null;
  }

  return {
    restore() {},
    handleRequest,
    transformOffers(items) { return estimateMissingPrices(items, env); },
  };
}

module.exports = { createRuntime, estimateMissingPrices };
