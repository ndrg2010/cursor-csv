/**
 * Manages OAuth 2.0 Client Credentials flow tokens for the Salesforce Connected App.
 * Caches the access token and refreshes ~5 minutes before expiry.
 */
export class SfAuthManager {
  #clientId;
  #clientSecret;
  #loginUrl;
  #fetchTimeoutMs;
  #accessToken = null;
  #instanceUrl = null;
  #expiresAt = 0;
  #pendingAuth = null;

  constructor(sfConfig) {
    this.#clientId = sfConfig.clientId;
    this.#clientSecret = sfConfig.clientSecret;
    this.#loginUrl = sfConfig.loginUrl;
    this.#fetchTimeoutMs = sfConfig.fetchTimeoutMs || 30_000;
  }

  get instanceUrl() {
    return this.#instanceUrl || this.#loginUrl;
  }

  async getAccessToken() {
    if (this.#accessToken && Date.now() < this.#expiresAt) {
      return this.#accessToken;
    }
    if (!this.#pendingAuth) {
      this.#pendingAuth = this.#authenticate().finally(() => {
        this.#pendingAuth = null;
      });
    }
    return this.#pendingAuth;
  }

  async #authenticate() {
    const tokenUrl = `${this.#loginUrl}/services/oauth2/token`;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(this.#fetchTimeoutMs),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw Object.assign(
        new Error(`SF auth failed: ${response.status} ${text}`),
        { code: 'SF_AUTH_FAILED', statusCode: 502 },
      );
    }

    const data = await response.json();
    this.#accessToken = data.access_token;
    this.#instanceUrl = data.instance_url;
    // SF tokens typically last ~2 hours; refresh 5 minutes early
    this.#expiresAt = Date.now() + (data.expires_in ? data.expires_in * 1000 : 7200_000) - 300_000;

    return this.#accessToken;
  }

  clearToken() {
    this.#accessToken = null;
    this.#expiresAt = 0;
  }
}
