# Prompt Forge prototype

## Overview

- Runs a tested, digest-pinned upstream Prompt Forge image as an isolated prototype.
- Maps host port 8090 to container port 8080.
- Connects app OpenAI traffic to copilot-proxy-rs on host via http://host.docker.internal:8080/v1.
- Provides a local env.js (mounted read-only) because upstream image omits it.

## Files

- compose.yaml: Docker Compose config to run the container.
- env.js: frontend env shim (mounted to /root/frontend/env.js:ro).

## Quick commands

Run these from the repository root.

Launch:

```sh
docker compose -f prototypes/prompt-forge/compose.yaml up -d
```

Stop & remove:

```sh
docker compose -f prototypes/prompt-forge/compose.yaml down
```

Show logs:

```sh
docker compose -f prototypes/prompt-forge/compose.yaml logs -f
```

Smoke test (once container is healthy):

```sh
curl -fsS http://localhost:8090/ || echo "UI not reachable; check logs"
```

## Validation

```sh
docker compose -f prototypes/prompt-forge/compose.yaml config
```

## Notes and risks

- OPENAI_API_KEY uses a local placeholder (open, non-secret). copilot-proxy-rs on localhost accepts unauthenticated local requests by default; do not use real API keys here.
- Upstream hardcodes `./promptforge.db`; the container command symlinks that path to `/data/promptforge.db` in a named Docker volume.
- Uses host.docker.internal to reach host proxy; this works on Docker Desktop for macOS/Windows. Linux hosts may require extra setup.
- env.js is mounted read-only into /root/frontend/env.js to satisfy the frontend's expectation of /env.js. If upstream changes paths, adjust mount.

## Manual verification

1. Launch with the command above.
2. Wait until healthcheck passes (docker ps shows healthy) or inspect logs.
3. Visit http://localhost:8090 in a browser; the UI should load and API calls will be proxied to host http://127.0.0.1:8080/v1.
