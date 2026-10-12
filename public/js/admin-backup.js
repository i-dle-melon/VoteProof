// Presentation allowlists only. Roles/MFA/CSRF/transactions are enforced by Worker.
export function backupText(copy) {
  const labels = Object.fromEntries(['pending','processing','confirmed','failed'].map(k=>[k,copy('backup-'+k)]));
  const errors = Object.fromEntries(['NETWORK','RATE_LIMIT','GOOGLE_UNAVAILABLE','OAUTH_REVOKED','OAUTH_CONFIG','CONFIG_MISSING','DRIVE_ACCESS_DENIED',
    'ROOT_INACCESSIBLE','DRIVE_FULL','SOURCE_MISSING','SOURCE_CHANGED','VERIFY_FAILED','UPLOAD_INCOMPLETE','INVALID_SOURCE','INTERNAL'].map(k=>[k,copy('backup-error-'+k)]));
  return { labels: Object.freeze(labels), errors: Object.freeze(errors) };
}
export const backupLink = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id) ? 'https://drive.google.com/file/d/' + id + '/view' : null;
