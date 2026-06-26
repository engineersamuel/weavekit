## Instructions

By default models are hosted through the copilot-proxy-rs available at http://127.0.0.1:8080 with endpoints  `/health`, `/version`, `/v1/models`, and `/v1/messages/count_tokens` routes.

An example call

```
curl -fsS http://127.0.0.1:8080/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"Say Hello World!"}]}'
```

Add `"stream": true` to the payload if streaming
