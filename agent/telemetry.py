import json, os, shutil, subprocess, time, urllib.request

tools_cache, tools_ready = None, False

def inspect_tools():
    tools = []
    for tool_id, label in (("codex", "Codex CLI"), ("claude", "Claude Code"), ("nvbandwidth", "nvbandwidth"), ("fio", "fio"), ("rclone", "rclone"), ("node", "Node.js")):
        executable, version = shutil.which(tool_id), None
        if executable:
            try:
                result = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=10)
                version = (result.stdout or result.stderr).strip().splitlines()[0] if (result.stdout or result.stderr).strip() else None
            except (OSError, subprocess.SubprocessError):
                pass
        tools.append({"id": tool_id, "label": label, "installed": executable is not None, "path": executable, "version": version})
    return tools

def find_nvbandwidth():
    configured = os.environ.get("NVBANDWIDTH_PATH")
    candidates = [
        configured,
        shutil.which("nvbandwidth"),
        "/usr/local/bin/nvbandwidth",
        "/usr/bin/nvbandwidth",
        "/opt/nvbandwidth/nvbandwidth",
        "/opt/nvbandwidth/build/nvbandwidth",
        "/workspace/nvbandwidth/build/nvbandwidth",
    ]
    try:
        login_path = subprocess.run(
            ["/bin/bash", "-lc", "command -v nvbandwidth"],
            capture_output=True, text=True, timeout=5
        ).stdout.strip()
        candidates.insert(0, login_path)
    except (OSError, subprocess.SubprocessError):
        pass
    return next((path for path in candidates if path and os.access(path, os.X_OK)), None)

def bandwidth_status():
    executable = find_nvbandwidth()
    status = {"installed": executable is not None, "path": executable, "lastRun": None, "results": None}
    try:
        with open("/var/lib/gpu-fleet/benchmark.json", encoding="utf-8") as report_file:
            report = json.load(report_file)
        status["lastRun"] = report.get("generatedAt")
        status["results"] = report.get("nvbandwidth")
    except (OSError, ValueError):
        pass
    return status

def collect():
    global tools_cache, tools_ready
    result = subprocess.run([
        "nvidia-smi",
        "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
        "--format=csv,noheader,nounits",
    ], capture_output=True, text=True, timeout=15)
    collection_error = None
    if result.returncode != 0:
        collection_error = {
            "component": "nvidia-smi",
            "code": "gpu_telemetry_collection_failed",
            "message": (result.stderr or result.stdout).strip()[-1000:] or "nvidia-smi exited with code %s" % result.returncode,
        }
    gpus = []
    for line in result.stdout.splitlines():
        values = [value.strip() for value in line.split(",")]
        if len(values) != 7:
            continue
        index, name, util, used, total, temperature, power = values
        number = lambda value: float(value) if "." in value else int(value)
        gpus.append({"index": int(index), "name": name, "util": number(util), "memoryUsed": number(used), "memoryTotal": number(total), "temperature": number(temperature), "power": number(power)})
    runtime = {"status": "provisioning", "phase": "awaiting_bootstrap", "phaseLabel": "正在等待初始化脚本"}
    try:
        with open("/var/lib/gpu-fleet/profile.json", encoding="utf-8") as profile:
            runtime = json.load(profile)
    except (OSError, ValueError):
        pass
    ready = runtime.get("status") == "ready"
    if tools_cache is None or (ready and not tools_ready):
        tools_cache, tools_ready = inspect_tools(), ready
    telemetry = {"ts": int(time.time() * 1000), "gpus": gpus, "tools": tools_cache, "runtime": runtime}
    if collection_error:
        telemetry["error"] = collection_error
    return telemetry

def push():
    payload = json.dumps({"agentId": os.environ["FLEET_AGENT_ID"], "provider": os.environ.get("FLEET_PROVIDER", "ppio"), "instanceName": os.environ["FLEET_INSTANCE_NAME"], "telemetry": collect()}).encode()
    request = urllib.request.Request(os.environ["FLEET_TELEMETRY_PUSH_URL"], data=payload, method="POST", headers={"Content-Type": "application/json", "X-Fleet-Agent-Id": os.environ["FLEET_AGENT_ID"], "Authorization": "Bearer " + os.environ["FLEET_AGENT_SECRET"]})
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status < 200 or response.status >= 300:
            raise RuntimeError("telemetry push returned HTTP %s" % response.status)
        response.read()

while True:
    try:
        push()
    except Exception as error:
        print("telemetry push failed:", error, flush=True)
    time.sleep(3)
