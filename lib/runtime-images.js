function resolveCustomRuntimeImage(image, cudaMajor) {
  const value = String(image || '').trim();
  const major = Number(cudaMajor);
  if (!value) {
    throw Object.assign(new Error('请输入 Docker 镜像地址'), {
      status: 400,
      code: 'custom_image_required',
    });
  }
  if (value.length > 512 || /\s/.test(value) || value.includes('://') ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(value)) {
    throw Object.assign(new Error('镜像地址无效，请填写 image:tag 或 registry/namespace/image:tag'), {
      status: 400,
      code: 'invalid_custom_image',
    });
  }
  if (![12, 13].includes(major)) {
    throw Object.assign(new Error('镜像配置必须注明 CUDA 12 或 CUDA 13'), {
      status: 400,
      code: 'invalid_custom_image_cuda',
    });
  }
  return {image: value, cudaMajor: major};
}

module.exports = {resolveCustomRuntimeImage};
