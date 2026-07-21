import { describe, expect, it } from 'vitest';
import { signAction, verifyAction } from '../src/action-urls';

// 256-bit key as hex, matching what ACTION_SIGNING_KEY holds.
const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);

function futureExp(): number {
	return Math.floor(Date.now() / 1000) + 3600;
}

describe('signAction / verifyAction', () => {
	it('round-trips a valid signature', async () => {
		const exp = futureExp();
		const sig = await signAction('archive', 'email-1', 'mailbox-1', exp, KEY);

		await expect(verifyAction('archive', 'email-1', 'mailbox-1', exp, sig, KEY)).resolves.toBe(true);
	});

	it('produces a 64-char hex HMAC-SHA256 digest', async () => {
		const sig = await signAction('delete', 'email-1', '', futureExp(), KEY);
		expect(sig).toMatch(/^[0-9a-f]{64}$/);
	});

	it('rejects a tampered action, emailId, mailbox, or expiry', async () => {
		const exp = futureExp();
		const sig = await signAction('archive', 'email-1', 'mailbox-1', exp, KEY);

		await expect(verifyAction('delete', 'email-1', 'mailbox-1', exp, sig, KEY)).resolves.toBe(false);
		await expect(verifyAction('archive', 'email-2', 'mailbox-1', exp, sig, KEY)).resolves.toBe(false);
		await expect(verifyAction('archive', 'email-1', 'mailbox-2', exp, sig, KEY)).resolves.toBe(false);
		await expect(verifyAction('archive', 'email-1', 'mailbox-1', exp + 1, sig, KEY)).resolves.toBe(false);
	});

	it('rejects a signature made with a different key', async () => {
		const exp = futureExp();
		const sig = await signAction('archive', 'email-1', 'mailbox-1', exp, OTHER_KEY);

		await expect(verifyAction('archive', 'email-1', 'mailbox-1', exp, sig, KEY)).resolves.toBe(false);
	});

	it('rejects an expired signature even when otherwise valid', async () => {
		const pastExp = Math.floor(Date.now() / 1000) - 1;
		const sig = await signAction('archive', 'email-1', 'mailbox-1', pastExp, KEY);

		await expect(verifyAction('archive', 'email-1', 'mailbox-1', pastExp, sig, KEY)).resolves.toBe(false);
	});

	it('rejects malformed signatures without throwing', async () => {
		const exp = futureExp();

		// Empty, wrong length, and non-hex input all previously risked reaching
		// hexToBuffer and producing NaN bytes.
		await expect(verifyAction('archive', 'e', 'm', exp, '', KEY)).resolves.toBe(false);
		await expect(verifyAction('archive', 'e', 'm', exp, 'abc', KEY)).resolves.toBe(false);
		await expect(verifyAction('archive', 'e', 'm', exp, 'z'.repeat(64), KEY)).resolves.toBe(false);
	});

	it('rejects a signature that is a valid HMAC of a different payload', async () => {
		const exp = futureExp();
		// The old implementation compared against a self-verified digest; make
		// sure a well-formed signature for another payload is still refused.
		const sig = await signAction('archive', 'other-email', 'mailbox-1', exp, KEY);

		await expect(verifyAction('archive', 'email-1', 'mailbox-1', exp, sig, KEY)).resolves.toBe(false);
	});
});
