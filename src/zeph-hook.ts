import { execFileSync } from 'node:child_process';
import { listenerDeviceId } from './listener-device-id.js';
import type { ZephOptions, NotifyPayload, NotifyResult, ListParams, ListResult, PushItem, DismissOneResult, DismissAllResult, ApiErrorResponse, UploadRequestResult } from './types.js';
import { ZephError, AuthenticationError, QuotaExceededError } from './errors.js';
import { initCrypto, getKeyPair, disableCrypto, selectRecipients, encryptPushBodyForDevices, encryptFileForDevices, type DeviceRecipient } from './crypto.js';

const DEFAULT_BASE_URL = 'https://api.zeph.to/v1';
const DEFAULT_TIMEOUT_MS = 30_000;
const BODY_FILE_THRESHOLD = 512;
const PREVIEW_LENGTH = 200;

/**
 * Stable agent-session grouping when running inside a tmux agent session, so a
 * hook/notify (e.g. the Stop-hook recap) files under the same session key as
 * the listener's pushes — surviving Claude session-UUID rotation. The device id
 * MUST equal the listener's `computeListenerDeviceId`, so it's resolved the same
 * way (machine-id hash → sticky file → hostname) via the shared read-only
 * helper — NOT a bare hostname hash, which drifts from the listener's id when a
 * machine id is readable and files the push under a non-matching session key.
 */
