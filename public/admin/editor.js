import { contentUsage, QUICK_BLOCKS, SPECIAL_BLOCKS } from '../content-limits.js';

// Row metadata belongs to a row, never its position after removing another row.
export function mergeLineItem(field, value, original) {
  if (typeof original === 'string') return value;
  const item = original && typeof original === 'object' ? { ...original } : {};
  const pair = value.split(/\s*·\s*|\s+[—–-]\s+/).map(part => part.trim());
  if (field === 'pricing' || field === 'products') { item.name = pair[0] || value; item.price = pair.slice(1).join(' · '); }
  else if (field === 'team') { item.name = pair[0] || value; item.role = pair.slice(1).join(' · '); }
  else if (field === 'promotions') { item.title = pair[0] || value; item.details = pair.slice(1).join(' · '); }
  else {
    const key = ['name', 'title', 'school', 'institution', 'text', 'method', 'game', 'platform', 'channel', 'label', 'type', 'value', 'description'].find(key => Object.hasOwn(item, key)) || 'name';
    item[key] = value;
  }
  return item;
}

export function mergeRowDraft(field, value, original, details, originalDisplay) {
  const changed = Object.fromEntries(Object.entries(details).filter(([key, text]) => text !== String(original?.[key] ?? '')));
  if (value === originalDisplay && !Object.keys(changed).length) return original;
  let item = value === originalDisplay && original && typeof original === 'object' ? { ...original } : mergeLineItem(field, value, original);
  if (typeof item === 'string' && Object.keys(changed).length) item = { name: item };
  return typeof item === 'string' ? item : { ...item, ...changed };
}

export const ROW_DETAIL_FIELDS = {
  education: [['degree', 'Degree'], ['course', 'Course'], ['year', 'Year'], ['start_date', 'Start date'], ['end_date', 'End date'], ['date', 'Date'], ['link', 'Link', 'url']],
  certifications: [['issuer', 'Issuer'], ['year', 'Year'], ['date', 'Date'], ['validUntil', 'Valid until'], ['link', 'Link', 'url']],
  achievements: [['description', 'Description'], ['date', 'Date'], ['link', 'Link', 'url']],
  skills: [['level', 'Level'], ['link', 'Link', 'url']],
  products: [['description', 'Description'], ['link', 'Link', 'url']],
  pricing: [['description', 'Description'], ['link', 'Link', 'url']],
  team: [['bio', 'Bio'], ['link', 'Link', 'url']],
  promotions: [['description', 'Description'], ['date', 'Date'], ['link', 'Link', 'url']],
  payments: [['description', 'Instructions'], ['link', 'Link', 'url']]
};

export function sectionState(record, key) {
  let visibility = {};
  try { visibility = typeof record.profile_module_visibility === 'string' ? JSON.parse(record.profile_module_visibility) : record.profile_module_visibility || {}; } catch {}
  const available = { ...record, quick_info_enabled: true, featured_enabled: true,
    ['show_' + key]: true, profile_module_visibility: { ...visibility, [key]: true } };
  if (!contentUsage(available).keys.includes(key)) return 'empty';
  return contentUsage(record).keys.includes(key) ? 'published' : 'hidden';
}

const repeatables = {
  payments: 'Payment method', education: 'Education', skills: 'Skill', achievements: 'Achievement',
  certifications: 'Certification', pricing: 'Package / rate', products: 'Product / menu item',
  promotions: 'Promotion', team: 'Team member', business_inquiry: 'Inquiry option'
};
const structuredRows = { services: '[data-admin-service-row]', portfolio: '[data-admin-portfolio-row]',
  booking: '[data-admin-booking-row]', reviews: '[data-admin-review-row]' };

