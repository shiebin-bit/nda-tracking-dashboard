export interface EmailStatus {
  configured: boolean;
  connected: boolean;
  transactionalEnabled: boolean;
  senders: { email: string; name: string; active: boolean }[];
  error: string | null;
  checkedAt: string;
  defaultSenderEmail: string | null;
}

export interface EmailDelivery {
  id: string;
  kind: 'test' | 'scheduled';
  localDate: string;
  status: 'sending' | 'submitted' | 'failed' | 'unknown' | 'skipped';
  recipientEmail: string;
  /** @deprecated Use ccEmails. */
  ccEmail: string;
  ccEmails?: string[];
  senderEmail: string;
  subject: string;
  htmlContent: string;
  recordCount: number;
  createdAt: string;
  updatedAt: string;
  messageId: string | null;
  error: string | null;
  attempts: number;
}

export interface ReminderTaskSummary {
  id: string;
  localDate: string;
  status: EmailDelivery['status'];
  recordCount: number;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

export interface ReminderSummary {
  enabled: boolean;
  recipientEmail: string;
  /** @deprecated Use ccEmails. */
  ccEmail: string;
  ccEmails?: string[];
  sendTime: string;
  timeZone: 'Asia/Kuala_Lumpur';
  serverTime: string;
  today: string;
  nextCheckAt: string | null;
  nextCheckState: 'paused' | 'scheduled' | 'awaiting_check';
  todayResult: ReminderTaskSummary | null;
  latestResult: ReminderTaskSummary | null;
}
