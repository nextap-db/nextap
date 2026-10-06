// Shared by the public profile and its contact card; this module has no DOM work.
export function safeHttpUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw || /[\u0000-\u001f\u007f\\]/.test(raw)) return '';
  let candidate = raw;
  if (raw.startsWith('//')) candidate = 'https:' + raw;
  else if (!/^https?:\/\//i.test(raw)) {
    if (!/^(?:[a-z\d-]+\.)+[a-z\d-]+(?::\d+)?(?:[/?#]|$)/i.test(raw)) return '';
    candidate = 'https://' + raw;
  }
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return '';
    return parsed.href;
  } catch { return ''; }
}

export function normalizePhone(value) {
  let raw = String(value ?? '').trim().replace(/^tel:/i, '');
  if (!raw || !/^[+\d\s().-]+$/.test(raw)) return '';
  raw = raw.replace(/[\s().-]/g, '');
  if (/^00\d+$/.test(raw)) raw = '+' + raw.slice(2);
  else if (/^09\d{9}$/.test(raw)) raw = '+63' + raw.slice(1);
  else if (/^0[2-8]\d{8}$/.test(raw)) raw = '+63' + raw.slice(1);
  else if (/^9\d{9}$/.test(raw)) raw = '+63' + raw;
  else if (/^[1-9]\d{6,14}$/.test(raw)) raw = '+' + raw;
  return /^\+[1-9]\d{6,14}$/.test(raw) ? raw : '';
}

const platforms = Object.freeze({
  instagram: ['https://instagram.com/', ['instagram.com']],
  facebook: ['https://facebook.com/', ['facebook.com', 'fb.com']],
  linkedin: ['https://linkedin.com/in/', ['linkedin.com']],
  tiktok: ['https://tiktok.com/@', ['tiktok.com']],
  youtube: ['https://youtube.com/@', ['youtube.com', 'youtu.be']],
  x: ['https://x.com/', ['x.com', 'twitter.com']],
  twitter: ['https://x.com/', ['x.com', 'twitter.com']],
  threads: ['https://threads.com/@', ['threads.com', 'threads.net']],
  messenger: ['https://m.me/', ['m.me', 'messenger.com', 'facebook.com']],
  telegram: ['https://t.me/', ['t.me', 'telegram.me']],
  github: ['https://github.com/', ['github.com']],
  behance: ['https://behance.net/', ['behance.net']],
  dribbble: ['https://dribbble.com/', ['dribbble.com']],
  twitch: ['https://twitch.tv/', ['twitch.tv']],
  steam: ['https://steamcommunity.com/id/', ['steamcommunity.com']]
});

function isHost(host, domains) {
  return domains.some(domain => host === domain || host.endsWith('.' + domain));
}

export function socialUrl(value, type) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const key = String(type || '').toLowerCase();
  if (key === 'whatsapp' || key === 'viber') return messagingUrl(raw, key);
  if (key === 'website') return safeHttpUrl(raw);
  if (/^(?:https?:\/\/|\/\/)/i.test(raw)) return safeHttpUrl(raw);
  const platform = platforms[key];
  if (!platform || /[\s\\\u0000-\u001f\u007f]/.test(raw) || /^[a-z][a-z\d+.-]*:/i.test(raw)) return '';
  const supplied = safeHttpUrl(raw);
  if (supplied && isHost(new URL(supplied).hostname.toLowerCase(), platform[1])) return supplied;
  const identifier = raw.replace(/^\/+/, '').replace(/^@/, '');
  if (!identifier || identifier.startsWith('?') || identifier.startsWith('#')) return '';
  let base = platform[0];
  if (key === 'linkedin' && /^(?:in|company|school|showcase|posts|pulse|feed|groups|events|learning)\//i.test(identifier)) base = 'https://linkedin.com/';
  if (key === 'youtube' && /^(?:channel|c|user|shorts|live|embed)\/|^(?:watch|playlist|results)\?/i.test(identifier)) base = 'https://youtube.com/';
  if (key === 'steam') {
    if (/^(?:id|profiles|groups|app|sharedfiles|workshop|tradeoffer)\//i.test(identifier)) base = 'https://steamcommunity.com/';
    else if (/^\d{17}$/.test(identifier)) base = 'https://steamcommunity.com/profiles/';
  }
  return safeHttpUrl(base + identifier);
}

export function messagingUrl(value, type) {
  const raw = String(value ?? '').trim();
  const key = String(type || '').toLowerCase();
  if (!raw) return '';
  if (key === 'messenger' || key === 'telegram') return socialUrl(raw, key);
  if (key === 'whatsapp') {
    const supplied = safeHttpUrl(raw);
    if (supplied && isHost(new URL(supplied).hostname.toLowerCase(), ['wa.me', 'whatsapp.com'])) return supplied;
    const phone = normalizePhone(raw);
    return phone ? 'https://wa.me/' + phone.slice(1) : '';
  }
  if (key === 'viber') {
    const supplied = safeHttpUrl(raw);
    if (supplied && isHost(new URL(supplied).hostname.toLowerCase(), ['viber.com', 'viber.me'])) return supplied;
    if (/^viber:\/\//i.test(raw) && !/[\u0000-\u001f\u007f\\]/.test(raw)) {
      try {
        const parsed = new URL(raw);
        if (parsed.hostname === 'chat') {
          const phone = normalizePhone(parsed.searchParams.get('number'));
          if (!phone || parsed.username || parsed.password) return '';
          parsed.searchParams.set('number', phone);
          return parsed.href;
        }
        if (parsed.hostname === 'pa' && parsed.searchParams.get('chatURI') && !parsed.username && !parsed.password) return parsed.href;
      } catch {}
      return '';
    }
    // Retain the existing personal-number app link. Browsers and installations
    // differ; do not substitute the Business-only viber.me service for a person.
    const phone = normalizePhone(raw);
    return phone ? 'viber://chat?number=' + encodeURIComponent(phone) : '';
  }
  return '';
}
