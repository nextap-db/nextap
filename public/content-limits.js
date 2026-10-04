// The Worker and both dashboards use the same published-section budget.
// Identity, contact/social links and the profile location line are outside it.
export const QUICK_BLOCKS = Object.freeze([
  'business_location', 'business_hours', 'services', 'portfolio', 'booking',
  'reviews', 'payments', 'education', 'skills', 'resume', 'achievements',
  'certifications', 'pricing', 'products', 'promotions', 'team', 'business_inquiry'
]);
export const SPECIAL_BLOCKS = Object.freeze([
  'media', 'games', 'streaming', 'discord', 'tournament_history',
  'gallery', 'interests', 'custom_links', 'collaborations'
]);

export function normalizePlan(value) {
  const key = String(value || '').trim().toLowerCase();
  return key === 'gold' || key === 'elite' ? 'elite' : key === 'premium' ? 'premium' : 'basic';
}

function objectValue(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function meaningful(value) {
  if (value == null || typeof value === 'boolean') return false;
  if (Array.isArray(value)) return value.some(meaningful);
  if (typeof value === 'object') return Object.values(value).some(meaningful);
  if (typeof value === 'number') return Number.isFinite(value);
  return String(value).trim().length > 0;
}

export function hasBlockContent(value) {
  const text = typeof value === 'string' ? value.trim() : value;
  if (!text && text !== 0) return false;
  if (typeof text === 'string' && /^[\[{]/.test(text)) {
    try { return meaningful(JSON.parse(text)); } catch { return meaningful(text); }
  }
  return meaningful(text);
}

const enabled = value => value !== false && value !== 0 && value !== '0';

function hasBusinessLocation(record) {
  let locations;
  try { locations = typeof record.business_locations === 'string' ? JSON.parse(record.business_locations) : record.business_locations; } catch {}
  if (Array.isArray(locations) && locations.length) return locations.some(item => hasBlockContent(item?.name) || hasBlockContent(item?.link));
  return hasBlockContent(record.business_location_name) || hasBlockContent(record.business_location_link);
}

export function contentUsage(record = {}) {
  const plan = normalizePlan(record.card_type);
  const label = { basic: 'Basic', premium: 'Premium', elite: 'Elite' }[plan];
  const limit = { basic: 3, premium: 6, elite: null }[plan];
  const keys = [];
  // A featured image/title/description or complete CTA renders one section.
  if (record.featured_enabled === true || Number(record.featured_enabled) === 1) {
    if (['featured_title', 'featured_description', 'featured_image'].some(key => hasBlockContent(record[key])) ||
        (hasBlockContent(record.featured_button_text) && hasBlockContent(record.featured_button_link))) keys.push('featured');
  }
  if (enabled(record.quick_info_enabled)) {
    const modules = objectValue(record.profile_modules);
    const visibility = objectValue(record.profile_module_visibility);
    for (const key of SPECIAL_BLOCKS) {
      if (visibility[key] !== false && hasBlockContent(modules[key])) keys.push(key);
    }
    for (const key of QUICK_BLOCKS) {
      if (!enabled(record['show_' + key])) continue;
      const present = key === 'business_location'
        ? hasBusinessLocation(record)
        : hasBlockContent(record[key]);
      if (present) keys.push(key);
    }
  }
  return { plan, label, limit, used: keys.length, keys,
    over_limit: limit !== null && keys.length > limit,
    remaining: limit === null ? null : Math.max(0, limit - keys.length) };
}

export function contentLimitViolation(candidate, previous) {
  const usage = contentUsage(candidate);
  if (!usage.over_limit) return null;
  const old = previous ? contentUsage(previous) : null;
  // Existing content stays live. The allowance shrinks as sections are removed;
  // it cannot be used to add another section or to downgrade an oversized plan.
  if (old?.plan === usage.plan && usage.keys.every(key => old.keys.includes(key))) return null;
  return { code: 'CONTENT_BLOCK_LIMIT', content_plan: usage,
    error: `${usage.label} allows ${usage.limit} published content blocks. This change would publish ${usage.used}. Ask your admin to hide a section or change your plan. Existing content is kept.` };
}
