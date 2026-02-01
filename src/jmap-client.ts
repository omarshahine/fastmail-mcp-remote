import { FastmailAuth } from './fastmail-auth';

export interface JmapSession {
  apiUrl: string;
  accountId: string;
  capabilities: Record<string, any>;
  downloadUrl?: string;
  uploadUrl?: string;
}

export interface JmapRequest {
  using: string[];
  methodCalls: [string, any, string][];
}

export interface JmapResponse {
  methodResponses: Array<[string, any, string]>;
  sessionState: string;
}

export interface AttachmentContent {
  filename: string;
  mimeType: string;
  size: number;
  blobId: string;
  content: string; // Base64-encoded
}

export interface AttachmentMetadata {
  filename: string;
  mimeType: string;
  size: number;
  blobId: string;
  downloadUrl: string;
}

// Maximum attachment size we'll fetch (10 MB)
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

// Maximum attachment size for upload (25 MB)
const MAX_UPLOAD_SIZE = 25 * 1024 * 1024;

// MIME type validation regex (type/subtype format)
const MIME_TYPE_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*$/;

// Dangerous filename patterns to reject
const DANGEROUS_FILENAME_PATTERNS = [
  /\.\./,           // Path traversal
  /^\/|^\\/,        // Absolute paths
  /[<>:"|?*\x00-\x1f]/, // Invalid filename chars
];

export interface UploadedBlob {
  blobId: string;
  type: string;
  size: number;
}

export interface AttachmentInput {
  filename: string;
  mimeType: string;
  content: string; // Base64-encoded content
}

/** Uploaded attachment ready for inclusion in email */
export interface UploadedAttachment {
  blobId: string;
  type: string;
  name: string;
  size: number;
}

/** JMAP Email attachment object */
export interface JmapEmailAttachment {
  blobId: string;
  type: string;
  name: string;
  size: number;
  disposition: 'attachment' | 'inline';
}

/** JMAP Email body part reference */
export interface JmapBodyPart {
  partId: string;
  type: string;
}

/** JMAP Email address object */
export interface JmapEmailAddress {
  email: string;
  name?: string;
}

/** JMAP Email object for creation */
export interface JmapEmailObject {
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from: JmapEmailAddress[];
  to: JmapEmailAddress[];
  cc: JmapEmailAddress[];
  bcc: JmapEmailAddress[];
  subject: string;
  textBody?: JmapBodyPart[];
  htmlBody?: JmapBodyPart[];
  bodyValues: Record<string, { value: string }>;
  attachments?: JmapEmailAttachment[];
}

/**
 * Validates a filename for safety
 * @throws Error if filename is invalid or potentially dangerous
 */
export function validateFilename(filename: string): void {
  if (!filename || typeof filename !== 'string') {
    throw new Error('Filename is required and must be a string');
  }

  if (filename.length === 0 || filename.length > 255) {
    throw new Error('Filename must be between 1 and 255 characters');
  }

  for (const pattern of DANGEROUS_FILENAME_PATTERNS) {
    if (pattern.test(filename)) {
      throw new Error(`Invalid filename: "${filename}" contains disallowed characters or patterns`);
    }
  }
}

/**
 * Validates a MIME type format
 * @throws Error if MIME type is invalid
 */
export function validateMimeType(mimeType: string): void {
  if (!mimeType || typeof mimeType !== 'string') {
    throw new Error('MIME type is required and must be a string');
  }

  if (!MIME_TYPE_REGEX.test(mimeType)) {
    throw new Error(`Invalid MIME type format: "${mimeType}". Expected format: type/subtype (e.g., "application/pdf")`);
  }
}

/**
 * Decodes base64 content to Uint8Array with validation
 * @throws Error if content is not valid base64
 */
export function decodeBase64(content: string): Uint8Array {
  if (!content || typeof content !== 'string') {
    throw new Error('Content is required and must be a string');
  }

  let binaryString: string;
  try {
    binaryString = atob(content);
  } catch (e) {
    throw new Error('Invalid base64 content. Ensure the attachment is properly base64-encoded.');
  }

  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return bytes;
}

export class JmapClient {
  private auth: FastmailAuth;
  private session: JmapSession | null = null;

  constructor(auth: FastmailAuth) {
    this.auth = auth;
  }

  async getSession(): Promise<JmapSession> {
    if (this.session) {
      return this.session;
    }

    const response = await fetch(this.auth.getSessionUrl(), {
      method: 'GET',
      headers: this.auth.getAuthHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to get session: ${response.statusText}`);
    }

    const sessionData = await response.json() as any;

    this.session = {
      apiUrl: sessionData.apiUrl,
      accountId: Object.keys(sessionData.accounts)[0],
      capabilities: sessionData.capabilities,
      downloadUrl: sessionData.downloadUrl,
      uploadUrl: sessionData.uploadUrl
    };

    return this.session;
  }

  async getUserEmail(): Promise<string> {
    try {
      const identity = await this.getDefaultIdentity();
      return identity?.email || 'user@example.com';
    } catch (error) {
      return 'user@example.com';
    }
  }

  async makeRequest(request: JmapRequest): Promise<JmapResponse> {
    const session = await this.getSession();

    const response = await fetch(session.apiUrl, {
      method: 'POST',
      headers: this.auth.getAuthHeaders(),
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error(`JMAP request failed: ${response.statusText}`);
    }

    return await response.json() as JmapResponse;
  }

  async uploadBlob(content: string, mimeType: string): Promise<UploadedBlob> {
    const session = await this.getSession();

    if (!session.uploadUrl) {
      throw new Error('Upload capability not available in session');
    }

    // Validate MIME type
    validateMimeType(mimeType);

    // Decode and validate base64 content
    const bytes = decodeBase64(content);

    if (bytes.length > MAX_UPLOAD_SIZE) {
      throw new Error(
        `Attachment is too large (${Math.round(bytes.length / 1024 / 1024)}MB). ` +
        `Maximum upload size is ${MAX_UPLOAD_SIZE / 1024 / 1024}MB.`
      );
    }

    // Build upload URL with accountId
    const uploadUrl = session.uploadUrl.replace('{accountId}', session.accountId);

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        ...this.auth.getAuthHeaders(),
        'Content-Type': mimeType
      },
      body: bytes
    });

    if (!response.ok) {
      throw new Error(`Failed to upload blob: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as {
      accountId: string;
      blobId: string;
      type: string;
      size: number;
    };

    return {
      blobId: result.blobId,
      type: result.type,
      size: result.size
    };
  }

  /**
   * Validates and uploads multiple attachments in parallel
   * @returns Array of uploaded attachment metadata
   */
  private async uploadAttachments(attachments?: AttachmentInput[]): Promise<UploadedAttachment[]> {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    // Validate all attachments first before uploading
    for (const attachment of attachments) {
      validateFilename(attachment.filename);
      validateMimeType(attachment.mimeType);
    }

    // Upload in parallel for better performance
    const uploadPromises = attachments.map(async (attachment) => {
      const uploaded = await this.uploadBlob(attachment.content, attachment.mimeType);
      return {
        blobId: uploaded.blobId,
        type: attachment.mimeType,
        name: attachment.filename,
        size: uploaded.size
      };
    });

    return Promise.all(uploadPromises);
  }

  /**
   * Converts uploaded attachments to JMAP email attachment format
   */
  private toJmapAttachments(uploadedAttachments: UploadedAttachment[]): JmapEmailAttachment[] {
    return uploadedAttachments.map(att => ({
      blobId: att.blobId,
      type: att.type,
      name: att.name,
      size: att.size,
      disposition: 'attachment' as const
    }));
  }

  async getMailboxes(): Promise<any[]> {
    const session = await this.getSession();

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Mailbox/get', { accountId: session.accountId }, 'mailboxes']
      ]
    };

    const response = await this.makeRequest(request);
    return response.methodResponses[0][1].list;
  }

  async getEmails(mailboxId?: string, limit: number = 20): Promise<any[]> {
    const session = await this.getSession();

    const filter = mailboxId ? { inMailbox: mailboxId } : {};

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/query', {
          accountId: session.accountId,
          filter,
          sort: [{ property: 'receivedAt', isAscending: false }],
          limit
        }, 'query'],
        ['Email/get', {
          accountId: session.accountId,
          '#ids': { resultOf: 'query', name: 'Email/query', path: '/ids' },
          properties: ['id', 'subject', 'from', 'to', 'receivedAt', 'preview', 'hasAttachment']
        }, 'emails']
      ]
    };

    const response = await this.makeRequest(request);
    return response.methodResponses[1][1].list;
  }

  async getEmailById(id: string): Promise<any> {
    const session = await this.getSession();

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/get', {
          accountId: session.accountId,
          ids: [id],
          properties: ['id', 'subject', 'from', 'to', 'cc', 'bcc', 'receivedAt', 'textBody', 'htmlBody', 'attachments', 'bodyValues'],
          bodyProperties: ['partId', 'blobId', 'type', 'size'],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
        }, 'email']
      ]
    };

    const response = await this.makeRequest(request);
    const result = response.methodResponses[0][1];

    if (result.notFound && result.notFound.includes(id)) {
      throw new Error(`Email with ID '${id}' not found`);
    }

    const email = result.list[0];
    if (!email) {
      throw new Error(`Email with ID '${id}' not found or not accessible`);
    }

    return email;
  }

  async getIdentities(): Promise<any[]> {
    const session = await this.getSession();

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:submission'],
      methodCalls: [
        ['Identity/get', {
          accountId: session.accountId
        }, 'identities']
      ]
    };

    const response = await this.makeRequest(request);
    return response.methodResponses[0][1].list;
  }

  async getDefaultIdentity(): Promise<any> {
    const identities = await this.getIdentities();
    return identities.find((id: any) => id.mayDelete === false) || identities[0];
  }

  async createDraft(email: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    textBody?: string;
    htmlBody?: string;
    from?: string;
    attachments?: AttachmentInput[];
  }): Promise<string> {
    const session = await this.getSession();

    const identities = await this.getIdentities();
    if (!identities || identities.length === 0) {
      throw new Error('No sending identities found');
    }

    let selectedIdentity;
    if (email.from) {
      selectedIdentity = identities.find(id =>
        id.email.toLowerCase() === email.from?.toLowerCase()
      );
      if (!selectedIdentity) {
        throw new Error('From address is not verified for sending. Choose one of your verified identities.');
      }
    } else {
      selectedIdentity = identities.find(id => id.mayDelete === false) || identities[0];
    }

    const fromEmail = selectedIdentity.email;

    const mailboxes = await this.getMailboxes();
    const draftsMailbox = mailboxes.find(mb => mb.role === 'drafts') || mailboxes.find(mb => mb.name.toLowerCase().includes('draft'));

    if (!draftsMailbox) {
      throw new Error('Could not find Drafts mailbox');
    }

    if (!email.textBody && !email.htmlBody) {
      throw new Error('Either textBody or htmlBody must be provided');
    }

    // Upload attachments (validates and uploads in parallel)
    const uploadedAttachments = await this.uploadAttachments(email.attachments);

    const draftsMailboxIds: Record<string, boolean> = {};
    draftsMailboxIds[draftsMailbox.id] = true;

    const emailObject: JmapEmailObject = {
      mailboxIds: draftsMailboxIds,
      keywords: { $draft: true },
      from: [{ email: fromEmail }],
      to: email.to.map(addr => ({ email: addr })),
      cc: email.cc?.map(addr => ({ email: addr })) || [],
      bcc: email.bcc?.map(addr => ({ email: addr })) || [],
      subject: email.subject,
      textBody: email.textBody ? [{ partId: 'text', type: 'text/plain' }] : undefined,
      htmlBody: email.htmlBody ? [{ partId: 'html', type: 'text/html' }] : undefined,
      bodyValues: {
        ...(email.textBody && { text: { value: email.textBody } }),
        ...(email.htmlBody && { html: { value: email.htmlBody } })
      }
    };

    // Add attachments if any were uploaded
    if (uploadedAttachments.length > 0) {
      emailObject.attachments = this.toJmapAttachments(uploadedAttachments);
    }

    // Only Email/set - no EmailSubmission/set (that's what makes it a draft)
    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/set', {
          accountId: session.accountId,
          create: { draft: emailObject }
        }, 'createDraft']
      ]
    };

    const response = await this.makeRequest(request);

    const emailResult = response.methodResponses[0][1];
    if (emailResult.notCreated && emailResult.notCreated.draft) {
      const error = emailResult.notCreated.draft;
      throw new Error(`Failed to create draft: ${error.type || 'unknown error'}. ${error.description || ''}`);
    }

    return emailResult.created?.draft?.id || 'unknown';
  }

  async sendEmail(email: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    textBody?: string;
    htmlBody?: string;
    from?: string;
    mailboxId?: string;
    attachments?: AttachmentInput[];
  }): Promise<string> {
    const session = await this.getSession();

    const identities = await this.getIdentities();
    if (!identities || identities.length === 0) {
      throw new Error('No sending identities found');
    }

    let selectedIdentity;
    if (email.from) {
      selectedIdentity = identities.find(id =>
        id.email.toLowerCase() === email.from?.toLowerCase()
      );
      if (!selectedIdentity) {
        throw new Error('From address is not verified for sending. Choose one of your verified identities.');
      }
    } else {
      selectedIdentity = identities.find(id => id.mayDelete === false) || identities[0];
    }

    const fromEmail = selectedIdentity.email;

    const mailboxes = await this.getMailboxes();
    const draftsMailbox = mailboxes.find(mb => mb.role === 'drafts') || mailboxes.find(mb => mb.name.toLowerCase().includes('draft'));
    const sentMailbox = mailboxes.find(mb => mb.role === 'sent') || mailboxes.find(mb => mb.name.toLowerCase().includes('sent'));

    if (!draftsMailbox) {
      throw new Error('Could not find Drafts mailbox to save email');
    }
    if (!sentMailbox) {
      throw new Error('Could not find Sent mailbox to move email after sending');
    }

    const initialMailboxId = email.mailboxId || draftsMailbox.id;

    if (!email.textBody && !email.htmlBody) {
      throw new Error('Either textBody or htmlBody must be provided');
    }

    // Upload attachments (validates and uploads in parallel)
    const uploadedAttachments = await this.uploadAttachments(email.attachments);

    const initialMailboxIds: Record<string, boolean> = {};
    initialMailboxIds[initialMailboxId] = true;

    const sentMailboxIds: Record<string, boolean> = {};
    sentMailboxIds[sentMailbox.id] = true;

    const emailObject: JmapEmailObject = {
      mailboxIds: initialMailboxIds,
      keywords: { $draft: true },
      from: [{ email: fromEmail }],
      to: email.to.map(addr => ({ email: addr })),
      cc: email.cc?.map(addr => ({ email: addr })) || [],
      bcc: email.bcc?.map(addr => ({ email: addr })) || [],
      subject: email.subject,
      textBody: email.textBody ? [{ partId: 'text', type: 'text/plain' }] : undefined,
      htmlBody: email.htmlBody ? [{ partId: 'html', type: 'text/html' }] : undefined,
      bodyValues: {
        ...(email.textBody && { text: { value: email.textBody } }),
        ...(email.htmlBody && { html: { value: email.htmlBody } })
      }
    };

    // Add attachments if any were uploaded
    if (uploadedAttachments.length > 0) {
      emailObject.attachments = this.toJmapAttachments(uploadedAttachments);
    }

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'],
      methodCalls: [
        ['Email/set', {
          accountId: session.accountId,
          create: { draft: emailObject }
        }, 'createEmail'],
        ['EmailSubmission/set', {
          accountId: session.accountId,
          create: {
            submission: {
              emailId: '#draft',
              identityId: selectedIdentity.id,
              envelope: {
                mailFrom: { email: fromEmail },
                rcptTo: email.to.map(addr => ({ email: addr }))
              }
            }
          },
          onSuccessUpdateEmail: {
            '#submission': {
              mailboxIds: sentMailboxIds,
              keywords: { $seen: true }
            }
          }
        }, 'submitEmail']
      ]
    };

    const response = await this.makeRequest(request);

    const emailResult = response.methodResponses[0][1];
    if (emailResult.notCreated && emailResult.notCreated.draft) {
      const error = emailResult.notCreated.draft;
      throw new Error(`Failed to create email: ${error.type || 'unknown error'}. ${error.description || ''}`);
    }

    const submissionResult = response.methodResponses[1][1];
    if (submissionResult.notCreated && submissionResult.notCreated.submission) {
      const error = submissionResult.notCreated.submission;
      throw new Error(`Failed to submit email: ${error.type || 'unknown error'}. ${error.description || ''}`);
    }

    return submissionResult.created?.submission?.id || 'unknown';
  }

  async searchEmails(query: string, limit: number = 20): Promise<any[]> {
    const session = await this.getSession();

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/query', {
          accountId: session.accountId,
          filter: { text: query },
          sort: [{ property: 'receivedAt', isAscending: false }],
          limit
        }, 'query'],
        ['Email/get', {
          accountId: session.accountId,
          '#ids': { resultOf: 'query', name: 'Email/query', path: '/ids' },
          properties: ['id', 'subject', 'from', 'to', 'receivedAt', 'preview', 'hasAttachment']
        }, 'emails']
      ]
    };

    const response = await this.makeRequest(request);
    return response.methodResponses[1][1].list;
  }

  async getRecentEmails(limit: number = 10, mailboxName: string = 'inbox'): Promise<any[]> {
    const session = await this.getSession();

    const mailboxes = await this.getMailboxes();
    const targetMailbox = mailboxes.find(mb =>
      mb.role === mailboxName.toLowerCase() ||
      mb.name.toLowerCase().includes(mailboxName.toLowerCase())
    );

    if (!targetMailbox) {
      throw new Error(`Could not find mailbox: ${mailboxName}`);
    }

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/query', {
          accountId: session.accountId,
          filter: { inMailbox: targetMailbox.id },
          sort: [{ property: 'receivedAt', isAscending: false }],
          limit: Math.min(limit, 50)
        }, 'query'],
        ['Email/get', {
          accountId: session.accountId,
          '#ids': { resultOf: 'query', name: 'Email/query', path: '/ids' },
          properties: ['id', 'subject', 'from', 'to', 'receivedAt', 'preview', 'hasAttachment', 'keywords']
        }, 'emails']
      ]
    };

    const response = await this.makeRequest(request);
    return response.methodResponses[1][1].list;
  }

  async markEmailRead(emailId: string, read: boolean = true): Promise<void> {
    const session = await this.getSession();

    const keywords = read ? { $seen: true } : {};

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/set', {
          accountId: session.accountId,
          update: {
            [emailId]: {
              keywords
            }
          }
        }, 'updateEmail']
      ]
    };

    const response = await this.makeRequest(request);
    const result = response.methodResponses[0][1];

    if (result.notUpdated && result.notUpdated[emailId]) {
      throw new Error(`Failed to mark email as ${read ? 'read' : 'unread'}.`);
    }
  }

  async flagEmail(emailId: string, flagged: boolean = true): Promise<void> {
    const session = await this.getSession();

    // Use JMAP PatchObject path syntax to update keyword without fetching first
    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/set', {
          accountId: session.accountId,
          update: {
            [emailId]: {
              ['keywords/$flagged']: flagged ? true : null
            }
          }
        }, 'flagEmail']
      ]
    };

    const response = await this.makeRequest(request);
    const result = response.methodResponses[0][1];

    if (result.notUpdated && result.notUpdated[emailId]) {
      const error = result.notUpdated[emailId];
      if (error.type === 'notFound') {
        throw new Error(`Email with ID '${emailId}' not found`);
      }
      throw new Error(`Failed to ${flagged ? 'flag' : 'unflag'} email: ${error.description || error.type}`);
    }
  }

  async bulkFlag(emailIds: string[], flagged: boolean = true): Promise<{ processed: number; failed: Array<{ id: string; error: string }> }> {
    const session = await this.getSession();

    // Use JMAP PatchObject path syntax to update keywords in single request
    const updates: Record<string, any> = {};
    emailIds.forEach(id => {
      updates[id] = { ['keywords/$flagged']: flagged ? true : null };
    });

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/set', {
          accountId: session.accountId,
          update: updates
        }, 'bulkFlag']
      ]
    };

    const response = await this.makeRequest(request);
    const result = response.methodResponses[0][1];

    // Extract all failures from notUpdated response
    const failed: Array<{ id: string; error: string }> = [];
    if (result.notUpdated) {
      for (const [id, error] of Object.entries(result.notUpdated as Record<string, any>)) {
        failed.push({ id, error: error.type || 'unknown' });
      }
    }

    const processedCount = emailIds.length - failed.length;
    return { processed: processedCount, failed };
  }

  async deleteEmail(emailId: string): Promise<void> {
    const session = await this.getSession();

    const mailboxes = await this.getMailboxes();
    const trashMailbox = mailboxes.find(mb => mb.role === 'trash') || mailboxes.find(mb => mb.name.toLowerCase().includes('trash'));

    if (!trashMailbox) {
      throw new Error('Could not find Trash mailbox');
    }

    const trashMailboxIds: Record<string, boolean> = {};
    trashMailboxIds[trashMailbox.id] = true;

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/set', {
          accountId: session.accountId,
          update: {
            [emailId]: {
              mailboxIds: trashMailboxIds
            }
          }
        }, 'moveToTrash']
      ]
    };

    const response = await this.makeRequest(request);
    const result = response.methodResponses[0][1];

    if (result.notUpdated && result.notUpdated[emailId]) {
      throw new Error('Failed to delete email.');
    }
  }

  async moveEmail(emailId: string, targetMailboxId: string): Promise<void> {
    const session = await this.getSession();

    const targetMailboxIds: Record<string, boolean> = {};
    targetMailboxIds[targetMailboxId] = true;

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/set', {
          accountId: session.accountId,
          update: {
            [emailId]: {
              mailboxIds: targetMailboxIds
            }
          }
        }, 'moveEmail']
      ]
    };

    const response = await this.makeRequest(request);
    const result = response.methodResponses[0][1];

    if (result.notUpdated && result.notUpdated[emailId]) {
      throw new Error('Failed to move email.');
    }
  }

  async getEmailAttachments(emailId: string): Promise<any[]> {
    const session = await this.getSession();

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/get', {
          accountId: session.accountId,
          ids: [emailId],
          properties: ['attachments']
        }, 'getAttachments']
      ]
    };

    const response = await this.makeRequest(request);
    const email = response.methodResponses[0][1].list[0];
    return email?.attachments || [];
  }

  async downloadAttachment(emailId: string, attachmentId: string): Promise<string> {
    const session = await this.getSession();

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/get', {
          accountId: session.accountId,
          ids: [emailId],
          properties: ['attachments', 'bodyValues'],
          bodyProperties: ['partId', 'blobId', 'size', 'name', 'type']
        }, 'getEmail']
      ]
    };

    const response = await this.makeRequest(request);
    const email = response.methodResponses[0][1].list[0];

    if (!email) {
      throw new Error('Email not found');
    }

    let attachment = email.attachments?.find((att: any) =>
      att.partId === attachmentId || att.blobId === attachmentId
    );

    if (!attachment && !isNaN(parseInt(attachmentId))) {
      const index = parseInt(attachmentId);
      attachment = email.attachments?.[index];
    }

    if (!attachment) {
      throw new Error('Attachment not found.');
    }

    const downloadUrl = session.downloadUrl;
    if (!downloadUrl) {
      throw new Error('Download capability not available in session');
    }

    const url = downloadUrl
      .replace('{accountId}', session.accountId)
      .replace('{blobId}', attachment.blobId)
      .replace('{type}', encodeURIComponent(attachment.type || 'application/octet-stream'))
      .replace('{name}', encodeURIComponent(attachment.name || 'attachment'));

    return url;
  }

  async getAttachmentMetadata(emailId: string, attachmentId: string): Promise<AttachmentMetadata> {
    const session = await this.getSession();

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/get', {
          accountId: session.accountId,
          ids: [emailId],
          properties: ['attachments'],
          bodyProperties: ['partId', 'blobId', 'size', 'name', 'type']
        }, 'getEmail']
      ]
    };

    const response = await this.makeRequest(request);
    const result = response.methodResponses[0][1];

    if (result.notFound && result.notFound.includes(emailId)) {
      throw new Error(`Email with ID '${emailId}' not found`);
    }

    const email = result.list[0];
    if (!email) {
      throw new Error(`Email with ID '${emailId}' not found or not accessible`);
    }

    let attachment = email.attachments?.find((att: any) =>
      att.partId === attachmentId || att.blobId === attachmentId
    );

    if (!attachment && !isNaN(parseInt(attachmentId))) {
      const index = parseInt(attachmentId);
      attachment = email.attachments?.[index];
    }

    if (!attachment) {
      throw new Error(`Attachment '${attachmentId}' not found in email. Use get_email_attachments to see available attachments.`);
    }

    const downloadUrlTemplate = session.downloadUrl;
    if (!downloadUrlTemplate) {
      throw new Error('Download capability not available in session');
    }

    const downloadUrl = downloadUrlTemplate
      .replace('{accountId}', session.accountId)
      .replace('{blobId}', attachment.blobId)
      .replace('{type}', encodeURIComponent(attachment.type || 'application/octet-stream'))
      .replace('{name}', encodeURIComponent(attachment.name || 'attachment'));

    return {
      filename: attachment.name || 'attachment',
      mimeType: attachment.type || 'application/octet-stream',
      size: attachment.size,
      blobId: attachment.blobId,
      downloadUrl
    };
  }

  async fetchAttachmentContent(emailId: string, attachmentId: string): Promise<AttachmentContent> {
    const session = await this.getSession();

    // First, get the email with attachment metadata
    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/get', {
          accountId: session.accountId,
          ids: [emailId],
          properties: ['attachments'],
          bodyProperties: ['partId', 'blobId', 'size', 'name', 'type']
        }, 'getEmail']
      ]
    };

    const response = await this.makeRequest(request);
    const result = response.methodResponses[0][1];

    if (result.notFound && result.notFound.includes(emailId)) {
      throw new Error(`Email with ID '${emailId}' not found`);
    }

    const email = result.list[0];
    if (!email) {
      throw new Error(`Email with ID '${emailId}' not found or not accessible`);
    }

    // Find the attachment by partId, blobId, or index
    let attachment = email.attachments?.find((att: any) =>
      att.partId === attachmentId || att.blobId === attachmentId
    );

    if (!attachment && !isNaN(parseInt(attachmentId))) {
      const index = parseInt(attachmentId);
      attachment = email.attachments?.[index];
    }

    if (!attachment) {
      throw new Error(`Attachment '${attachmentId}' not found in email. Use get_email_attachments to see available attachments.`);
    }

    // Check size limit
    if (attachment.size > MAX_ATTACHMENT_SIZE) {
      throw new Error(
        `Attachment is too large (${Math.round(attachment.size / 1024 / 1024)}MB). ` +
        `Maximum size is ${MAX_ATTACHMENT_SIZE / 1024 / 1024}MB. ` +
        `Use urlOnly=true to get the download URL instead.`
      );
    }

    // Build the download URL from session template
    const downloadUrl = session.downloadUrl;
    if (!downloadUrl) {
      throw new Error('Download capability not available in session');
    }

    const url = downloadUrl
      .replace('{accountId}', session.accountId)
      .replace('{blobId}', attachment.blobId)
      .replace('{type}', encodeURIComponent(attachment.type || 'application/octet-stream'))
      .replace('{name}', encodeURIComponent(attachment.name || 'attachment'));

    // Fetch the actual blob content using the same auth token
    const blobResponse = await fetch(url, {
      method: 'GET',
      headers: this.auth.getAuthHeaders()
    });

    if (!blobResponse.ok) {
      throw new Error(`Failed to download attachment: HTTP ${blobResponse.status} ${blobResponse.statusText}`);
    }

    // Convert to base64
    const arrayBuffer = await blobResponse.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    // Convert to base64 using btoa with binary string
    let binaryString = '';
    for (let i = 0; i < uint8Array.length; i++) {
      binaryString += String.fromCharCode(uint8Array[i]);
    }
    const base64Content = btoa(binaryString);

    return {
      filename: attachment.name || 'attachment',
      mimeType: attachment.type || 'application/octet-stream',
      size: attachment.size,
      blobId: attachment.blobId,
      content: base64Content
    };
  }

  async advancedSearch(filters: {
    query?: string;
    from?: string;
    to?: string;
    subject?: string;
    hasAttachment?: boolean;
    isUnread?: boolean;
    mailboxId?: string;
    after?: string;
    before?: string;
    limit?: number;
  }): Promise<any[]> {
    const session = await this.getSession();

    const filter: any = {};

    if (filters.query) filter.text = filters.query;
    if (filters.from) filter.from = filters.from;
    if (filters.to) filter.to = filters.to;
    if (filters.subject) filter.subject = filters.subject;
    if (filters.hasAttachment !== undefined) filter.hasAttachment = filters.hasAttachment;
    if (filters.isUnread !== undefined) filter.hasKeyword = filters.isUnread ? undefined : '$seen';
    if (filters.mailboxId) filter.inMailbox = filters.mailboxId;
    if (filters.after) filter.after = filters.after;
    if (filters.before) filter.before = filters.before;

    if (filters.isUnread === true) {
      filter.notKeyword = '$seen';
      delete filter.hasKeyword;
    }

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/query', {
          accountId: session.accountId,
          filter,
          sort: [{ property: 'receivedAt', isAscending: false }],
          limit: Math.min(filters.limit || 50, 100)
        }, 'query'],
        ['Email/get', {
          accountId: session.accountId,
          '#ids': { resultOf: 'query', name: 'Email/query', path: '/ids' },
          properties: ['id', 'subject', 'from', 'to', 'cc', 'receivedAt', 'preview', 'hasAttachment', 'keywords', 'threadId']
        }, 'emails']
      ]
    };

    const response = await this.makeRequest(request);
    return response.methodResponses[1][1].list;
  }

  async getThread(threadId: string): Promise<any[]> {
    const session = await this.getSession();

    let actualThreadId = threadId;

    try {
      const emailRequest: JmapRequest = {
        using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
        methodCalls: [
          ['Email/get', {
            accountId: session.accountId,
            ids: [threadId],
            properties: ['threadId']
          }, 'checkEmail']
        ]
      };

      const emailResponse = await this.makeRequest(emailRequest);
      const email = emailResponse.methodResponses[0][1].list[0];

      if (email && email.threadId) {
        actualThreadId = email.threadId;
      }
    } catch (error) {
      // If email lookup fails, assume threadId is correct
    }

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Thread/get', {
          accountId: session.accountId,
          ids: [actualThreadId]
        }, 'getThread'],
        ['Email/get', {
          accountId: session.accountId,
          '#ids': { resultOf: 'getThread', name: 'Thread/get', path: '/list/*/emailIds' },
          properties: ['id', 'subject', 'from', 'to', 'cc', 'receivedAt', 'preview', 'hasAttachment', 'keywords', 'threadId']
        }, 'emails']
      ]
    };

    const response = await this.makeRequest(request);
    const threadResult = response.methodResponses[0][1];

    if (threadResult.notFound && threadResult.notFound.includes(actualThreadId)) {
      throw new Error(`Thread with ID '${actualThreadId}' not found`);
    }

    return response.methodResponses[1][1].list;
  }

  async getMailboxStats(mailboxId?: string): Promise<any> {
    const session = await this.getSession();

    if (mailboxId) {
      const request: JmapRequest = {
        using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
        methodCalls: [
          ['Mailbox/get', {
            accountId: session.accountId,
            ids: [mailboxId],
            properties: ['id', 'name', 'role', 'totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads']
          }, 'mailbox']
        ]
      };

      const response = await this.makeRequest(request);
      return response.methodResponses[0][1].list[0];
    } else {
      const mailboxes = await this.getMailboxes();
      return mailboxes.map(mb => ({
        id: mb.id,
        name: mb.name,
        role: mb.role,
        totalEmails: mb.totalEmails || 0,
        unreadEmails: mb.unreadEmails || 0,
        totalThreads: mb.totalThreads || 0,
        unreadThreads: mb.unreadThreads || 0
      }));
    }
  }

  async getAccountSummary(): Promise<any> {
    const session = await this.getSession();
    const mailboxes = await this.getMailboxes();
    const identities = await this.getIdentities();

    const totals = mailboxes.reduce((acc, mb) => ({
      totalEmails: acc.totalEmails + (mb.totalEmails || 0),
      unreadEmails: acc.unreadEmails + (mb.unreadEmails || 0),
      totalThreads: acc.totalThreads + (mb.totalThreads || 0),
      unreadThreads: acc.unreadThreads + (mb.unreadThreads || 0)
    }), { totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0 });

    return {
      accountId: session.accountId,
      mailboxCount: mailboxes.length,
      identityCount: identities.length,
      ...totals,
      mailboxes: mailboxes.map(mb => ({
        id: mb.id,
        name: mb.name,
        role: mb.role,
        totalEmails: mb.totalEmails || 0,
        unreadEmails: mb.unreadEmails || 0
      }))
    };
  }

  async bulkMarkRead(emailIds: string[], read: boolean = true): Promise<void> {
    const session = await this.getSession();

    const keywords = read ? { $seen: true } : {};
    const updates: Record<string, any> = {};

    emailIds.forEach(id => {
      updates[id] = { keywords };
    });

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/set', {
          accountId: session.accountId,
          update: updates
        }, 'bulkUpdate']
      ]
    };

    const response = await this.makeRequest(request);
    const result = response.methodResponses[0][1];

    if (result.notUpdated && Object.keys(result.notUpdated).length > 0) {
      throw new Error('Failed to update some emails.');
    }
  }

  async bulkMove(emailIds: string[], targetMailboxId: string): Promise<void> {
    const session = await this.getSession();

    const targetMailboxIds: Record<string, boolean> = {};
    targetMailboxIds[targetMailboxId] = true;

    const updates: Record<string, any> = {};
    emailIds.forEach(id => {
      updates[id] = { mailboxIds: targetMailboxIds };
    });

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/set', {
          accountId: session.accountId,
          update: updates
        }, 'bulkMove']
      ]
    };

    const response = await this.makeRequest(request);
    const result = response.methodResponses[0][1];

    if (result.notUpdated && Object.keys(result.notUpdated).length > 0) {
      throw new Error('Failed to move some emails.');
    }
  }

  async bulkDelete(emailIds: string[]): Promise<void> {
    const session = await this.getSession();

    const mailboxes = await this.getMailboxes();
    const trashMailbox = mailboxes.find(mb => mb.role === 'trash') || mailboxes.find(mb => mb.name.toLowerCase().includes('trash'));

    if (!trashMailbox) {
      throw new Error('Could not find Trash mailbox');
    }

    const trashMailboxIds: Record<string, boolean> = {};
    trashMailboxIds[trashMailbox.id] = true;

    const updates: Record<string, any> = {};
    emailIds.forEach(id => {
      updates[id] = { mailboxIds: trashMailboxIds };
    });

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/set', {
          accountId: session.accountId,
          update: updates
        }, 'bulkDelete']
      ]
    };

    const response = await this.makeRequest(request);
    const result = response.methodResponses[0][1];

    if (result.notUpdated && Object.keys(result.notUpdated).length > 0) {
      throw new Error('Failed to delete some emails.');
    }
  }
}
