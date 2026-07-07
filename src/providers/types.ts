/**
 * Generative video provider interface.
 *
 * Every provider here talks to an official, documented API using the user's OWN
 * API key, within that service's Terms of Service and rate limits. There is no
 * browser-session reuse, no web-UI scraping, and no paywall circumvention. A
 * provider that cannot be used through a first-party API is intentionally absent.
 *
 * Providers are OPT-IN: the pipeline defaults to stock footage. Generation only
 * runs when the user explicitly enables it AND the provider is configured
 * (auth token + a model id, both supplied by the user).
 */
export interface GenOptions {
  width: number;
  height: number;
  durationSeconds: number;
  fps: number;
}

export interface GenResult {
  ok: boolean;
  provider: string;
  license: string;
  attribution: string;
  note?: string;
}

export interface GenerativeProvider {
  slug: string;
  /** Human-readable description for the registry / list_providers tool. */
  description: string;
  /** Env var names this provider reads (for docs + diagnostics). */
  authEnv: string[];
  /** True only when the auth token AND a model id are both present. */
  configured(): boolean;
  /**
   * Generate a clip for `prompt` and write the resulting video to `destAbsPath`.
   * Must fail safe (return ok:false) rather than throw for expected conditions.
   */
  generate(prompt: string, destAbsPath: string, opts: GenOptions): Promise<GenResult>;
}
