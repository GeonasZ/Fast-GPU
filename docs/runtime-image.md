# Runtime image strategy

Fast GPU publishes three prebuilt runtime images. Additional selectable
versions use NVIDIA's official NGC base images and install the platform
dependencies when an instance starts.

For versions that have a published platform image, the launch dialog offers
both paths. Operators can choose the GHCR prebuilt image or the matching NVIDIA
NGC base image with startup-time dependency installation. This is useful
because registry throughput varies significantly by provider and region.

## Published prebuilt images

`.github/workflows/update-codex-runtime.yml` builds `Dockerfile.runtime` from the
default NGC image, tests the exact candidate digest, and only then promotes the
default release. The catalog also contains the two manually published tags:

```text
ghcr.io/<owner>/<repository>-runtime:pytorch-2.11-cuda13.2-ngc26.03
ghcr.io/<owner>/<repository>-runtime:stable-cuda13
ghcr.io/<owner>/<repository>-runtime:pytorch-2.10-cuda13.1-ngc26.01
ghcr.io/<owner>/<repository>-runtime:pytorch-2.7-cuda12.8-ngc25.03
ghcr.io/<owner>/<repository>-runtime:stable-cuda12
```

The built-in catalog uses this public repository by default:

```text
ghcr.io/geonasz/gpu-scheduling-platform-runtime
```

Set `FLEET_RUNTIME_IMAGE_REPOSITORY` to use a fork or mirror. The platform
derives every published version tag from this address.
`FLEET_CONTAINER_IMAGE_CUDA13` and `FLEET_CONTAINER_IMAGE_CUDA128` remain
optional emergency overrides.

The package must be public, or the cloud VM must authenticate to GHCR before
pulling it. Never embed registry credentials in an image.

## On-demand versions

Catalog entries without a published platform tag point to their
`nvcr.io/nvidia/pytorch` base images. `agent/bootstrap.sh` installs the platform
dependencies after the instance starts. Every path installs the latest Codex
and Claude Code releases and runs a real PyTorch CUDA calculation before
reporting the instance as ready.

This avoids storing and continuously rebuilding a full platform image for every
selectable PyTorch version. The tradeoff is a longer first startup and a
dependency on the package repositories being reachable.

## Manual multi-version publish

All three platform images include OpenSSH and `ensure-ssh.sh`. Provider startup
still checks for `sshd` on every instance: it installs OpenSSH only when the
binary is missing, then configures the managed key and starts the service.
Bootstrap and Agent files are uploaded by the platform over SSH, so initial
provisioning does not depend on a public `BASE_URL` or Tunnel.

```powershell
# PyTorch 2.11 with CUDA 13.2 and NGC 26.03
docker buildx build -f Dockerfile.runtime `
  --provenance=false `
  --platform linux/amd64 `
  --build-arg NGC_IMAGE=nvcr.io/nvidia/pytorch:26.03-py3 `
  --label org.opencontainers.image.source=https://github.com/geonasz/GPUSchedulingPlatform `
  --tag ghcr.io/geonasz/gpu-scheduling-platform-runtime:pytorch-2.11-cuda13.2-ngc26.03 `
  --tag ghcr.io/geonasz/gpu-scheduling-platform-runtime:stable-cuda13 `
  --push `
  .

# PyTorch 2.10 with CUDA 13.1 and NGC 26.01
docker buildx build -f Dockerfile.runtime `
  --provenance=false `
  --platform linux/amd64 `
  --build-arg NGC_IMAGE=nvcr.io/nvidia/pytorch:26.01-py3 `
  --label org.opencontainers.image.source=https://github.com/geonasz/GPUSchedulingPlatform `
  --tag ghcr.io/geonasz/gpu-scheduling-platform-runtime:pytorch-2.10-cuda13.1-ngc26.01 `
  --push `
  .

# PyTorch 2.7 with CUDA 12.8 and NGC 25.03
docker buildx build -f Dockerfile.runtime `
  --provenance=false `
  --platform linux/amd64 `
  --build-arg NGC_IMAGE=nvcr.io/nvidia/pytorch:25.03-py3 `
  --label org.opencontainers.image.source=https://github.com/geonasz/GPUSchedulingPlatform `
  --tag ghcr.io/geonasz/gpu-scheduling-platform-runtime:pytorch-2.7-cuda12.8-ngc25.03 `
  --tag ghcr.io/geonasz/gpu-scheduling-platform-runtime:stable-cuda12 `
  --push `
  .
```

## Validation boundary

CI checks the prebuilt image's executables and CUDA compiler without a GPU.
Every cloud instance, whether prebuilt or on-demand, must still pass
`nvidia-smi` and the PyTorch GPU calculation. Failed validation prevents the
instance from being marked ready.

The prebuilt image uses `tini` as PID 1. Container-provider startup commands
also hand their keep-alive process to `tini` after bootstrap, so termination
signals reach the process group and orphaned child processes are reaped without
running a full init system. Older images without `tini` retain the previous
`sleep infinity` fallback.

`NVBANDWIDTH_REF` is a Docker build argument and defaults to `main`. Pin it to a
reviewed commit when strict reproducibility is required.
