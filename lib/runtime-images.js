const DEFAULT_RUNTIME_REPOSITORY = 'ghcr.io/geonasz/gpu-scheduling-platform-runtime';

const DEFAULT_IMAGES = [
  {
    id: 'pytorch-2.11-cuda13.2',
    label: 'PyTorch 2.11 · CUDA 13.2（NGC 26.03）',
    baseImage: 'nvcr.io/nvidia/pytorch:26.03-py3',
    repositoryTag: 'pytorch-2.11-cuda13.2-ngc26.03',
    cudaMajor: 13,
    recommended: true,
  },
  {
    id: 'pytorch-2.10-cuda13.1',
    label: 'PyTorch 2.10 · CUDA 13.1（NGC 26.01）',
    baseImage: 'nvcr.io/nvidia/pytorch:26.01-py3',
    repositoryTag: 'pytorch-2.10-cuda13.1-ngc26.01',
    cudaMajor: 13,
  },
  {
    id: 'pytorch-2.7-cuda12.8',
    label: 'PyTorch 2.7 · CUDA 12.8（NGC 25.03）',
    baseImage: 'nvcr.io/nvidia/pytorch:25.03-py3',
    repositoryTag: 'pytorch-2.7-cuda12.8-ngc25.03',
    cudaMajor: 12,
  },
];

const MODE_DETAILS = {
  prebuilt: {
    label: '平台成品镜像（从 GHCR 拉取）',
    description: '平台依赖已提前构建，下载量可能更大；适合 GHCR 网络较快的区域。',
  },
  'on-demand': {
    label: 'NVIDIA NGC 基础镜像（开机安装）',
    description: '直接拉取 NVIDIA 基础镜像，再安装平台依赖；适合 GHCR 较慢但 NGC/软件源较快的区域。',
  },
};

function decorate(item) {
  const availableBuildModes = [];
  if (item.prebuiltImage) availableBuildModes.push('prebuilt');
  if (item.onDemandImage) availableBuildModes.push('on-demand');
  const buildMode = availableBuildModes.includes(item.buildMode) ? item.buildMode : availableBuildModes[0];
  return {
    ...item,
    image: buildMode === 'prebuilt' ? item.prebuiltImage : item.onDemandImage,
    buildMode,
    buildModeLabel: MODE_DETAILS[buildMode].label,
    buildDescription: MODE_DETAILS[buildMode].description,
    availableBuildModes,
    buildModes: Object.fromEntries(availableBuildModes.map(mode => [mode, MODE_DETAILS[mode]])),
  };
}

function runtimeImages(env = process.env, provider) {
  if (!env.FLEET_RUNTIME_IMAGES) {
    const current = env.FLEET_CONTAINER_IMAGE_CUDA13 || env.FLEET_CONTAINER_IMAGE;
    const repository = String(env.FLEET_RUNTIME_IMAGE_REPOSITORY || DEFAULT_RUNTIME_REPOSITORY).replace(/\/+$/,'');
    // The "CUDA 13 with 12.8 fallback" option only makes sense for Hyperstack,
    // whose cloud-init defers CUDA selection to host-driver detection at boot.
    const visibleImages = DEFAULT_IMAGES.filter(item => item.allowCuda128Fallback ? provider === 'hyperstack' : true);
    return visibleImages.map(item => decorate({
      id: item.id,
      label: item.label,
      cudaMajor: item.cudaMajor,
      recommended: Boolean(item.recommended),
      allowCuda128Fallback: Boolean(item.allowCuda128Fallback),
      prebuiltImage: item.recommended && current ? current : (item.repositoryTag ? `${repository}:${item.repositoryTag}` : undefined),
      onDemandImage: item.baseImage,
      buildMode: item.repositoryTag ? 'prebuilt' : 'on-demand',
    }));
  }

  let parsed;
  try {
    parsed = JSON.parse(env.FLEET_RUNTIME_IMAGES);
  } catch {
    throw Object.assign(new Error('FLEET_RUNTIME_IMAGES 必须是 JSON 数组'), {status: 503});
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    throw Object.assign(new Error('FLEET_RUNTIME_IMAGES 至少需要配置一个镜像版本'), {status: 503});
  }
  return parsed.map((item, index) => {
    const id = String(item?.id || '').trim();
    const image = String(item?.image || '').trim();
    if (!id || !image) {
      throw Object.assign(new Error(`FLEET_RUNTIME_IMAGES 第 ${index + 1} 项缺少 id 或 image`), {status: 503});
    }
    const buildMode = item.buildMode === 'prebuilt' ? 'prebuilt' : 'on-demand';
    return decorate({
      id,
      label: String(item.label || id),
      cudaMajor: Number(item.cudaMajor) || 13,
      recommended: Boolean(item.recommended),
      allowCuda128Fallback: Boolean(item.allowCuda128Fallback),
      prebuiltImage: buildMode === 'prebuilt' ? image : undefined,
      onDemandImage: buildMode === 'on-demand' ? image : undefined,
      buildMode,
    });
  });
}

function resolveRuntimeImage(id, env = process.env, requestedMode, provider) {
  const images = runtimeImages(env, provider);
  const selected = images.find(item => item.id === id)
    || (id ? null : images.find(item => item.recommended) || images[0]);
  if (!selected) {
    throw Object.assign(new Error('所选镜像版本不存在或已下线，请刷新后重试'), {
      status: 400,
      code: 'invalid_image_version',
    });
  }
  const buildMode = requestedMode || selected.buildMode;
  if (!selected.availableBuildModes.includes(buildMode)) {
    throw Object.assign(new Error('该运行环境不支持所选镜像获取方式，请刷新后重试'), {
      status: 400,
      code: 'invalid_image_build_mode',
    });
  }
  return {
    ...selected,
    image: buildMode === 'prebuilt' ? selected.prebuiltImage : selected.onDemandImage,
    buildMode,
    buildModeLabel: MODE_DETAILS[buildMode].label,
    buildDescription: MODE_DETAILS[buildMode].description,
  };
}

function resolveCustomRuntimeImage(image, cudaMajor) {
  const value = String(image || '').trim();
  const major = Number(cudaMajor);
  if (!value) {
    throw Object.assign(new Error('请输入自定义 Docker 镜像地址'), {
      status: 400,
      code: 'custom_image_required',
    });
  }
  if (value.length > 512 || /\s/.test(value) || value.includes('://') ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(value)) {
    throw Object.assign(new Error('自定义镜像地址无效，请填写 image:tag 或 registry/namespace/image:tag'), {
      status: 400,
      code: 'invalid_custom_image',
    });
  }
  if (![12, 13].includes(major)) {
    throw Object.assign(new Error('自定义镜像必须注明 CUDA 12 或 CUDA 13'), {
      status: 400,
      code: 'invalid_custom_image_cuda',
    });
  }
  return {
    id: 'custom',
    label: '自定义 Docker 镜像',
    image: value,
    cudaMajor: major,
    buildMode: 'custom',
    custom: true,
    allowCuda128Fallback: false,
  };
}

module.exports = {runtimeImages, resolveRuntimeImage, resolveCustomRuntimeImage};
