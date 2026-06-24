# Weavekit

Weavekit is a TypeScript-first playground for orchestrating GitHub Copilot SDK agents through explicit, typed workflows.

The v0 workflow is a Design Council. It runs four debating personas, normalizes their critiques through BAML, asks a Judge reducer whether to continue, and writes:

- `CouncilReport.md`
- `CouncilRunState.json`
- raw transcript debug files

## Setup

```bash
npm install
npm run baml-generate
```

Set BAML model environment variables before running the real workflow:

```bash
export BAML_OPENAI_BASE_URL="https://api.openai.com/v1"
export BAML_OPENAI_API_KEY="<your-api-key>"
export BAML_MODEL="gpt-5-mini"
```

GitHub Copilot SDK authentication follows the SDK's local authentication behavior.

## Run the Design Council

```bash
npm run council -- council run --input examples/design-question.md --output runs/example
```

## Verify

```bash
npm test
npm run typecheck
npm run build
```
