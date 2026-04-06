const CALLBACK_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 2_000;
const COORDINATOR_CLASS = 'CSV_Ready';

export class SfCallbackService {
  #apiVersion;
  #platformEventName;
  #log;
  /** @type {Set<string>} orgIds where the PE returned 404 */
  #orgsDenied = new Set();

  /**
   * @param {object} options
   * @param {string} options.apiVersion
   * @param {string} options.platformEventName
   * @param {object} [options.log]
   */
  constructor({ apiVersion, platformEventName, log }) {
    this.#apiVersion = apiVersion;
    this.#platformEventName = platformEventName;
    this.#log = log || console;
  }

  /**
   * Publish a coordinator Platform Event to the session's originating org.
   * The Apex-side coordinator class queries the middleware status endpoint
   * for full session details — the PE itself is a lightweight notification.
   * Fire-and-forget: never throws, never blocks the session lifecycle.
   * @param {import('./sf-auth.js').SfAuthManager} sfAuth
   * @param {import('./session-manager.js').Session} session
   */
  async publish(sfAuth, session) {
    const orgId = session.orgId;
    if (orgId && this.#orgsDenied.has(orgId)) return;

    const payload = {
      Job_Record_Id__c: session.cursorBatchJobId,
      Coordinator_Class__c: COORDINATOR_CLASS,
      Job_Name__c: session.csvQueryId,
    };

    try {
      await this.#post(sfAuth, payload);
      this.#log.info?.({ csvQueryId: session.csvQueryId, orgId, status: session.status }, 'Coordinator PE published');
    } catch (err) {
      if (err.statusCode === 404 && orgId) {
        this.#orgsDenied.add(orgId);
        this.#log.warn?.({ orgId, platformEvent: this.#platformEventName },
          'Platform Event not found in org; suppressing future callbacks for this org');
        return;
      }
      this.#log.warn?.({ err, csvQueryId: session.csvQueryId, orgId }, 'Coordinator PE publish failed, retrying');

      try {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        await this.#post(sfAuth, payload);
        this.#log.info?.({ csvQueryId: session.csvQueryId, orgId, status: session.status }, 'Coordinator PE published (retry)');
      } catch (retryErr) {
        if (retryErr.statusCode === 404 && orgId) {
          this.#orgsDenied.add(orgId);
          this.#log.warn?.({ orgId, platformEvent: this.#platformEventName },
            'Platform Event not found in org; suppressing future callbacks for this org');
          return;
        }
        this.#log.error?.({ err: retryErr, csvQueryId: session.csvQueryId, orgId },
          'Coordinator PE publish failed after retry');
      }
    }
  }

  async #post(sfAuth, payload) {
    const accessToken = await sfAuth.getAccessToken();
    const url = `${sfAuth.instanceUrl}/services/data/v${this.#apiVersion}/sobjects/${this.#platformEventName}/`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw Object.assign(
        new Error(`PE publish failed: ${response.status} ${text}`),
        { statusCode: response.status },
      );
    }

    return response.json();
  }

  clearDeniedOrg(orgId) {
    this.#orgsDenied.delete(orgId);
  }
}
