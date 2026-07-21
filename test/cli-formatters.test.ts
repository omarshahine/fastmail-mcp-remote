import { describe, expect, it } from 'vitest';
import { formatEmailList } from '../cli/formatters';

/**
 * Address fields reach the CLI in two different shapes and both must render.
 *
 * List tools are flattened server-side by flattenEmailAddresses() into a
 * ready-made string ("Alice <a@b.com>") to save response tokens; single-email
 * tools still return the raw JMAP array of {name, email}. The formatter used
 * to assume the array shape and index [0], which on the flattened string
 * yields the first character — truthy, but with no .name/.email — and printed
 * a literal "undefined" as the sender (issue #57).
 */
describe('formatEmailList — address rendering', () => {
	const base = { id: 'M1', receivedAt: '2026-07-21T02:01:00Z', subject: 'Board Agenda' };

	it('renders the flattened string shape that list tools actually return', () => {
		const out = formatEmailList([{ ...base, from: 'Matthew Kane <matt.kane@corient.com>' }]);

		expect(out).toContain('Matthew Kane <matt.kane@corient.com>');
		expect(out).not.toContain('undefined');
	});

	it('still renders the raw JMAP array shape', () => {
		const out = formatEmailList([
			{ ...base, from: [{ name: 'Matthew Kane', email: 'matt.kane@corient.com' }] }
		]);

		expect(out).toContain('Matthew Kane <matt.kane@corient.com>');
		expect(out).not.toContain('undefined');
	});

	it('falls back to the bare address when a display name is absent', () => {
		expect(formatEmailList([{ ...base, from: [{ email: 'ir@columbiapacific.com' }] }])).toContain(
			'ir@columbiapacific.com'
		);
		expect(formatEmailList([{ ...base, from: 'ir@columbiapacific.com' }])).toContain(
			'ir@columbiapacific.com'
		);
	});

	it('never emits the string "undefined" for malformed or missing senders', () => {
		for (const from of [undefined, null, '', [], [{}], [{ name: 'No Address' }], {}]) {
			const out = formatEmailList([{ ...base, from } as never]);
			expect(out, `from=${JSON.stringify(from)}`).not.toContain('undefined');
		}
	});

	it('joins multiple senders rather than dropping all but the first', () => {
		const out = formatEmailList([
			{
				...base,
				from: [
					{ name: 'Alice', email: 'a@b.com' },
					{ name: 'Bob', email: 'b@c.com' }
				]
			}
		]);

		expect(out).toContain('Alice <a@b.com>');
		expect(out).toContain('Bob <b@c.com>');
	});

	it('trims the stray whitespace left by datamarking removal', () => {
		// stripDatamarking unwraps "[START] value [END]" and historically left a
		// trailing space behind, which showed up in the sender column.
		const out = formatEmailList([{ ...base, from: 'Matthew Kane <matt.kane@corient.com> ' }]);

		expect(out).not.toContain('com>  ');
	});
});
