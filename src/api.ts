/**
 * The two things every call to the account API from this daemon repeats:
 * where the endpoint is, and that the request carries this machine's key
 * and cannot outlive its budget. The callers keep their own error
 * handling — a publish logs and returns false, a directory refresh throws
 * — because what a failure means differs; only the convention lives here.
 */

/** `baseUrl` with its trailing slashes trimmed, plus `path`. */
export const apiUrl = (baseUrl: string, path: string): string => `${baseUrl.replace(/\/+$/, '')}${path}`;

/** Authenticated request with a hard deadline. A JSON body sets its own content type. */
export const apiFetch = (
    fetchFn: typeof fetch,
    url: string,
    apiKey: string,
    timeoutMs: number,
    init: RequestInit = {},
): Promise<Response> =>
    fetchFn(url, {
        ...init,
        headers: {
            'X-API-Key': apiKey,
            ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...init.headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
    });
