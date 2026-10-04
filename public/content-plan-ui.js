import * as limits from './content-limits.js';

// Both editors use the Worker's counting rules; the server also enforces saves.
window.NextapContentLimits = limits;
const byId = id => document.getElementById(id);

function summary(usage) {
  return usage.limit === null
    ? `${usage.label} · ${usage.used} published content blocks · Unlimited`
    : `${usage.label} · ${usage.used} of ${usage.limit} published content blocks`;
}

function updateUsage(element, record, previous, saved = false) {
  if (!element) return;
  const usage = limits.contentUsage(record);
  const violation = saved ? null : limits.contentLimitViolation(record, previous);
  element.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = `${saved ? 'Saved: ' : ''}${summary(usage)}`;
  element.appendChild(title);
  element.classList.toggle('nx-content-plan-over', usage.over_limit);
  let message = '';
  if (violation) message = violation.error;
  else if (usage.over_limit) message = 'Existing published blocks are kept. You can edit, remove or hide them. New blocks can be published once the total is within your allowance.';
  else if (usage.limit !== null && usage.remaining === 0) message = 'All content blocks are in use. Existing blocks and contact links can still be edited. Ask your admin to hide a section or change your plan to publish another block.';
  if (message) {
    const detail = document.createElement('span');
    detail.textContent = message;
    element.appendChild(detail);
  }
}

function adminPrevious() {
  const id = typeof editingId === 'undefined' ? null : editingId;
  return id ? (window.clients || []).find(record => record.id === id) : null;
}

function adminDraft() {
  const previous = adminPrevious();
  const record = { ...(previous || {}) };
  record.card_type = typeof legacyCardTypeForSave === 'undefined' ? 'gold' : legacyCardTypeForSave;
  for (const key of limits.QUICK_BLOCKS) {
    const field = byId(key);
    if (field) record[key] = field.value.trim();
    const toggle = byId(`show_${key}`);
    if (toggle) record[`show_${key}`] = toggle.checked;
  }
  // The structured editors serialize the same values used by Save Changes.
  const serializers = {
    services: typeof syncAdminServicesEditor === 'function' ? syncAdminServicesEditor : null,
    portfolio: typeof syncAdminPortfolioEditor === 'function' ? syncAdminPortfolioEditor : null,
    booking: typeof syncAdminBookingEditor === 'function' ? syncAdminBookingEditor : null,
    reviews: typeof syncAdminReviewsEditor === 'function' ? syncAdminReviewsEditor : null,
    business_hours: typeof serializeBusinessHours === 'function' ? serializeBusinessHours : null
  };
  for (const [key, serialize] of Object.entries(serializers)) {
    if (serialize) record[key] = serialize();
  }
  if (typeof adminSerializeContent === 'function') {
    for (const key of ['payments', 'education', 'skills', 'achievements', 'certifications', 'pricing', 'products', 'promotions', 'team']) {
      if (byId(key)) record[key] = adminSerializeContent(key, byId(key).value);
    }
  }
  if (typeof getBusinessLocationsAdmin === 'function') {
    const locations = getBusinessLocationsAdmin();
    record.business_locations = JSON.stringify(locations);
    record.business_location_name = locations[0]?.name || '';
    record.business_location_link = locations[0]?.link || '';
  }
  if (window.nxCollectAdminModules) record.profile_modules = window.nxCollectAdminModules();
  if (window.nxCollectAdminModuleVisibility) record.profile_module_visibility = window.nxCollectAdminModuleVisibility();
  if (byId('quick_info_enabled')) record.quick_info_enabled = byId('quick_info_enabled').checked;
  if (byId('featured_enabled')) record.featured_enabled = byId('featured_enabled').checked;
  for (const key of ['featured_title', 'featured_description', 'featured_button_text', 'featured_button_link']) {
    if (byId(key)) record[key] = byId(key).value.trim();
  }
  if (byId('featured_image_file')?.files?.length) record.featured_image = 'Selected image';
  return record;
}

function ensureAdminPlanUI() {
  const select = byId('nxContentPlanSelect');
  if (!select) return;
  if (!select.dataset.planBound) {
    select.dataset.planBound = 'true';
    select.addEventListener('change', () => {
      window.nxSetAdminCardTier?.(select.value);
      if (typeof setDirty === 'function') setDirty(true);
      refreshAdmin();
    });
  }
  if (!byId('nxAdminQuickPlanUsage')) {
    const card = byId('quickInfoCard');
    const help = card?.querySelector('p.hint');
    if (help) {
      const usage = document.createElement('div');
      usage.id = 'nxAdminQuickPlanUsage';
      usage.className = 'nx-content-plan-usage';
      usage.setAttribute('aria-live', 'polite');
      help.insertAdjacentElement('afterend', usage);
    }
  }
}

function refreshAdmin() {
  ensureAdminPlanUI();
  const select = byId('nxContentPlanSelect');
  if (!select) return;
  const open = typeof clientEditorOpen !== 'undefined' && clientEditorOpen;
  select.disabled = !open;
  const stored = typeof legacyCardTypeForSave === 'undefined' ? 'gold' : legacyCardTypeForSave;
  select.value = limits.normalizePlan(stored) === 'elite' ? 'gold' : limits.normalizePlan(stored);
  const usage = byId('nxAdminPlanUsage');
  const quickUsage = byId('nxAdminQuickPlanUsage');
  if (!open) {
    if (usage) usage.textContent = 'Choose a client or create a profile to set its content plan.';
    if (quickUsage) quickUsage.hidden = true;
    return;
  }
  if (quickUsage) quickUsage.hidden = false;
  const draft = adminDraft();
  const previous = adminPrevious();
  updateUsage(usage, draft, previous);
  updateUsage(quickUsage, draft, previous);
}

function refreshClient() {
  const current = window.__nxClient || window.client;
  const usage = byId('nxClientPlanUsage');
  if (!usage) return;
  if (!current) {
    usage.textContent = 'Loading your content allowance…';
    return;
  }
  updateUsage(usage, current, current, true);
}

window.NextapContentPlanUI = { ensureAdminPlanUI, refreshAdmin, refreshClient };
let refreshQueued = false;
function queueAdminRefresh() {
  if (refreshQueued || !byId('nxContentPlanSelect')) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    refreshAdmin();
  });
}
document.addEventListener('input', queueAdminRefresh);
document.addEventListener('change', queueAdminRefresh);
document.addEventListener('click', queueAdminRefresh);
document.addEventListener('nx-admin-content-ready', queueAdminRefresh);
window.addEventListener('nx-client-ready', refreshClient);
refreshAdmin();
refreshClient();
window.dispatchEvent(new CustomEvent('nx-content-plan-ready'));