function initAdminEditor() {
  const byId = id => document.getElementById(id), builders = new Map();
  let filter = 'all', reloadInFlight = false, queued = false;
  let featuredFile = null, featuredObjectUrl = '';
  const copyOriginal = item => item && typeof item === 'object' ? { ...item } : item;

  for (const [field, label] of Object.entries(repeatables)) {
    const area = byId(field);
    if (!area) continue;
    const wrap = document.createElement('div');
    wrap.className = 'content-builder admin-repeatable-editor';
    wrap.dataset.adminBuilderField = field;
    const head = document.createElement('div'); head.className = 'content-builder-head';
    const hint = document.createElement('span'); hint.textContent = 'Each item stays with its saved details when other items are removed.';
    const add = document.createElement('button'); add.type = 'button'; add.className = 'content-builder-add'; add.textContent = '+ Add ' + label.toLowerCase();
    const list = document.createElement('div'); list.className = 'content-builder-list';
    head.append(hint, add); wrap.append(head, list);
    area.hidden = true; area.dataset.builderReady = '1'; area.dataset.builderReady2 = '1';
    area.insertAdjacentElement('afterend', wrap);
    const sync = () => {
      area.value = [...list.querySelectorAll('.admin-row-main')].map(input => input.value.trim()).filter(Boolean).join('\n');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const row = (value = '', original = {}) => {
      const element = document.createElement('div'); element.className = 'content-builder-row'; element._nextapOriginal = copyOriginal(original);
      const input = document.createElement('input'); input.type = 'text'; input.className = 'admin-row-main'; input.value = value; input.setAttribute('aria-label', label + ' item');
      if (['products', 'pricing'].includes(field)) input.placeholder = 'Name · price';
      else if (field === 'team') input.placeholder = 'Name · role';
      else if (field === 'promotions') input.placeholder = 'Title · details';
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'content-builder-remove'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', 'Remove ' + label.toLowerCase());
      input.addEventListener('input', sync);
      remove.addEventListener('click', () => { element.remove(); sync(); add.focus(); });
      element.append(input, remove);
      if (ROW_DETAIL_FIELDS[field]) {
        const details = document.createElement('details'); details.className = 'admin-row-details';
        const title = document.createElement('summary'); title.textContent = 'Optional details';
        const grid = document.createElement('div'); grid.className = 'admin-row-details-grid';
        for (const [key, text, type = 'text'] of ROW_DETAIL_FIELDS[field]) {
          const label = document.createElement('label'); label.textContent = text;
          const control = document.createElement('input'); control.type = type; control.dataset.adminRowProperty = key;
          control.value = original && typeof original === 'object' ? String(original[key] ?? '') : '';
          if (type === 'url') { control.placeholder = 'https://...'; control.pattern = 'https?://.+'; }
          control.addEventListener('input', sync); label.appendChild(control); grid.appendChild(label);
        }
        details.append(title, grid); element.appendChild(details);
      }
      list.appendChild(element); return input;
    };
    const render = () => {
      list.replaceChildren();
      const raw = adminOriginalContent[field] ?? adminEditingBaseline?.[field] ?? area.value;
      let originals; try { originals = JSON.parse(raw); } catch {}
      if (Array.isArray(originals)) {
        originals.forEach(original => {
          const text = adminStructuredDisplay(field, JSON.stringify([original]));
          if (text.trim() || (original && typeof original === 'object' && Object.keys(original).length)) row(text, original);
        });
      } else String(area.value || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean).forEach(value => row(value));
    };
    add.addEventListener('click', () => { row().focus(); setDirty(true); });
    area.addEventListener('nx-builder-refresh', render);
    builders.set(field, { list, render }); render();
  }

  function serializeRows(field) {
    const builder = builders.get(field);
    if (!builder) return undefined;
    const rows = [...builder.list.children].map(row => ({ value: row.querySelector('.admin-row-main').value.trim(), original: row._nextapOriginal,
      details: Object.fromEntries([...row.querySelectorAll('[data-admin-row-property]')].map(control => [control.dataset.adminRowProperty, control.value.trim()]))
    })).filter(item => item.value || Object.values(item.details).some(Boolean) || (item.original && typeof item.original === 'object' && Object.keys(item.original).length));
    if (field === 'business_inquiry' && !parseAdminStructured(adminEditingBaseline?.business_inquiry)) return rows.map(row => row.value).join('\n');
    const items = rows.map(row => mergeRowDraft(field, row.value, row.original, row.details, adminStructuredDisplay(field, JSON.stringify([row.original]))));
    const original = adminOriginalContent[field];
    return JSON.stringify(parseAdminStructured(original)) === JSON.stringify(items) ? original : JSON.stringify(items);
  }

  function captureRows() {
    const captures = [];
    for (const [field, { list }] of builders) {
      const rows = [...list.children].filter(row => [...row.querySelectorAll('input')].some(input => input.value.trim()) || (row._nextapOriginal && typeof row._nextapOriginal === 'object' && Object.keys(row._nextapOriginal).length));
      captures.push({ field, rows });
    }
    for (const [field, selector] of Object.entries(structuredRows)) {
      const rows = [...document.querySelectorAll(selector)].filter(row => [...row.querySelectorAll('input,textarea')].some(input => input.value.trim()));
      captures.push({ field, rows });
    }
    return captures;
  }

  function acceptRows(captures = [], saved) {
    for (const { field, rows } of captures) {
      const items = parseAdminStructured(saved[field]);
      if (!items) continue;
      rows.forEach((row, index) => { if (row.isConnected) row._nextapOriginal = copyOriginal(items[index]); });
    }
  }

  function draftRecord() {
    const record = { ...(adminEditingBaseline || {}), card_type: legacyCardTypeForSave };
    for (const key of QUICK_BLOCKS) {
      if (byId(key)) record[key] = byId(key).value;
      if (byId('show_' + key)) record['show_' + key] = byId('show_' + key).checked;
    }
    for (const key of builders.keys()) record[key] = serializeRows(key);
    record.services = syncAdminServicesEditor(); record.portfolio = syncAdminPortfolioEditor();
    record.booking = syncAdminBookingEditor(); record.reviews = syncAdminReviewsEditor();
    record.business_hours = serializeBusinessHours(); record.business_locations = getBusinessLocationsAdmin();
    record.profile_modules = window.nxCollectAdminModules?.() || '{}';
    record.profile_module_visibility = window.nxCollectAdminModuleVisibility?.() || '{}';
    record.quick_info_enabled = !!byId('quick_info_enabled')?.checked;
    record.featured_enabled = !!byId('featured_enabled')?.checked;
    for (const key of ['featured_title', 'featured_description', 'featured_button_text', 'featured_button_link']) record[key] = byId(key)?.value || '';
    if (byId('featured_image_file')?.files?.length) record.featured_image = 'Selected image';
    return record;
  }

  const summary = document.createElement('div'); summary.id = 'adminContentSummary'; summary.className = 'admin-content-summary'; summary.setAttribute('aria-live', 'polite');
  const summaryText = document.createElement('p');
  const filterLabel = document.createElement('label'); filterLabel.textContent = 'Show sections';
  const select = document.createElement('select'); select.setAttribute('aria-label', 'Filter content by publication status');
  for (const [value, text] of [['all', 'All sections'], ['published', 'Enabled with content'], ['hidden', 'Hidden drafts'], ['empty', 'Empty sections']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = text; select.appendChild(option);
  }
  select.addEventListener('change', () => { filter = select.value; refresh(); });
  filterLabel.appendChild(select); summary.append(summaryText, filterLabel);
  byId('quickInfoCard')?.querySelector(':scope > .hint')?.insertAdjacentElement('afterend', summary);

  const featuredPreview = document.createElement('div'); featuredPreview.className = 'admin-featured-preview';
  const featuredImage = document.createElement('img'); featuredImage.alt = 'Featured image preview';
  const featuredCaption = document.createElement('span'); featuredPreview.append(featuredImage, featuredCaption);
  byId('featured_image_file')?.insertAdjacentElement('afterend', featuredPreview);

  function refresh() {
    const record = draftRecord(), counts = { published: 0, hidden: 0, empty: 0 };
    for (const key of ['featured', ...QUICK_BLOCKS, ...SPECIAL_BLOCKS]) {
      const module = key === 'featured' ? byId('featuredCard')
        : document.querySelector(`[data-quick-module="${key}"]`) || byId('profile_module_' + key)?.closest('.module');
      if (!module) continue;
      const state = sectionState(record, key); counts[state]++;
      const head = module.querySelector('.module-head') || module.querySelector('h2');
      let status = module.querySelector('.admin-section-status');
      if (!status && head) { status = document.createElement('span'); status.className = 'admin-section-status'; head.appendChild(status); }
      if (status) { status.dataset.state = state; status.textContent = state === 'published' ? (formDirty ? 'Ready to publish' : 'Published') : state === 'hidden' ? 'Hidden draft' : 'Empty'; }
      if (key !== 'featured') module.classList.toggle('admin-content-filter-hidden', filter !== 'all' && state !== filter);
    }
    summaryText.textContent = clientEditorOpen
      ? `${formDirty ? 'Draft settings' : 'Saved settings'}: ${counts.published} enabled sections with content · ${counts.hidden} hidden drafts · ${counts.empty} empty. Availability switches control client editing and public visibility; hidden content stays saved. Save to apply changes.`
      : 'Choose a client or create a profile to manage its content.';
    const file = byId('featured_image_file')?.files?.[0] || null;
    if (file !== featuredFile) {
      if (featuredObjectUrl) URL.revokeObjectURL(featuredObjectUrl);
      featuredFile = file; featuredObjectUrl = file ? URL.createObjectURL(file) : '';
    }
    const image = featuredObjectUrl || adminEditingBaseline?.featured_image || '';
    featuredPreview.hidden = !image;
    if (image) { featuredImage.src = image; featuredCaption.textContent = file ? 'Selected image · not saved yet' : 'Saved featured image'; }
    else featuredImage.removeAttribute('src');
    window.NextapContentPlanUI?.refreshAdmin();
  }

  function setConflict(conflict) { const button = byId('adminReloadSaved'); if (button) button.hidden = !conflict; }
  byId('adminReloadSaved')?.addEventListener('click', async () => {
    if (savingClient || reloadInFlight || !editingId) return;
    if (formDirty && !confirm('Reloading replaces all unsaved edits with the saved profile. Reload now?')) return;
    reloadInFlight = true;
    const button = byId('adminReloadSaved'), version = editorDraftVersion, id = editingId;
    button.disabled = true;
    try {
      const response = await fetch('/api/clients/' + encodeURIComponent(id), { cache: 'no-store', credentials: 'same-origin' });
      const saved = await response.json();
      if (!response.ok) throw Error(saved.error || 'Could not reload the saved profile. Your draft is kept.');
      if (editorDraftVersion !== version && !confirm('You made more edits while loading. Replace them with the saved profile?')) return;
      window.clients = (window.clients || []).filter(client => client.id !== id).concat(saved);
      reloadInFlight = false;
      setDirty(false); await window.editClient(id);
      byId('msg').textContent = 'Saved profile reloaded. You can edit and save again.';
    } catch (error) { byId('msg').textContent = error.message; }
    finally { reloadInFlight = false; button.disabled = false; }
  });

  window.NextapAdminEditor = { serializeRows, captureRows, acceptRows, refresh, setConflict, isReloading: () => reloadInFlight };
  const queue = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; refresh(); }); };
  document.addEventListener('input', queue); document.addEventListener('change', queue);
  document.addEventListener('click', queue); document.addEventListener('nx-admin-content-ready', queue);
  window.addEventListener('nx-content-plan-ready', queue);
  setPreviewOpen(false); refresh();
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') initAdminEditor();
