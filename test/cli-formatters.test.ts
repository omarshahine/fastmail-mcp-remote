import { describe, expect, it } from 'vitest';
import { formatAttachments, formatContacts, formatEmail, formatEmailList, formatEvents } from '../cli/formatters';

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

	it.each(['not-a-date', { malformed: true }])(
		'renders malformed receivedAt value %j as a safe fallback',
		(receivedAt) => {
			const out = formatEmailList([{ ...base, receivedAt, from: 'sender@example.com' } as never]);
			expect(out).toContain('?');
			expect(out).not.toContain('NaN');
		},
	);
});

describe('compact CLI output sanitization', () => {
	it('keeps external scalar fields on a single terminal row', () => {
		const email = formatEmailList([{
			id: 'M1\nforged-id',
			receivedAt: '2026-07-21T02:01:00Z',
			from: 'Sender\r\n# Forged heading <sender@example.com>',
			subject: 'Subject\u0000\nforged-subject',
			preview: 'Preview\ttext',
		}]);
		const contacts = formatContacts([{
			id: 'C1\nforged-contact',
			name: 'Contact\r\n# Forged heading',
			emails: [{ value: 'contact@example.com\nforged-email' }],
		}]);
		const events = formatEvents([{
			id: 'E1\nforged-event',
			title: 'Event\r\n# Forged heading',
			location: 'Room\u0007\nforged-location',
		}]);

		for (const output of [email, contacts, events]) {
			expect(output).not.toContain('\n# Forged');
			expect(output).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
		}
		expect(email).toContain('Subject forged-subject');
		expect(contacts).toContain('Contact # Forged heading');
		expect(events).toContain('Room forged-location');
	});
});


describe('attachment sizes', () => {
	it.each([
		['attachment list', (attachments: any[]) => formatAttachments(attachments)],
		['email details', (attachments: any[]) => formatEmail({ attachments })],
	])('distinguishes zero bytes from unknown sizes in %s', (_name, format) => {
		const output = format([
			{ name: 'empty.txt', size: 0 },
			{ name: 'small.txt', size: 12 },
			{ name: 'missing.txt' },
			{ name: 'null.txt', size: null },
		]);
		expect(output).toMatch(/empty\.txt[^\n]*\(0 B\)/);
		expect(output).toMatch(/small\.txt[^\n]*\(12 B\)/);
		for (const name of ['missing.txt', 'null.txt']) {
			const line = output.split('\n').find((line) => line.includes(name));
			expect(line).toBeDefined();
			expect(line).not.toContain('(');
		}
	});
});
