// A connection URL without its sslmode/sslcert/... parameters. pg lets those
// override the pool's ssl setting, and Railway's public proxy URLs carry
// sslmode=require, which newer pg versions treat as "verify the certificate";
// the proxy's certificate is self-signed, so every connection then fails.
// Each pool sets ssl itself instead.
export function withoutSslParams(connectionString: string): string {
    const queryAt = connectionString.indexOf('?');
    if (queryAt < 0) return connectionString;
    const params = new URLSearchParams(connectionString.slice(queryAt + 1));
    for (const name of [...params.keys()]) {
        if (/^ssl/i.test(name) || name === 'uselibpqcompat') params.delete(name);
    }
    const query = params.toString();
    return connectionString.slice(0, queryAt) + (query ? `?${query}` : '');
}
