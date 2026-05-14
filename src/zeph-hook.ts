import type { ZephOptions, NotifyPayload, NotifyResult, ListParams, ListResult, PushItem, DismissOneResult, DismissAllResult, ApiErrorResponse, UploadRequestResult } from './types.js';
import { ZephError, AuthenticationError, QuotaExceededError } from './errors.js';
import { initCrypto, getKeyPair, encryptPushBodyForSelf, encryptFileForSelf } from './crypto.js';

const DEFAULT_BASE_URL = 'https://api.zeph.to/v1';
const DEFAULT_TIMEOUT_MS = 30_000;
const BODY_FILE_THRESHOLD = 512;
const PREVIEW_LENGTH = 200;

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

  private async ensureCrypto(): Promise<boolean> {
    if (this.cryptoInitialized) return !!getKeyPair();
    try {
      await initCrypto(this.apiKey, this.baseUrl);
      this.cryptoInitialized = true;
      return !!getKeyPair();
    } catch {
      this.cryptoInitialized = true;
      return false;
    }
  }

  async notify(payload: NotifyPayload): Promise<NotifyResult> {
    const canEncrypt = await this.ensureCrypto();
    const body = payload.body;
    const bodyBytes = body ? new TextEncoder().encode(body).byteLength : 0;
    const isLongBody = bodyBytes > BODY_FILE_THRESHOLD;

    if (isLongBody && body) {
      return this.notifyWithFile(payload, body, bodyBytes, canEncrypt);
    }

    // Encrypt push body if possible
    let sendPayload: Record<string, unknown> = { ...payload };
    if (canEncrypt) {
      try {
        const enc = await encryptPushBodyForSelf({ title: payload.title, body: payload.body, url: payload.url });
        sendPayload = { ...sendPayload, title: undefined, body: enc.body, isEncrypted: true, encryptedKey: enc.encryptedKey, senderPublicKey: enc.senderPublicKey };
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

  private async notifyWithFile(payload: NotifyPayload, body: string, fileSize: number, canEncrypt: boolean): Promise<NotifyResult> {
    const fileName = 'response.md';
    let fileType = inferMimeType(fileName);

    // Encrypt file content if possible
    let uploadContent: string | Buffer = body;
    let uploadSize = fileSize;
    let fileIv: string | undefined;
    let fileEncryptedKey: string | undefined;

    if (canEncrypt) {
      try {
        const encrypted = await encryptFileForSelf(body);
        uploadContent = encrypted.ciphertext;
        uploadSize = encrypted.ciphertext.length;
        fileType = 'application/octet-stream';
        fileIv = encrypted.iv;
        fileEncryptedKey = encrypted.encryptedKey;
      } catch (err) {
        console.error('[Crypto] File encryption failed, sending plaintext:', err);
      }
    }

    const upload = await this.requestUpload({ fileName, fileType, fileSize: uploadSize });
    await this.uploadToS3(upload.uploadUrl, uploadContent, fileType);

    const preview = body.length > PREVIEW_LENGTH ? body.slice(0, PREVIEW_LENGTH) + '...' : body;

    // Encrypt push body
    let sendPayload: Record<string, unknown> = {
      ...payload,
      body: preview,
      type: payload.type ?? 'file',
      files: [{ fileKey: upload.fileKey, fileName, fileSize, fileType: inferMimeType(fileName), iv: fileIv, encryptedKey: fileEncryptedKey }],
    };

    if (canEncrypt) {
      try {
        const enc = await encryptPushBodyForSelf({ title: payload.title, body: preview, url: payload.url });
        sendPayload = { ...sendPayload, title: undefined, body: enc.body, isEncrypted: true, encryptedKey: enc.encryptedKey, senderPublicKey: enc.senderPublicKey };
      } catch (err) {
        console.error('[Crypto] Push encryption failed, sending plaintext:', err);
      }
    }

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
      title: p.title,
      body: p.body?.slice(0, 100),
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
