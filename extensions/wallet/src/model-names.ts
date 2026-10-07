// Dependency-free so the Control UI bundle (browser/render.ts) can share it with the runtime.
const PROVIDER_PREFIX = /^(?:claude-cli|anthropic|google|gemini|openai)\//;
export const stripProviderPrefix = (model: string) => model.replace(PROVIDER_PREFIX, "");

const MODEL_NAMES: Record<string, string> = {
  "claude-opus-5": "Claude Opus 5",
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-fable-5": "Claude Fable 5",
  "claude-fable-5-1": "Claude Fable 5.1",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.5-flash-lite": "Gemini 2.5 Flash-Lite",
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro (preview)",
  "gpt-5": "GPT-5",
  "gpt-5.2": "GPT-5.2",
  "gpt-5.4": "GPT-5.4",
  "gpt-5-mini": "GPT-5 mini",
  "gpt-5-nano": "GPT-5 nano",
};

/** The vendor behind a provider id: the runtime (`claude-cli`) is not something the owner reads. */
export function vendorOf(provider: string, model = ""): string {
  const p = provider.toLowerCase();
  if (p === "claude-cli" || p === "anthropic" || stripProviderPrefix(model).startsWith("claude-")) {
    return "anthropic";
  }
  if (p === "google" || p === "gemini") {
    return "google";
  }
  return p;
}

const VENDOR_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  google: "Google",
  openai: "OpenAI",
  ollama: "Ollama",
  xai: "xAI",
  groq: "Groq",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
};

/** What the page prints beside a model: the vendor's name, never a runtime id. */
export function providerDisplayName(provider: string, model = ""): string {
  const vendor = vendorOf(provider, model);
  return VENDOR_NAMES[vendor] ?? vendor;
}

/** A friendly model name for the page and `/wallet`; the provider is shown separately, never in the label. */
export function modelDisplayName(_provider: string, model: string): string {
  const bare = stripProviderPrefix(model);
  if (/^claude-haiku-4-5(?:-|$)/.test(bare)) {
    return "Claude Haiku 4.5";
  }
  return MODEL_NAMES[bare] ?? model;
}
