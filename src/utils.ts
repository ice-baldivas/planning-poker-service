import { randomInt } from 'crypto';

const MAX_NAME_LENGTH = 100;
const MAX_TEXT_LENGTH = 500;

/** Strip HTML tags and trim. Prevents XSS in user-supplied strings. */
export function sanitize(input: string, maxLength = MAX_NAME_LENGTH): string {
  return input.replace(/<[^>]*>/g, '').trim().slice(0, maxLength);
}

/** Sanitize long-form text fields (e.g. story descriptions). */
export function sanitizeText(input: string): string {
  return sanitize(input, MAX_TEXT_LENGTH);
}

/** Generate a zero-padded 6-digit session code (000000–999999). */
export function generateSessionId(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Generate a short collision-resistant ID for participants and stories. */
export function generateId(): string {
  return `${Date.now().toString(36)}-${randomInt(0, 0xffffff).toString(36)}`;
}
