// Slows down password guessing: after MAX_FAILURES failed logins for the same
// client and login name within WINDOW_MS, further attempts are refused until
// the window has passed. In memory, so it resets on restart; enough for a
// small internal app with one instance.

const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;

export class LoginLimiter {
    private failures = new Map<string, number[]>();

    constructor(private readonly now: () => number = Date.now) {}

    private recent(key: string): number[] {
        const cutoff = this.now() - WINDOW_MS;
        const times = (this.failures.get(key) ?? []).filter(t => t > cutoff);
        if (times.length) this.failures.set(key, times);
        else this.failures.delete(key);
        return times;
    }

    isBlocked(key: string): boolean {
        return this.recent(key).length >= MAX_FAILURES;
    }

    recordFailure(key: string): void {
        this.failures.set(key, [...this.recent(key), this.now()]);
    }

    recordSuccess(key: string): void {
        this.failures.delete(key);
    }
}