const agentSessionContext = (): { agentDeviceId: string; agentSessionName: string } | null => {
  if (!process.env.TMUX) return null;
  let name: string;
  try {
    name = execFileSync('tmux', ['display-message', '-p', '#S'], { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
  if (!name) return null;
  return { agentDeviceId: listenerDeviceId(), agentSessionName: name };
};

const inferMimeType = (fileName: string): string => {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = { md: 'text/markdown', txt: 'text/plain', json: 'application/json' };
  return map[ext ?? ''] ?? 'text/plain';
};

export class ZephHook {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  private cryptoInitialized = false;

  constructor(options: ZephOptions) {
    if (!options.apiKey) {
      throw new ZephError('apiKey is required', 'INVALID_OPTIONS', 400);
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Resolve who this push can be encrypted for, or null when it cannot be.
   *
   * The device list is fetched per send rather than cached: a phone that
   * registered its key a minute ago must be able to read the next push, and a
   * long-lived listener would otherwise keep wrapping for a stale set.
   * Failures here are not fatal — plaintext the user can read beats a
   * notification that never arrives.
   */
  private async ensureCrypto(): Promise<DeviceRecipient[] | null> {
    if (!this.cryptoInitialized) {
      try {
        await initCrypto(this.apiKey, this.baseUrl);
      } catch {
        // fall through — getKeyPair() stays null and we send plaintext
      }
      this.cryptoInitialized = true;
    }
    if (!getKeyPair()) return null;

    try {
      const json = await this.request<{ data: { deviceId: string; publicKey?: string }[] }>('GET', '/devices');
      const recipients = selectRecipients(json.data ?? []);
      if (recipients.length === 0) {
        console.error('[Crypto] No device has a per-device public key — sending plaintext.');
        return null;
      }
      return recipients;
    } catch (err) {
      console.error('[Crypto] Could not list devices, sending plaintext:', err);
      return null;
    }
  }

  /**
   * A push must not be lost because E2E turned out to be unavailable.
   *
   * E2E is Pro-only (ADR-0008) and the server rejects `isEncrypted` from a free
   * account with 403 `PRO_REQUIRED`. This process may have initialized crypto
   * while still Pro — a long-lived listener outlives a downgrade — so the
   * rejection is only visible at send time. Drop the keys and run the send
   * again from the top: the retry re-encodes the payload as plaintext and, on
   * the file path, re-uploads the file unencrypted (a payload patch would leave
   * an undecryptable blob in S3). The first, encrypted object stays orphaned —
   * accepted cost; the upload endpoint has no quota counter to burn.
   */
  async notify(payload: NotifyPayload): Promise<NotifyResult> {
    // Resolved once for both attempts: the lookup shells out to tmux, and a
    // retry milliseconds later cannot land in a different session.
    const agentCtx = agentSessionContext();
    try {
      return await this.notifyOnce(payload, agentCtx);
    } catch (err) {
      // Held keys are what proves this send was encrypted, and dropping them is
      // also the recursion guard — the retry has none, so a second 403 propagates.
      if (!(err instanceof ZephError) || err.code !== 'PRO_REQUIRED' || !getKeyPair()) throw err;
      disableCrypto();
      console.error('[Crypto] End-to-end encryption requires Zeph Pro — resending as plaintext.');
      return this.notifyOnce(payload, agentCtx);
    }
  }

  private async notifyOnce(
    payload: NotifyPayload,
    agentCtx: ReturnType<typeof agentSessionContext>,
  ): Promise<NotifyResult> {
    // Attach the stable session key when in a tmux agent session so the push
    // joins the agent chat. Merged into `payload` here so both the inline and
    // file-upload (notifyWithFile) paths — which each spread `...payload` —
    // carry it. Explicit caller values win.
    if (agentCtx) payload = { ...agentCtx, ...payload };
    const recipients = await this.ensureCrypto();
    const body = payload.body;
    const bodyBytes = body ? new TextEncoder().encode(body).byteLength : 0;
    const isLongBody = bodyBytes > BODY_FILE_THRESHOLD;

    if (isLongBody && body) {
      return this.notifyWithFile(payload, body, bodyBytes, recipients);
    }

    // Encrypt push body if possible
    let sendPayload: Record<string, unknown> = { ...payload };
    if (recipients) {
      try {
        const enc = await encryptPushBodyForDevices({ title: payload.title, body: payload.body, url: payload.url }, recipients);
        // `url: undefined` alongside the title: it is already sealed inside the
        // ciphertext, and on a link push it IS the payload. Spreading `payload`
        // above left the plaintext copy at the top level, handing the server the
        // one thing `isEncrypted` promises it cannot see.
        sendPayload = { ...sendPayload, title: undefined, url: undefined, body: enc.body, isEncrypted: true, deviceKeyMap: enc.deviceKeyMap, senderPublicKey: enc.senderPublicKey };
      } catch (err) {
        console.error('[Crypto] Push encryption failed, sending plaintext:', err);
      }
    }

    const json = await this.request<{ data: { pushId: string } }>('POST', '/pushes/send', sendPayload);
    const pushId = json.data?.pushId;
    if (!pushId) {
      throw new ZephError('Server returned no pushId', 'INVALID_RESPONSE', 500);
    }
    return { pushId };
  }

  private async notifyWithFile(payload: NotifyPayload, body: string, fileSize: number, recipients: DeviceRecipient[] | null): Promise<NotifyResult> {
    const fileName = 'response.md';
    const preview = body.length > PREVIEW_LENGTH ? body.slice(0, PREVIEW_LENGTH) + '...' : body;

    // Encrypt the attachment and the push body together, before anything is
    // uploaded. Doing them one at a time around the upload let a failure land
    // in between and ship ciphertext under a push with no `isEncrypted` — an
    // attachment no client would even try to open.
    let encrypted: {
      file: Awaited<ReturnType<typeof encryptFileForDevices>>;
      push: Awaited<ReturnType<typeof encryptPushBodyForDevices>>;
    } | null = null;
    if (recipients) {
      try {
        encrypted = {
          file: await encryptFileForDevices(body, recipients),
          push: await encryptPushBodyForDevices({ title: payload.title, body: preview, url: payload.url }, recipients),
        };
      } catch (err) {
        console.error('[Crypto] Encryption failed, sending plaintext:', err);
      }
    }

    const uploadContent: string | Buffer = encrypted?.file.ciphertext ?? body;
    const uploadType = encrypted ? 'application/octet-stream' : inferMimeType(fileName);
    const uploadSize = encrypted ? encrypted.file.ciphertext.length : fileSize;

    const upload = await this.requestUpload({ fileName, fileType: uploadType, fileSize: uploadSize });
    await this.uploadToS3(upload.uploadUrl, uploadContent, uploadType);

    const sendPayload: Record<string, unknown> = {
      ...payload,
      title: encrypted ? undefined : payload.title,
      body: encrypted ? encrypted.push.body : preview,
      type: payload.type ?? 'file',
      files: [{
        fileKey: upload.fileKey,
        fileName,
        fileSize,
        fileType: inferMimeType(fileName),
        iv: encrypted?.file.iv,
        deviceKeyMap: encrypted?.file.deviceKeyMap,
      }],
      ...(encrypted && {
        // See notifyOnce: the url must not survive in the clear either.
        url: undefined,
        isEncrypted: true,
        deviceKeyMap: encrypted.push.deviceKeyMap,
        senderPublicKey: encrypted.push.senderPublicKey,
      }),
    };

    const json = await this.request<{ data: { pushId: string } }>('POST', '/pushes/send', sendPayload);

    const pushId = json.data?.pushId;
    if (!pushId) {
      throw new ZephError('Server returned no pushId', 'INVALID_RESPONSE', 500);
    }
    return { pushId, fileKey: upload.fileKey, autoFile: true };
  }

  async requestUpload(params: { fileName: string; fileType: string; fileSize: number }): Promise<UploadRequestResult> {
    const json = await this.request<{ data: UploadRequestResult }>('POST', '/files/upload-request', params);
    return json.data;
  }

  async uploadToS3(url: string, content: string | Buffer, contentType: string): Promise<void> {
    const isText = typeof content === 'string';
    const body = isText ? content : new Uint8Array(content);
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': isText ? `${contentType}; charset=utf-8` : contentType },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new ZephError(`S3 upload failed with status ${response.status}`, 'UPLOAD_FAILED', response.status);
    }
  }

  async list(params?: ListParams): Promise<ListResult> {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.type) query.set('type', params.type);
    const qs = query.toString();
    const json = await this.request<{
      data: PushItem[];
      pagination: { hasMore: boolean };
    }>('GET', `/pushes${qs ? `?${qs}` : ''}`);
    const pushes = json.data.map((p) => ({
      pushId: p.pushId,
      type: p.type,
      // An encrypted push carries no plaintext title and a JSON envelope in
      // `body`; slicing that renders `{"ciphertext":"AAAB...` as if it were the
      // message. This host cannot decrypt (send-only), so say so instead.
      title: p.isEncrypted ? undefined : p.title,
      body: p.isEncrypted ? '[encrypted]' : p.body?.slice(0, 100),
      isEncrypted: p.isEncrypted,
      createdAt: p.createdAt,
    }));
    return { pushes, count: pushes.length, hasMore: json.pagination?.hasMore ?? false };
  }

  async dismiss(pushId: string): Promise<DismissOneResult> {
    await this.request('POST', `/pushes/${encodeURIComponent(pushId)}/dismiss`);
    return { dismissed: true };
  }

  async dismissAll(): Promise<DismissAllResult> {
    const json = await this.request<{ data: { dismissed: number } }>('POST', '/pushes/dismiss-all');
    return { dismissed: json.data?.dismissed ?? 0 };
  }

  /**
   * Set (or clear, with an empty alias) the display name for an agent session,
   * keyed by its tmux `name` on `deviceId`. The alias overrides the app's
   * computed session label; it survives listener re-reports (server-side).
   */
  async renameAgentSession(deviceId: string, name: string, alias: string): Promise<{ deviceId: string }> {
    const res = await this.request<{ data: { deviceId: string } }>(
      'PATCH',
      `/devices/${encodeURIComponent(deviceId)}/agent-sessions/${encodeURIComponent(name)}`,
      { alias },
    );
    return { deviceId: res.data.deviceId };
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = { 'X-API-Key': this.apiKey };
    if (body) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ZephError(`Request timed out after ${this.timeoutMs}ms`, 'TIMEOUT', 408);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const json = await response.json() as T & ApiErrorResponse;

    if (!response.ok) {
      throw this.parseError(response.status, json as ApiErrorResponse);
    }

    return json;
  }

  private parseError(status: number, body: ApiErrorResponse): ZephError {
    const message = body.error?.message ?? `Request failed with status ${status}`;
    const code = body.error?.code ?? 'UNKNOWN_ERROR';

    if (status === 401) return new AuthenticationError(message);
    if (status === 403 && code === 'QUOTA_EXCEEDED') return new QuotaExceededError(message);

    return new ZephError(message, code, status);
  }
}
