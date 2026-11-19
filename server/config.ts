export interface ServerConfig {
  port: number;
  publicDir: string;
  allowedHosts: Set<string>;
  bodyLimitBytes: number;
  brevoApiKey?: string;
  defaultSenderEmail?: string;
  backupStatusDir?: string;
  converterUrl: string;
  desktopMode?: boolean;
  desktopToken?: string;
}

export function loadConfig(): ServerConfig {
  const port = Number(process.env.PORT ?? 3000);
  const desktopMode=process.env.NDA_DESKTOP==='1';
  if(desktopMode&&!/^[a-f0-9]{64}$/.test(process.env.NDA_DESKTOP_TOKEN??''))throw new Error('A valid desktop session token is required.');
  if (!Number.isSafeInteger(port) || port < (desktopMode?0:1) || port > 65_535) throw new Error('PORT must be a valid TCP port.');
  const publishedPort = process.env.NDA_PORT ?? '5183';
  const defaults = [`127.0.0.1:${publishedPort}`, `localhost:${publishedPort}`, '127.0.0.1:3000', 'localhost:3000'];
  const configured = process.env.NDA_ALLOWED_HOSTS?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
  return {
    port,
    publicDir: process.env.PUBLIC_DIR ?? 'dist/public',
    allowedHosts: new Set([...defaults, ...configured].map((item) => item.toLowerCase())),
    bodyLimitBytes: 10 * 1024 * 1024,
    brevoApiKey: process.env.BREVO_API_KEY?.trim() || undefined,
    defaultSenderEmail: process.env.BREVO_SENDER_EMAIL?.trim() || undefined,
    backupStatusDir: process.env.NDA_BACKUP_DIR?.trim() || 'backups/automatic',
    converterUrl: process.env.NDA_CONVERTER_URL?.trim() || 'http://converter:3000',
    desktopMode,
    desktopToken:desktopMode?process.env.NDA_DESKTOP_TOKEN:undefined,
  };
}
