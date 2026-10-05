import * as limits from './content-limits.js';

export function withRevision(body, client) {
  const revision = client?.content_revision;
  return Number.isSafeInteger(revision) && revision >= 0 ? { ...body, expected_revision: revision } : { ...body };
}

export function revisionHeaders(client) {
  const revision = client?.content_revision;
  return Number.isSafeInteger(revision) && revision >= 0 ? { 'X-Expected-Revision': String(revision) } : {};
}

export function responseError(response, body, fallback = 'Save failed') {
  const error = new Error(body?.error || fallback);
  error.conflict = response.status === 409 && body?.code === 'PROFILE_CHANGED';
  return error;
}

export function structuredItems(key, raw) {
  let values;
  try { values = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch {}
  if (!Array.isArray(values)) values = String(raw || '').trim().split(/\r?\n/).filter(value => value.trim());
  return values.map(value => {
    if (value && typeof value === 'object') {
      const item = { ...value };
      const pick = names => names.map(name => item[name]).find(value => value !== undefined && value !== null && String(value).trim());
      if (['services', 'products', 'pricing', 'team'].includes(key) && !item.name) item.name = pick(['title', 'service', 'product', 'label']) || '';
      if (['portfolio', 'booking', 'promotions'].includes(key) && !item.title) item.title = pick(['name', 'project', 'service', 'offer']) || '';
      if (key === 'reviews') { if (!item.text) item.text = pick(['review', 'comment']) || ''; if (!item.name) item.name = pick(['author', 'reviewer']) || ''; }
      if (!item.link) item.link = pick(['url', 'href']) || '';
      return item;
    }
    const text = String(value ?? '').trim();
    if (key === 'reviews') return { text, rating: 5 };
    if (key === 'booking' && /^https?:\/\//i.test(text)) return { title: 'Booking', link: text };
    return { [['portfolio', 'booking', 'promotions'].includes(key) ? 'title' : 'name']: text };
  });
}

export function repeatableEntries(raw) {
  let values;
  try { values = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch {}
  if (!Array.isArray(values)) values = String(raw || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  return values.map(value => ({
    value: typeof value === 'object' && value !== null
      ? String(value.school || value.institution || value.name || value.title || value.text || value.method || value.label || value.skill || value.certification || value.achievement || value.type || value.value || value.description || '')
      : String(value ?? ''),
    original: value && typeof value === 'object' ? { ...value } : null
  }));
}

export function mergeRepeatableItems(key, entries) {
  return JSON.stringify(entries.filter(entry => String(entry.value || '').trim()).map(entry => {
    const line = String(entry.value || '').trim();
    const base = entry.original && typeof entry.original === 'object' ? { ...entry.original } : {};
    const pair = line.split(/\s*·\s*|\s+[—–-]\s+/).map(value => value.trim()).filter(Boolean);
    if (key === 'pricing' || key === 'products') { base.name = pair[0] || line; if (pair[1]) base.price = pair[1]; }
    else if (key === 'team') { base.name = pair[0] || line; if (pair[1]) base.role = pair[1]; }
    else if (key === 'portfolio') base.title = pair[0] || line;
    else if (key === 'reviews') base.text = line;
    else if (key === 'promotions') { base.title = pair[0] || line; if (pair[1]) base.details = pair[1]; }
    else {
      const field = ['school', 'institution', 'name', 'title', 'text', 'method', 'label', 'skill', 'certification', 'achievement', 'type', 'value', 'description'].find(name => Object.hasOwn(base, name)) || 'name';
      base[field] = line;
    }
    Object.assign(base, entry.details || {});
    return base;
  }));
}

export function repeatableDetailSchema(key, original) {
  const schemas = {
    education: [['degree', 'Degree'], ['course', 'Course / program'], ['start_date', 'Start date'], ['end_date', 'End date'], ['link', 'School or program link', 'url']],
    certifications: [['issuer', 'Issuer'], ['year', 'Year'], ['link', 'Certificate link', 'url']],
    achievements: [['description', 'Description'], ['date', 'Date'], ['link', 'Achievement link', 'url']],
    skills: original ? [['level', 'Level']] : []
  };
  const aliases = { issuer: ['organization', 'authority'], year: ['issued_year', 'yearIssued'], link: ['url', 'href', 'certificate_url'], description: ['details'], date: ['awarded_at'], course: ['program'], start_date: ['start', 'startYear'], end_date: ['end', 'endYear'] };
  const primary = original && ['school', 'institution', 'name', 'title', 'text', 'method', 'label', 'skill', 'certification', 'achievement', 'type', 'value', 'description'].find(name => String(original[name] ?? '').trim());
  const fields = (schemas[key] || []).map(([name, label, type]) => {
    const stored = original && [name, ...(aliases[name] || [])].find(field => Object.hasOwn(original, field));
    return [stored || name, label, type];
  }).filter(([name]) => name !== primary);
  for (const name of ['dates', 'date', 'year', 'program', 'startYear', 'endYear', 'institution']) {
    if (original && name !== primary && Object.hasOwn(original, name) && !fields.some(field => field[0] === name)) fields.push([name, name.replace(/([A-Z])/g, ' $1').replace(/^./, value => value.toUpperCase())]);
  }
  return fields;
}

export function hoursEditorWarning(raw, parsed) {
  const text = String(raw || '').trim();
  if (!text) return '';
  let complex = false;
  try {
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value.periods) || value.mode || value.all_day || value.allDay) complex = true;
      Object.values(value).forEach(visit);
    };
    visit(JSON.parse(text));
  } catch {}
  if (complex) return 'This schedule contains split shifts or special all-day settings. It stays unchanged until you edit. Saving edits here replaces those settings with one opening and closing time per day.';
  if (!parsed.some(day => day.enabled) && !/closed|off|"enabled"\s*:\s*false|"closed"\s*:\s*true|^\[\s*\]$/i.test(text))
    return 'This saved schedule could not be mapped to the day-by-day editor. It stays unchanged until you edit. Review each day carefully before saving a replacement.';
  return '';
}

export class SectionDrafts {
  constructor() { this.saved = new Map(); }
  keep(key, nodes, initial, current) {
    if (initial !== current) this.saved.set(key, { nodes, initial });
    else this.saved.delete(key);
  }
  get(key) { return this.saved.get(key); }
  has(key) { return this.saved.has(key); }
  clear(key) { this.saved.delete(key); }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const byId = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const drafts = new SectionDrafts();
  let active = null, initial = '', sequence = 0, pickerFocus = null;
  const signature = editor => JSON.stringify([...editor.querySelectorAll('input,textarea,select')].map(field =>
    field.type === 'checkbox' ? field.checked : field.type === 'file'
      ? [...(field.files || [])].map(file => [file.name, file.size, file.lastModified]) : field.value));
  function capture() {
    const editor = byId('nxContentEditor');
    if (active && editor) drafts.keep(active, [...editor.childNodes], initial, signature(editor));
  }
  function refresh() { window.nxRenderClientContent?.(); }
  function hasDraft(key) { capture(); return drafts.has(key); }
  function beforeEditorOpen(key, editor) {
    capture();
    const stored = drafts.get(key);
    if (!stored) { active = key; return false; }
    editor.replaceChildren(...stored.nodes);
    const moduleShape = editor.querySelector('.nx-workspace-module-list')?.dataset.moduleShape;
    if (moduleShape) editor.dataset.moduleShape = moduleShape; else delete editor.dataset.moduleShape;
    active = key;
    initial = stored.initial;
    editor.hidden = false;
    associateLabels(editor);
    editor.querySelector('input:not([disabled]),textarea,select,button')?.focus();
    editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    refresh();
    return true;
  }
  function originalRow(row) { return row?.__nxOriginalItem && typeof row.__nxOriginalItem === 'object' ? { ...row.__nxOriginalItem } : {}; }
  function hoursRowMetadata(row) {
    const original = originalRow(row);
    for (const key of ['periods', 'mode', 'all_day', 'allDay', 'closed', 'opening', 'closing', 'start', 'end']) delete original[key];
    return original;
  }
  function bindRows(editor, key, client) {
    const rows = [...editor.querySelectorAll('[data-service-row],[data-portfolio-row],[data-booking-row],[data-review-row],[data-pricing-row],[data-product-row],[data-promo-row],[data-team-row],[data-business-location-row],.nx-repeatable-row')];
    let originals = key === 'business_location' ? structuredItems(key, client.business_locations) : structuredItems(key, client[key]);
    if (key === 'business_location' && !originals.length && client.business_location_name) originals = [{ name: client.business_location_name, link: client.business_location_link }];
    const entries = repeatableEntries(client[key]);
    rows.forEach((row, index) => {
      row.__nxOriginalItem = row.matches('.nx-repeatable-row') ? entries[index]?.original : originals[index] || null;
      const rating = row.querySelector('[data-review="rating"]');
      if (rating && originals[index]?.rating) rating.value = String(originals[index].rating);
    });
    if (key === 'business_hours') {
      let data;
      try { data = JSON.parse(String(client.business_hours || '')); } catch {}
      const source = data?.days || data?.hours || data;
      const names = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
      const values = Array.isArray(source) ? source.map((value, index) => [Number.isInteger(value?.day) ? value.day : names[String(value?.day || '').toLowerCase()] ?? index, value]) : source && typeof source === 'object' ? Object.entries(source).map(([name, value]) => [names[name.toLowerCase()], value]) : [];
      editor.querySelectorAll('[data-hours-row]').forEach(row => {
        const original = values.find(([day]) => day === Number(row.dataset.day))?.[1];
        row.__nxOriginalItem = original && typeof original === 'object' ? { ...original } : null;
      });
    }
  }
  function enhanceRepeatableDetails(editor, key) {
    editor.querySelectorAll('.nx-repeatable-row').forEach(row => {
      if (row.dataset.detailsReady) return;
      row.dataset.detailsReady = 'true';
      const original = originalRow(row);
      const schema = repeatableDetailSchema(key, row.__nxOriginalItem);
      if (!schema.length) return;
      const details = document.createElement('details'); details.className = 'nx-workspace-entry-details';
      details.innerHTML = '<summary>Optional details</summary><div class="nx-workspace-detail-grid">' + schema.map(([name, label, type = 'text']) => '<label>' + escape(label) + '<input data-entry-detail="' + escape(name) + '" type="' + type + '" value="' + escape(original[name] ?? '') + '"></label>').join('') + '</div>';
      row.querySelector('.nx-repeatable-main')?.appendChild(details);
    });
  }
  function renderModuleEditor(editor, key, icon, label, raw) {
    const structured = raw && typeof raw === 'object';
    if (!structured) return false;
    const values = Array.isArray(raw) ? raw : [raw];
    editor.dataset.moduleShape = Array.isArray(raw) ? 'array' : 'object';
    editor.innerHTML = '<div class="nx-editor-title"><strong>' + escape(icon + ' ' + label) + '</strong><button type="button" class="nx-editor-close" aria-label="Close">×</button></div><p class="sub">Edit each item below. Existing details remain attached to the same item when you remove another row.</p><div class="nx-workspace-module-list"></div><button type="button" class="nx-repeatable-add nx-workspace-module-add">＋ Add item</button><div class="nx-editor-actions"><button type="button" class="nx-block-edit nx-editor-close">Cancel</button><button type="button" class="nx-editor-save">Save changes</button></div>';
    const list = editor.querySelector('.nx-workspace-module-list');
    list.dataset.moduleShape = editor.dataset.moduleShape;
    function addRow(value = {}) {
      const original = value && typeof value === 'object' ? value : null;
      const data = original || { name: String(value ?? '') };
      const primary = ['name', 'title', 'label', 'channel', 'game', 'platform', 'text'].find(name => Object.hasOwn(data, name)) || 'name';
      const description = ['description', 'details', 'caption'].find(name => Object.hasOwn(data, name)) || 'description';
      const link = ['link', 'url', 'href', 'website', 'invite'].find(name => Object.hasOwn(data, name)) || 'link';
      const fields = [[primary, 'Name / title'], [description, 'Description'], [link, 'Link', 'url']];
      for (const name of Object.keys(data)) {
        if (!fields.some(field => field[0] === name) && typeof data[name] !== 'object' && typeof data[name] !== 'boolean') fields.push([name, name.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').replace(/^./, value => value.toUpperCase()), /^(image|image_url|thumbnail)$/i.test(name) ? 'url' : 'text']);
      }
      const row = document.createElement('div'); row.className = 'nx-structured-card'; row.dataset.moduleRow = 'true'; row.__nxOriginalItem = original; row.__nxOriginalString = typeof value === 'string';
      row.innerHTML = '<div class="nx-structured-head"><strong>Item</strong><button type="button" class="nx-repeatable-remove" aria-label="Remove item">×</button></div><div class="nx-workspace-detail-grid">' + fields.map(([name, title, type = 'text']) => '<label>' + escape(title) + '<input data-module-field="' + escape(name) + '" type="' + type + '" value="' + escape(data[name] ?? '') + '"></label>').join('') + '</div>';
      row.querySelector('button').addEventListener('click', () => row.remove());
      list.appendChild(row);
    }
    if (values.length) values.forEach(addRow); else addRow();
    editor.querySelector('.nx-workspace-module-add').addEventListener('click', () => { addRow(); associateLabels(editor); list.lastElementChild.querySelector('input')?.focus(); });
    return true;
  }
  function collectModuleRows(editor) {
    const rows = [...editor.querySelectorAll('[data-module-row]')].map(row => {
      const data = originalRow(row);
      for (const field of row.querySelectorAll('[data-module-field]')) data[field.dataset.moduleField] = field.value.trim();
      if (row.__nxOriginalString && Object.entries(data).every(([key, value]) => key === 'name' || !value)) return data.name || '';
      return data;
    }).filter(limits.hasBlockContent);
    return editor.dataset.moduleShape === 'object' && rows.length === 1 ? rows[0] : rows;
  }
  function associateLabels(container) {
    container.querySelectorAll('label').forEach(label => {
      if (label.htmlFor || label.querySelector('input,textarea,select')) return;
      const field = label.parentElement?.querySelector('input,textarea,select');
      if (!field) return;
      if (!field.id) field.id = `nxWorkspaceField${++sequence}`;
      label.htmlFor = field.id;
    });
    container.querySelectorAll('[data-hours-enabled]').forEach(field => {
      const day = field.closest('[data-hours-row]')?.querySelector('.nx-hours-day')?.textContent || 'Day';
      field.setAttribute('aria-label', `${day} open`);
    });
  }
  function mountEditor(key, editor, client) {
    active = key;
    bindRows(editor, key, client);
    enhanceRepeatableDetails(editor, key);
    associateLabels(editor);
    initial = signature(editor);
    const actions = editor.querySelector('.nx-editor-actions');
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'nx-block-edit';
    discard.textContent = 'Discard draft';
    discard.addEventListener('click', () => {
      drafts.clear(key); active = null;
      editor.replaceChildren(); editor.hidden = true;
      refresh();
      byId('nxAddContent')?.focus();
    });
    actions?.prepend(discard);
    editor.querySelectorAll('.nx-editor-close').forEach(button => {
      if (button.textContent.trim() === 'Cancel') button.textContent = 'Keep draft & close';
      button.addEventListener('click', () => { capture(); refresh(); });
    });
    editor.querySelector('input:not([disabled]),textarea,select,button')?.focus();
    refresh();
  }
  function editorSaved(key, editor) {
    drafts.clear(key);
    if (active === key) initial = signature(editor);
    refresh();
  }
  function validateEditor(editor) {
    associateLabels(editor);
    for (const field of editor.querySelectorAll('input,textarea,select')) {
      field.removeAttribute('aria-invalid');
      if (field.disabled || field.type === 'file') continue;
      let valid = field.checkValidity();
      if (valid && field.type === 'url' && field.value.trim()) {
        try { valid = ['http:', 'https:'].includes(new URL(field.value.trim()).protocol); } catch { valid = false; }
      }
      if (field.matches('[data-hours-open],[data-hours-close]') && !field.disabled && !field.value) valid = false;
      if (!valid) {
        field.setAttribute('aria-invalid', 'true');
        field.setAttribute('aria-describedby', [field.getAttribute('aria-describedby'), 'nxContentSaveError'].filter(Boolean).join(' '));
        const details = field.closest('details'); if (details) details.open = true;
        field.focus(); field.reportValidity();
        const label = field.labels?.[0]?.textContent.trim() || field.getAttribute('aria-label') || 'this field';
        throw new Error(`Check ${label}. ${field.type === 'url' ? 'Use a complete http:// or https:// link.' : 'Enter a valid value.'}`);
      }
    }
    const text = editor.querySelector('#nxFeaturedButtonText')?.value.trim();
    const link = editor.querySelector('#nxFeaturedButtonLink')?.value.trim();
    if (Boolean(text) !== Boolean(link)) throw new Error('Enter both button text and a complete button link, or clear both.');
  }
  function showConflict(error, container) {
    if (!error?.conflict || !container || container.querySelector?.('.nx-workspace-reload')) return;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'nx-block-edit nx-workspace-reload'; button.textContent = 'Reload latest profile';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const response = await fetch('/api/client-auth/me', { credentials: 'same-origin', cache: 'no-store' });
        const body = await response.json();
        if (!response.ok || !body.authenticated || !body.client) throw new Error('Could not reload your profile.');
        capture(); window.__nxSetClient?.(body.client);
        container.textContent = 'Latest profile loaded. Your draft is retained; review it before saving again.';
      } catch (failure) { button.textContent = failure.message; button.disabled = false; }
    });
    container.appendChild(button);
  }
  function openPicker() {
    capture();
    const picker = byId('nxContentPicker');
    const list = byId('nxContentPickerList');
    if (!picker || !list) return;
    const current = window.__nxClient || {};
    const usage = limits.contentUsage(current);
    const present = limits.contentUsage({ ...current, quick_info_enabled: true, featured_enabled: true, profile_module_visibility: {}, ...Object.fromEntries(limits.QUICK_BLOCKS.map(key => [`show_${key}`, true])) });
    const permitted = (window.nxClientContentCatalog || []).filter(item => window.nxClientCanAddContent?.(item[0], current));
    list.replaceChildren();
    for (const [key, icon, label, description] of permitted) {
      if (key !== 'contact' && present.keys.includes(key) && !drafts.has(key)) continue;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'nx-workspace-choice';
      const full = key !== 'contact' && !drafts.has(key) && !usage.keys.includes(key) && usage.limit !== null && usage.used >= usage.limit;
      button.disabled = full;
      const title = document.createElement('strong'); title.textContent = `${icon} ${label}`;
      const note = document.createElement('span'); note.textContent = full ? 'No block slots available. Ask your admin to hide a section or change your plan.' : drafts.has(key) ? 'Continue your unsaved draft.' : description;
      button.append(title, note);
      button.addEventListener('click', () => { closePicker(false); window.openEditor?.(key); });
      list.appendChild(button);
    }
    if (!list.children.length) list.textContent = 'All available sections have content. Edit a section below or ask your admin about additional sections.';
    pickerFocus = document.activeElement;
    picker.hidden = false;
    byId('nxContentPickerClose')?.focus();
  }
  function closePicker(restore = true) { const picker = byId('nxContentPicker'); if (picker) picker.hidden = true; if (restore) pickerFocus?.focus(); }
  window.NextapClientWorkspace = { withRevision, revisionHeaders, responseError, structuredItems, repeatableEntries, mergeRepeatableItems, repeatableDetailSchema, renderModuleEditor, collectModuleRows, hoursEditorWarning, hoursRowMetadata, beforeEditorOpen, mountEditor, editorSaved, hasDraft, capture, originalRow, validateEditor, showConflict, associateLabels, openPicker, closePicker, isActive: key => active === key };
  byId('nxAddContent')?.addEventListener('click', openPicker);
  byId('nxContentPickerClose')?.addEventListener('click', () => closePicker());
  document.addEventListener('input', event => {
    if (event.target.closest('#nxContentEditor')) { capture(); refresh(); }
    else if (event.target.closest('#profileForm') && window.nxHasMainDraft?.()) {
      const status = byId('status'); if (status) status.textContent = 'Unsaved profile changes. Save all changes when you are ready.';
    }
  });
  document.addEventListener('change', event => {
    if (event.target.closest('#nxContentEditor')) { capture(); refresh(); }
  });
  document.addEventListener('click', event => {
    if (event.target.closest('#nxContentEditor')) queueMicrotask(() => { const editor = byId('nxContentEditor'); enhanceRepeatableDetails(editor, active); capture(); associateLabels(editor); refresh(); });
  });
  window.addEventListener('beforeunload', event => {
    capture();
    if (drafts.saved.size || window.nxHasMainDraft?.()) { event.preventDefault(); event.returnValue = ''; }
  });
  const modal = byId('photoCropModal');
  let cropFocus = null;
  if (modal) {
    const canvas = byId('photoCropCanvas');
    canvas?.setAttribute('tabindex', '0'); canvas?.setAttribute('aria-label', 'Photo crop. Use arrow keys to move the photo; Shift moves faster.');
    new MutationObserver(() => {
      if (!modal.hidden) { cropFocus = document.activeElement; byId('photoCropZoom')?.focus(); }
      else cropFocus?.focus();
    }).observe(modal, { attributes: true, attributeFilter: ['hidden'] });
    canvas?.addEventListener('keydown', event => {
      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (direction) { event.preventDefault(); const step = event.shiftKey ? 20 : 5; window.nxPanProfileCrop?.(direction[0] * step, direction[1] * step); }
    });
  }
  document.addEventListener('keydown', event => {
    const picker = byId('nxContentPicker');
    const dialog = modal && !modal.hidden ? modal : picker && !picker.hidden ? picker : null;
    if (!dialog) return;
    if (event.key === 'Escape') { event.preventDefault(); if (dialog === modal && typeof nxCropClose === 'function') nxCropClose(); else closePicker(); }
    if (event.key === 'Tab') {
      const fields = [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex="0"]')];
      const first = fields[0], last = fields[fields.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  associateLabels(document);
  for (const id of ['status', 'photoStatus', 'passwordStatus', 'nxContentFeedback']) { const element = byId(id); element?.setAttribute('role', 'status'); element?.setAttribute('aria-live', 'polite'); }
  refresh();
}
