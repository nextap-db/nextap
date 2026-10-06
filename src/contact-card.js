import { safeHttpUrl, socialUrl, messagingUrl, normalizePhone } from '../public/profile-links.js';

const encoder = new TextEncoder();
const text = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  .replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');

function fold(line) {
  const parts = [];
  let current = '', bytes = 0;
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (bytes + size > 75) { parts.push(current); current = ' '; bytes = 1; }
    current += character; bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n');
}

export function contactFilename(client) {
  const name = String(client.slug || client.id || 'contact').replace(/[^a-z0-9_-]/gi, '_').slice(0, 80);
  return (name || 'contact') + '.vcf';
}

export function buildContactCard(client) {
  const name = String(client.name || 'Contact');
  const phone = normalizePhone(client.phone);
  const website = safeHttpUrl(client.website);
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', 'N:;' + text(name) + ';;;', 'FN:' + text(name)];
  if (client.company) lines.push('ORG:' + text(client.company));
  if (client.job_title) lines.push('TITLE:' + text(client.job_title));
  if (phone) lines.push('TEL;TYPE=CELL:' + phone);
  if (client.email) lines.push('EMAIL;TYPE=INTERNET:' + text(client.email));
  if (website) lines.push('URL:' + website);
  for (const key of ['instagram', 'facebook', 'linkedin', 'tiktok', 'youtube', 'x', 'telegram', 'threads', 'github', 'behance', 'dribbble', 'twitch', 'steam', 'whatsapp', 'messenger', 'viber']) {
    const value = client[key] || (key === 'x' ? client.twitter : '');
    const href = ['whatsapp', 'viber'].includes(key) ? messagingUrl(value, key) : socialUrl(value, key);
    if (href) lines.push('X-SOCIALPROFILE;TYPE=' + key + ':' + href);
  }
  lines.push('END:VCARD');
  return lines.map(fold).join('\r\n') + '\r\n';
}
