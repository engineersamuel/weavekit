generator typescript {
  output_type "typescript"
  output_dir "../src/generated"
  default_client_mode "async"
  module_format "esm"
  version "0.220.0"
}

client<llm> DefaultClient {
  provider "openai-generic"
  options {
    base_url env.COPILOT_PROXY_BASE_URL
    api_key env.COPILOT_PROXY_API_KEY
    model env.BAML_MODEL
  }
}

client<llm> CopilotProxyClaude35Haiku {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-3-5-haiku"
  }
}

client<llm> CopilotProxyClaude35Haiku20241022 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-3-5-haiku-20241022"
  }
}

client<llm> CopilotProxyClaude35Sonnet {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-3-5-sonnet"
  }
}

client<llm> CopilotProxyClaude35Sonnet20241022 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-3-5-sonnet-20241022"
  }
}

client<llm> CopilotProxyClaude37Sonnet {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-3-7-sonnet"
  }
}

client<llm> CopilotProxyClaude37Sonnet20250219 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-3-7-sonnet-20250219"
  }
}

client<llm> CopilotProxyClaudeHaiku45 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-haiku-4-5"
  }
}

client<llm> CopilotProxyClaudeHaiku4520251001 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-haiku-4-5-20251001"
  }
}

client<llm> CopilotProxyClaudeOpus4 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-opus-4"
  }
}

client<llm> CopilotProxyClaudeOpus41 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-opus-4-1"
  }
}

client<llm> CopilotProxyClaudeOpus4120250805 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-opus-4-1-20250805"
  }
}

client<llm> CopilotProxyClaudeOpus420250514 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-opus-4-20250514"
  }
}

client<llm> CopilotProxyClaudeOpus45 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-opus-4-5"
  }
}

client<llm> CopilotProxyClaudeOpus4520251101 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-opus-4-5-20251101"
  }
}

client<llm> CopilotProxyClaudeOpus46 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-opus-4-6"
  }
}

client<llm> CopilotProxyClaudeOpus4620250515 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-opus-4-6-20250515"
  }
}

client<llm> CopilotProxyClaudeOpus47 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-opus-4-7"
  }
}

client<llm> CopilotProxyClaudeOpus48 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-opus-4-8"
  }
}

client<llm> CopilotProxyClaudeSonnet4 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-sonnet-4"
  }
}

client<llm> CopilotProxyClaudeSonnet420250514 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-sonnet-4-20250514"
  }
}

client<llm> CopilotProxyClaudeSonnet45 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-sonnet-4-5"
  }
}

client<llm> CopilotProxyClaudeSonnet4520250929 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-sonnet-4-5-20250929"
  }
}

client<llm> CopilotProxyClaudeSonnet46 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "claude-sonnet-4-6"
  }
}

client<llm> CopilotProxyGemini25Pro {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "gemini-2.5-pro"
  }
}

client<llm> CopilotProxyGemini3FlashPreview {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "gemini-3-flash-preview"
  }
}

client<llm> CopilotProxyGemini3ProPreview {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "gemini-3-pro-preview"
  }
}

client<llm> CopilotProxyGpt41 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "gpt-4.1"
  }
}

client<llm> CopilotProxyGpt4o {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "gpt-4o"
  }
}

client<llm> CopilotProxyGpt5 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "gpt-5"
  }
}

client<llm> CopilotProxyGpt5Codex {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "gpt-5-codex"
  }
}

client<llm> CopilotProxyGpt5Mini {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "gpt-5-mini"
  }
}

client<llm> CopilotProxyGpt51 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "gpt-5.1"
  }
}

client<llm> CopilotProxyGpt51Codex {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "gpt-5.1-codex"
  }
}

client<llm> CopilotProxyGpt51CodexMax {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "gpt-5.1-codex-max"
  }
}

client<llm> CopilotProxyGpt51CodexMini {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "gpt-5.1-codex-mini"
  }
}

client<llm> CopilotProxyGpt52 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "gpt-5.2"
  }
}

client<llm> CopilotProxyGpt52Codex {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "gpt-5.2-codex"
  }
}

client<llm> CopilotProxyGpt53Codex {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "gpt-5.3-codex"
  }
}

client<llm> CopilotProxyGpt54 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "gpt-5.4"
  }
}

client<llm> CopilotProxyGpt55 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "gpt-5.5"
  }
}

client<llm> CopilotProxyGrokCodeFast1 {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "grok-code-fast-1"
  }
}

client<llm> CopilotProxyRaptorMini {
  provider "openai-generic"
  options {
    base_url "http://127.0.0.1:8080/v1"
    api_key env.COPILOT_PROXY_API_KEY
    model "raptor-mini"
  }
}
