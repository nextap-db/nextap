import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { safeHttpUrl, socialUrl, messagingUrl, normalizePhone } = await import(pathToFileURL(join(root, 'public', 'profile-links.js')).href);

test('safe web URLs retain complete paths, URI delimiters, query strings and fragments', () => {
  for (const value of [
    'https://example.test/profile;details?one=1,two=2&message=Hello%20there#about',
    'http://example.test:8080/path?q=a%2Fb#details'
  ]) assert.equal(safeHttpUrl(value), value);
  assert.equal(safeHttpUrl('  https://example.test/profile?q=1#part  '), 'https://example.test/profile?q=1#part');
});

test('bare domains and protocol-relative web URLs receive HTTPS without duplicating the host', () => {
  assert.equal(safeHttpUrl('example.test/profile?q=1#part'), 'https://example.test/profile?q=1#part');
  assert.equal(safeHttpUrl('//example.test/profile?q=1#part'), 'https://example.test/profile?q=1#part');
  assert.equal(safeHttpUrl('www.example.test/profile'), 'https://www.example.test/profile');
});

test('unsafe schemes, credentials, control characters and malformed web inputs are rejected', () => {
  for (const value of [
    '', null, undefined, 'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd', 'ftp://example.test/file', 'mailto:fictional@example.test',
    'https://user:password@example.test/profile', 'https://example.test\\evil',
    'https://example.test/\r\nInjected: value', 'https://example.test/\u0000bad',
    'https://', 'not a web address', '/relative-only'
  ]) assert.equal(safeHttpUrl(value), '', String(value));
});

test('Philippine local and international phone representations normalize to the same dialing number', () => {
  for (const value of ['09171234567', '0917 123 4567', '(0917) 123-4567', '9171234567', '+63 917 123 4567', '639171234567', '00639171234567']) {
    assert.equal(normalizePhone(value), '+639171234567', value);
  }
});

test('international plus and 00 prefixes remain international rather than acquiring a Philippine prefix', () => {
  for (const value of ['+1 (415) 555-2671', '0014155552671', '14155552671']) {
    assert.equal(normalizePhone(value), '+14155552671', value);
  }
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
});

test('phones do not extract digits from URLs, text, extensions or invalid plus signs', () => {
  for (const value of [
    '', null, 'https://wa.me/639171234567?text=2', '0917ABC4567', '09171234567 ext 2',
    '63+9171234567', '++639171234567', '+0000000000', '123456', '1'.repeat(16), '00000000000'
  ]) assert.equal(normalizePhone(value), '', String(value));
});

test('supported social handles receive their correct platform path', () => {
  const handles = [
    ['instagram', 'fictional.name', 'https://instagram.com/fictional.name'],
    ['facebook', 'fictional.name', 'https://facebook.com/fictional.name'],
    ['linkedin', 'fictional-name', 'https://linkedin.com/in/fictional-name'],
    ['tiktok', 'fictional_name', 'https://tiktok.com/@fictional_name'],
    ['youtube', 'fictional_name', 'https://youtube.com/@fictional_name'],
    ['x', 'fictional_name', 'https://x.com/fictional_name'],
    ['twitter', 'fictional_name', 'https://x.com/fictional_name'],
    ['threads', 'fictional.name', 'https://threads.com/@fictional.name'],
    ['github', 'fictional-name', 'https://github.com/fictional-name'],
    ['behance', 'fictional-name', 'https://behance.net/fictional-name'],
    ['dribbble', 'fictional-name', 'https://dribbble.com/fictional-name'],
    ['twitch', 'fictional_name', 'https://twitch.tv/fictional_name']
  ];
  for (const [type, handle, expected] of handles) {
    assert.equal(socialUrl(handle, type), expected, type);
    assert.equal(socialUrl('@' + handle, type), expected, type + ' @handle');
  }
});

test('saved full and bare platform URLs keep their original profile and query instead of repeating the host', () => {
  const links = [
    ['facebook', 'facebook.com/fictional.profile?sk=about#intro'],
    ['instagram', 'www.instagram.com/fictional.name/'],
    ['linkedin', 'linkedin.com/company/fictional-company'],
    ['youtube', 'youtube.com/channel/UCfictional?view=1'],
    ['telegram', 't.me/fictional_contact'],
    ['messenger', 'm.me/fictional.contact'],
    ['steam', 'steamcommunity.com/profiles/76561198000000001'],
    ['threads', 'threads.net/@fictional.name']
  ];
  for (const [type, value] of links) {
    assert.equal(socialUrl(value, type), 'https://' + value, type);
    assert.equal(socialUrl('https://' + value, type), 'https://' + value, type + ' full');
  }
});

