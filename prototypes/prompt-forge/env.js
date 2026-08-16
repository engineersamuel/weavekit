// Frontend env shim: exposes ENV as a global for the app's other scripts to read.
window.ENV = {
  API_BASE_URL: "/api",
  DEFAULT_AI_PROVIDER: "openai",
};
