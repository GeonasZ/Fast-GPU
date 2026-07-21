# Prebuilt runtime image

`Dockerfile.runtime` extends NVIDIA's NGC PyTorch image with the tools that were
previously installed on every new GPU instance. The resulting image contains
Codex CLI, Claude Code, fio, rclone, nvbandwidth, Node.js, and the GPU Fleet Agent.

## Automatic CLI updates

`.github/workflows/update-codex-runtime.yml` runs daily and can also be started
manually. It reads the current stable Codex and Claude Code versions from npm,
then checks whether the immutable
`codex-<codex-version>-claude-<claude-version>` tag already exists in GHCR.

For a new version, the workflow:

1. builds and pushes a run-specific `candidate-<run-id>` image;
2. runs `/opt/gpu-fleet/verify-image.sh` against that exact image digest;
3. promotes the tested digest to both the combined version tag and `stable`.

If the build or verification fails, `stable` is not changed. The candidate tag
is intentionally retained for diagnosis.

The image is published as:

```text
ghcr.io/<owner>/<repository>-runtime:stable
ghcr.io/<owner>/<repository>-runtime:codex-<codex-version>-claude-<claude-version>
```

GHCR packages are not necessarily public by default. Make this runtime package
public before using it from cloud instances, or add registry authentication to
the VM bootstrap separately. Do not embed a registry token in the image.

Configure the control plane with:

```text
FLEET_CONTAINER_IMAGE_CUDA13=ghcr.io/<owner>/<repository>-runtime:stable
```

For reproducible deployments, production may use the version tag or the digest
created by the successful workflow instead of the moving `stable` tag.

## Validation boundary

GitHub-hosted runners do not provide NVIDIA GPUs. CI verifies the installed
executables, the exact Codex and Claude Code versions, Agent syntax, and CUDA
compiler presence.
When Hyperstack starts the image on a GPU, the existing provisioning flow still
runs `nvidia-smi`, PyTorch CUDA checks, a real GPU matrix multiplication, and the
Agent health check before reporting `ready`. The container bootstrap does not
repeat the build-time executable, version, or Agent syntax checks; it only keeps
the cloud-specific GPU check before starting instance services.

`NVBANDWIDTH_REF` is a Docker build argument and defaults to `main`. Pin it to a
reviewed commit when strict reproducibility is required.
