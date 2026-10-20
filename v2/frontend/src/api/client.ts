// Small fetch wrapper for the Gaze API. Sends the session cookie and turns
// error responses into ApiError, carrying the server's message.

export class ApiError extends Error {
    constructor(public readonly status: number, message: string) {
        super(message);
    }
}

export async function api<T>(path: string, options: {method?: string; body?: unknown} = {}): Promise<T> {
    const response = await fetch(path, {
        method: options.method ?? 'GET',
        credentials: 'same-origin',
        headers: options.body === undefined ? undefined : {'Content-Type': 'application/json'},
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (response.status === 204) return undefined as T;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, data.error ?? `Request failed (${response.status})`);
    return data as T;
}
