export interface BackupStatus {
  enabled: true;
  schedule: {
    localTime: '02:00';
    timeZone: 'Asia/Kuala_Lumpur';
    retainSuccessful: 14;
  };
  state: 'never' | 'running' | 'succeeded' | 'failed' | 'unavailable';
  lastAttempt: null | {
    slotDate: string;
    status: 'running' | 'succeeded' | 'failed';
    startedAt: string;
    completedAt: string | null;
    error: string | null;
    warning: string | null;
  };
  lastSuccess: null | {
    slotDate: string;
    completedAt: string;
    fileName: string;
    sizeBytes: number;
    sha256: string;
  };
  nextAttemptAt: string | null;
  successfulBackupCount: number;
  statusUpdatedAt: string | null;
  observedAt: string;
}
