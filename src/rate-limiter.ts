const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_FAILED_ATTEMPTS = 10;

interface AttemptRecord {
  count: number;
  window_start: number;
}

class RateLimiter {
  private attempts = new Map<string, AttemptRecord>();

  isAllowed(ip: string): boolean {
    const now = Date.now();
    const record = this.attempts.get(ip);
    if (!record || now - record.window_start > WINDOW_MS) return true;
    return record.count < MAX_FAILED_ATTEMPTS;
  }

  recordFailedAttempt(ip: string): void {
    const now = Date.now();
    const record = this.attempts.get(ip);
    if (!record || now - record.window_start > WINDOW_MS) {
      this.attempts.set(ip, { count: 1, window_start: now });
    } else {
      record.count++;
    }
  }

  resetAttempts(ip: string): void {
    this.attempts.delete(ip);
  }
}

export const rateLimiter = new RateLimiter();
