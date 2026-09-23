# RunPod Serverless GPU Deployment Guide

This guide walks through deploying the **SadTalker GPU Worker** to RunPod Serverless to transition LUX Video OS Standard Tier from simulation mode to true AI lip-sync rendering.

---

## 1. Prerequisites

1. **RunPod Account**: Sign up at [runpod.io](https://runpod.io) and obtain an API Key under **User Settings > API Keys**.
2. **Container Registry**: Access to GitHub Container Registry (`ghcr.io`) or Docker Hub.
3. **Local Docker Environment**: With `docker buildx` support for `linux/amd64`.

---

## 2. Step 1: Build & Push the Docker Worker

The worker code is located at [`workers/sadtalker-runpod/`](file:///C:/Users/ariel/.gemini/antigravity/scratch/lux-video-os/workers/sadtalker-runpod/).

```powershell
# Authenticate to GitHub Container Registry (or Docker Hub)
echo $env:CR_PAT | docker login ghcr.io -u ARCHITECTARIEL --password-stdin

# Build the Linux amd64 image
docker build --platform linux/amd64 -t ghcr.io/architectariel/lux-video-os-sadtalker-runpod:v1.0.0 workers/sadtalker-runpod

# Push the immutable image tag
docker push ghcr.io/architectariel/lux-video-os-sadtalker-runpod:v1.0.0
```

---

## 3. Step 2: Create RunPod Serverless Template

1. In the **RunPod Console**, navigate to **Serverless > Templates** (`https://www.runpod.io/console/serverless/user/templates`).
2. Click **New Template**.
3. Fill in the template details:
   - **Template Name**: `lux-sadtalker-worker`
   - **Container Image**: `ghcr.io/architectariel/lux-video-os-sadtalker-runpod:v1.0.0`
   - **Container Disk**: `20 GB`
   - **Environment Variables**:
     - `LUX_WORKER_MODE`: `simulation` (for initial connectivity proof) or `real` (for production GPU inference)
4. Click **Save Template**.

---

## 4. Step 3: Create Serverless Endpoint

1. Navigate to **Serverless > Endpoints** (`https://www.runpod.io/console/serverless/user/endpoints`).
2. Click **New Endpoint**.
3. Select the template created in Step 2 (`lux-sadtalker-worker`).
4. Configure Endpoint parameters:
   - **GPU Types**: NVIDIA RTX 4090 (24GB) or RTX A5000 (24GB).
   - **Active Workers (Min)**: `0` (scales down to 0 to prevent unnecessary costs when idle).
   - **Max Workers**: `2` (or scale as needed).
   - **Idle Timeout**: `5 seconds`.
   - **Execution Timeout**: `120 seconds`.
5. Click **Create Endpoint**.
6. Copy the generated **Endpoint ID** (e.g. `vllm-abc123xyz`).

---

## 5. Step 4: Verify Endpoint Connectivity

Use the automated verification tool to validate your endpoint:

```powershell
$env:RUNPOD_API_KEY = "your_runpod_api_key"
$env:VIDEO_OS_RUNPOD_ENDPOINT_ID = "your_endpoint_id"
$env:VIDEO_OS_RUNPOD_ALLOW_SIMULATED_OUTPUT = "true"

node tools/test-runpod-endpoint.mjs
```

The script verifies:
- Endpoint health check.
- Asynchronous `/run` queuing.
- Status polling loop.
- Output MP4 validation and SHA-256 integrity match.

---

## 6. Step 5: Configure Vercel Production Environment

Add these variables to **Vercel Production**:

| Variable | Value | Description |
|---|---|---|
| `VIDEO_OS_STANDARD_PROVIDER` | `runpod` | Activates RunPod GPU inference (switches from local simulation) |
| `VIDEO_OS_RUNPOD_ENDPOINT_ID` | `<endpoint-id>` | Your RunPod Serverless Endpoint ID |
| `RUNPOD_API_KEY` | `<api-key>` | Your RunPod API Key |
| `VIDEO_OS_RUNPOD_TIMEOUT_MS` | `60000` | (Optional) Maximum job execution ceiling |

---

## 7. Operational Cost Tracking

- Standard Tier renders on RunPod RTX 4090 compute cost: **~$0.00065/second**.
- Typical 30–60 second lip-sync rendering latency: **15–40 seconds**.
- Estimated cost per Standard render: **~$0.02 – $0.05**.
- Billed to customer at: **90 credits ($5.40)**, maintaining **>95% gross margin**.
