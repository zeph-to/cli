import type { ZephOptions, NotifyPayload, NotifyResult, ListParams, ListResult, PushItem, DismissOneResult, DismissAllResult, ApiErrorResponse } from './types.js';
import { ZephError, AuthenticationError, QuotaExceededError } from './errors.js';

const DEFAULT_BASE_URL = 'https://api.zeph.to/v1';
const DEFAULT_TIMEOUT_MS = 30_000;

export class ZephHook {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: ZephOptions) {
    if (!options.apiKey) {
      throw new ZephError('apiKey is required', 'INVALID_OPTIONS', 400);
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  async notify(payload: NotifyPayload): Promise<NotifyResult> {
    const json = await this.request<{ data: { pushId: string } }>('POST', '/pushes/send', payload);
    const pushId = json.data?.pushId;
    if (!pushId) {
      throw new ZephError('Server returned no pushId', 'INVALID_RESPONSE', 500);
    }
    return { pushId };
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