test('LinkedIn and YouTube platform-relative paths retain their intended page type', () => {
  assert.equal(socialUrl('company/fictional-company', 'linkedin'), 'https://linkedin.com/company/fictional-company');
  assert.equal(socialUrl('in/fictional-person', 'linkedin'), 'https://linkedin.com/in/fictional-person');
  for (const path of ['channel/UCfictional', 'c/FictionalChannel', 'user/FictionalChannel', 'watch?v=fictional', 'shorts/fictional']) {
    assert.equal(socialUrl(path, 'youtube'), 'https://youtube.com/' + path, path);
  }
});

test('Steam distinguishes vanity names, SteamID64 values and already-qualified profile paths', () => {
  assert.equal(socialUrl('fictional_player', 'steam'), 'https://steamcommunity.com/id/fictional_player');
  assert.equal(socialUrl('76561198000000001', 'steam'), 'https://steamcommunity.com/profiles/76561198000000001');
  assert.equal(socialUrl('id/fictional_player', 'steam'), 'https://steamcommunity.com/id/fictional_player');
  assert.equal(socialUrl('profiles/76561198000000001', 'steam'), 'https://steamcommunity.com/profiles/76561198000000001');
});

test('social links reject dangerous protocols and control characters rather than presenting clickable text', () => {
  for (const type of ['facebook', 'instagram', 'linkedin', 'steam', 'telegram', 'messenger']) {
    for (const value of ['javascript:alert(1)', 'data:text/html,unsafe', 'https://user:password@example.test/', 'fictional\r\nInjected']) {
      assert.equal(socialUrl(value, type), '', type + ': ' + value);
    }
  }
});

test('WhatsApp phone links normalize Philippine and international dialing without query-digit contamination', () => {
  for (const phone of ['09171234567', '9171234567', '+639171234567']) {
    assert.equal(messagingUrl(phone, 'whatsapp'), 'https://wa.me/639171234567');
  }
  for (const phone of ['+1 (415) 555-2671', '0014155552671']) {
    assert.equal(messagingUrl(phone, 'whatsapp'), 'https://wa.me/14155552671');
  }
});

test('official saved WhatsApp URLs preserve their path and encoded message query', () => {
  for (const value of [
    'https://wa.me/639171234567?text=Hello%20Fictional%202',
    'https://api.whatsapp.com/send?phone=639171234567&text=Hello%202',
    'https://chat.whatsapp.com/FictionalInvite'
  ]) assert.equal(messagingUrl(value, 'whatsapp'), value);
  assert.equal(messagingUrl('wa.me/639171234567?text=Hello%202', 'whatsapp'), 'https://wa.me/639171234567?text=Hello%202');
  for (const value of ['https://evil.example.test/639171234567', 'https://wa.me.evil.example.test/639171234567', '0917ABC4567', 'javascript:alert(1)']) {
    assert.equal(messagingUrl(value, 'whatsapp'), '', value);
  }
});

test('Viber preserves a validated existing app link and encodes the international plus sign exactly once', () => {
  assert.equal(messagingUrl('09171234567', 'viber'), 'viber://chat?number=%2B639171234567');
  assert.equal(messagingUrl('+1 (415) 555-2671', 'viber'), 'viber://chat?number=%2B14155552671');
  assert.equal(messagingUrl('viber://chat?number=%2B639171234567', 'viber'), 'viber://chat?number=%2B639171234567');
  for (const value of ['javascript:alert(1)', 'viber://chat?number=bad', 'https://evil.example.test/profile', '0917ABC4567']) {
    assert.equal(messagingUrl(value, 'viber'), '', value);
  }
});

test('Messenger and Telegram links accept either a handle or an existing official web profile', () => {
  assert.equal(messagingUrl('@fictional.contact', 'messenger'), 'https://m.me/fictional.contact');
  assert.equal(messagingUrl('https://m.me/fictional.contact?ref=card', 'messenger'), 'https://m.me/fictional.contact?ref=card');
  assert.equal(messagingUrl('@fictional_contact', 'telegram'), 'https://t.me/fictional_contact');
  assert.equal(messagingUrl('t.me/fictional_contact', 'telegram'), 'https://t.me/fictional_contact');
});

const profileSource = await readFile(join(root, 'public', 'profile.html'), 'utf8');
function sourceBetween(start, end) {
  const from = profileSource.indexOf(start);
  const to = profileSource.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Actual public link source missing: ${start}`);
  return profileSource.slice(from, to);
}

class Element {
  constructor() {
    this.children = []; this.attributes = {}; this.listeners = {}; this.textContent = ''; this.hidden = false;
    this.classes = new Set();
    this.classList = {
      add: name => this.classes.add(name), remove: name => this.classes.delete(name),
      toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name)
    };
  }
  appendChild(child) { this.children.push(child); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  querySelector(selector) { return (this.parts ||= {})[selector] ||= new Element(); }
}

function browserLinks(navigator = {}, record = {}) {
  const ids = new Map();
  const get = id => { if (!ids.has(id)) ids.set(id, new Element()); return ids.get(id); };
  const contacts = get('contacts'), socials = get('socials'), contactBtn = get('contactBtn'), messageBtn = get('messageBtn');
  const visits = [];
  const context = vm.createContext({
    safeHttpUrl, socialUrl, messagingUrl, normalizePhone, navigator, contacts, socials, contactBtn, messageBtn,
    client: record, d: record, shareToast: get('shareToast'), $: get,
    location: { assign(href) { visits.push(href); } },
    document: { createElement() { return new Element(); } },
    // The real helpers decide attributes and text. Fixed artwork is outside
    // this test's scope, so no SVG/HTML parser is needed for its icon template.
    svg: () => '<svg></svg>', socialIcon: () => '<span class="fixed-icon"></span>', url: safeHttpUrl
  });
  const mobileFunction = profileSource.match(/^function isMobileProfile\([^\n]+/m)?.[0];
  const targetFunction = profileSource.match(/^function outboundTarget\([^\n]+/m)?.[0];
  assert.ok(mobileFunction && targetFunction, 'The actual target helpers must be present');
  const targetSource = mobileFunction + '\n' + targetFunction;
  vm.runInContext(targetSource + '\n' +
    sourceBetween('function addContact(', 'function socialIcon(') + '\n' +
    sourceBetween('function addSocial(', 'function updateSocialCarousel(') + '\n' +
    sourceBetween('/* === NEXtap ACTIONS FUNCTIONALITY RESTORE === */', '/* === NEXtap LONG NAME FIT'), context);
  const mapping = sourceBetween('   contacts.innerHTML="";socials.innerHTML="";', '   socials.classList.toggle("is-empty"');
  return { context, contacts, socials, visits, get, render: () => vm.runInContext('{' + mapping + '}', context) };
}

const fictionalRecord = {
  id: 'fictional-id', slug: 'fictional-profile', phone: '0917 123 4567', email: 'fictional+card@example.test',
  whatsapp: 'https://wa.me/639171234567?text=Hello%202', viber: '+1 (415) 555-2671',
  messenger: 'm.me/fictional.contact', telegram: '@fictional_contact',
  facebook: 'facebook.com/fictional.profile', website: 'example.test/path?one=1#details', steam: '76561198000000001'
};

test('actual profile contact mapping uses normalized phone, email and messaging URLs while rendering labels as text', () => {
  const page = browserLinks({ userAgent: 'Windows desktop' }, { ...fictionalRecord });
  page.render();
  const hrefs = page.contacts.children.map(anchor => anchor.href);
  assert.deepEqual(hrefs, [
    'tel:+639171234567', 'mailto:fictional%2Bcard%40example.test', 'https://m.me/fictional.contact',
    'https://wa.me/639171234567?text=Hello%202', 'viber://chat?number=%2B14155552671', 'https://t.me/fictional_contact'
  ]);
  assert.equal(page.contacts.children[0].querySelector('.sub').textContent, fictionalRecord.phone);
  assert.equal(page.contacts.children[1].querySelector('.sub').textContent, fictionalRecord.email);
  assert.deepEqual(page.socials.children.map(anchor => anchor.href), [
    'https://facebook.com/fictional.profile', 'https://example.test/path?one=1#details', 'https://steamcommunity.com/profiles/76561198000000001'
  ]);
  assert.equal(page.socials.children[0].attributes['aria-label'], 'Facebook');
});

test('actual mobile anchors stay in the current tab, including Android, iPhone and touch iPad desktop mode', () => {
  for (const navigator of [
    { userAgentData: { mobile: true } }, { userAgent: 'Mozilla Android' }, { userAgent: 'Mozilla iPhone' },
    { userAgent: 'Mozilla Macintosh', platform: 'MacIntel', maxTouchPoints: 5 }
  ]) {
    const page = browserLinks(navigator, { ...fictionalRecord });
    page.render();
    for (const anchor of [...page.contacts.children, ...page.socials.children]) {
      assert.equal(anchor.target, '_self', anchor.href);
      assert.equal(anchor.rel, 'noopener', anchor.href);
    }
  }
});

test('actual desktop anchors open web destinations safely while telephone, email and app schemes stay in the current tab', () => {
  const page = browserLinks({ userAgent: 'Mozilla Windows', platform: 'Win32', maxTouchPoints: 0 }, { ...fictionalRecord });
  page.render();
  for (const anchor of [...page.contacts.children, ...page.socials.children]) {
    assert.equal(anchor.target, anchor.href.startsWith('http') ? '_blank' : '_self', anchor.href);
    assert.equal(anchor.rel, 'noopener', anchor.href);
  }
  const downloadViber = page.get('viberHelp').querySelector('a');
  // The existing fallback is a real official web destination, never a guessed
  // personal viber.me URL or a fabricated successful-chat message.
  assert.match(profileSource, /href="https:\/\/www\.viber\.com\/en\/download\/"/);
  assert.equal(downloadViber.rel, 'noopener');
});

test('malformed contact and social fields create no dead or unsafe buttons, and invalid phone disables messaging', () => {
  const page = browserLinks({}, {
    slug: 'fictional', phone: 'not a phone', email: 'not an email', whatsapp: 'https://evil.example.test/profile',
    viber: 'viber://chat?number=bad', telegram: 'javascript:alert(1)', messenger: 'data:text/html,bad',
    facebook: 'javascript:alert(1)', website: 'https://user:password@example.test/'
  });
  page.render();
  assert.equal(page.contacts.children.length, 0);
  assert.equal(page.socials.children.length, 0);
  assert.equal(page.get('messageBtn').disabled, true);
  assert.match(page.get('messageBtn').attributes['aria-label'], /unavailable/);
  page.get('messageBtn').onclick();
  assert.equal(page.context.location.href, undefined);
});

test('Viber app-link click exposes existing installation/import guidance without suppressing native navigation', () => {
  const page = browserLinks({ userAgent: 'iPhone' }, { ...fictionalRecord });
  page.render();
  const anchor = page.contacts.children.find(item => item.href.startsWith('viber:'));
  assert.ok(anchor);
  for (const handler of anchor.listeners.click) handler();
  assert.equal(page.get('contactImportHelp').open, true);
  assert.equal(page.get('viberHelp').hidden, false);
  assert.equal(anchor.target, '_self');
  assert.ok(profileSource.includes('Viber requires the Viber app'));
});

test('Save Contact navigates to the server vCard endpoint with a separate download fallback and truthful import guidance', () => {
  const page = browserLinks({ userAgent: 'iPhone' }, { ...fictionalRecord });
  page.render();
  assert.equal(page.get('contactDownload').href, '/api/clients/fictional-profile/contact.vcf?download=1');
  page.get('contactBtn').onclick();
  assert.deepEqual(page.visits, ['/api/clients/fictional-profile/contact.vcf']);
  assert.match(page.get('shareToast').textContent, /Opening contact card.*Confirm the import/i);
  assert.doesNotMatch(page.get('shareToast').textContent, /saved|imported|downloaded successfully/i);
  assert.match(profileSource, /<details id="contactImportHelp"[\s\S]*?<summary>Contact import help<\/summary>/);
  assert.ok(profileSource.includes('Import from file'));
  assert.doesNotMatch(sourceBetween('function contactCardHref(', '/* === NEXtap LONG NAME FIT'), /createObjectURL|new File|new Blob/);
});

test('contact endpoint handoff encodes profile keys, falls back to ID and ignores clicks without a loaded client', () => {
  const bySlug = browserLinks({}, { id: 'unused', slug: 'fictional /?#名' });
  bySlug.get('contactBtn').onclick();
  assert.deepEqual(bySlug.visits, ['/api/clients/' + encodeURIComponent('fictional /?#名') + '/contact.vcf']);
  const byId = browserLinks({}, { id: 'fictional-id' });
  byId.get('contactBtn').onclick();
  assert.deepEqual(byId.visits, ['/api/clients/fictional-id/contact.vcf']);
  const notLoaded = browserLinks({}, null);
  notLoaded.get('contactBtn').onclick();
  assert.deepEqual(notLoaded.visits, []);
});
