(() => {
  'use strict';

  const menu = document.getElementById('homeMenuToggle');
  const navigation = document.getElementById('homeNavigation');
  if (menu && navigation) {
    const setMenu = open => {
      navigation.classList.toggle('is-open', open);
      menu.setAttribute('aria-expanded', String(open));
    };
    menu.hidden = false;
    menu.setAttribute('aria-controls', 'homeNavigation');
    setMenu(false);
    menu.addEventListener('click', () => setMenu(menu.getAttribute('aria-expanded') !== 'true'));
    navigation.addEventListener('click', event => {
      if (event.target?.closest?.('a')) setMenu(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
        event.preventDefault();
        setMenu(false);
        menu.focus();
      }
    });
    document.addEventListener('click', event => {
      if (menu.getAttribute('aria-expanded') === 'true' &&
          !menu.contains(event.target) && !navigation.contains(event.target)) setMenu(false);
    });
    document.documentElement.classList.add('home-js');
  }

  const grid = document.getElementById('homeDesignGrid');
  const status = document.getElementById('homeDesignStatus');
  const search = document.getElementById('homeDesignSearch');
  const more = document.getElementById('homeDesignMore');
  const retry = document.getElementById('homeDesignRetry');
  const dialog = document.getElementById('homeDesignDialog');
  const title = document.getElementById('homePreviewTitle');
  const image = document.getElementById('homePreviewImage');
  const front = document.getElementById('homePreviewFront');
  const back = document.getElementById('homePreviewBack');
  const order = document.getElementById('homePreviewOrder');
  const close = document.getElementById('homePreviewClose');
  const description = document.getElementById('homePreviewDescription');
  const categories = [...document.querySelectorAll('[data-home-category]')];
  if (![grid, status, search, more, retry, dialog, title, image, front, back, order, close, description].every(Boolean)) return;

  const labels = { nextap: 'Nextap Design', animated: 'Animated Design', customized: 'Customized Design', all: 'All designs' };
  const initialMarkup = grid.innerHTML;
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  let catalog = [];
  let ready = false;
  let category = 'nextap';
  let limit = 12;
  let requestId = 0;
  let preview = null;
  let previewSide = 'front';
  let opener = null;
  let nativePreview = typeof dialog.showModal === 'function';

  function validateCatalog(data) {
    if (!Array.isArray(data) || !data.length || data.length > 200) throw new Error('Invalid catalog');
    const ids = new Set();
    const designs = data.map(entry => {
      if (!entry || typeof entry.id !== 'string' || !/^(?:A|C|N|PN|Q)[1-9]\d{0,2}$/.test(entry.id) || ids.has(entry.id)) throw new Error('Invalid design');
      const expectedCategory = /^(?:N|PN)\d+$/.test(entry.id) ? 'nextap' : /^(?:A|Q)\d+$/.test(entry.id) ? 'animated' : 'customized';
      if (entry.category !== expectedCategory || typeof entry.version !== 'string' || !/^[a-f0-9]{12}$/.test(entry.version)) throw new Error('Invalid design category');
      const prefix = '/card-designs/' + entry.id.toLowerCase() + '-' + entry.version;
      if (entry.front !== prefix + '-front.webp' || entry.back !== prefix + '-back.webp' || entry.thumbnail !== prefix + '-thumb.webp') throw new Error('Invalid design images');
      if (entry.label !== undefined && typeof entry.label !== 'string') throw new Error('Invalid design label');
      ids.add(entry.id);
      return { id: entry.id, label: (entry.label || entry.id).slice(0, 120), category: entry.category, front: entry.front, back: entry.back, thumbnail: entry.thumbnail };
    });
    const rank = { nextap: 0, animated: 1, customized: 2 };
    return designs.sort((left, right) => rank[left.category] - rank[right.category] ||
      (left.category === 'nextap' && right.category === 'nextap' ? Number(left.id.startsWith('PN')) - Number(right.id.startsWith('PN')) : 0) ||
      left.id.localeCompare(right.id, 'en', { numeric: true }));
  }

  function setControls(enabled) {
    for (const button of categories) {
      button.disabled = !enabled;
      button.setAttribute('aria-pressed', String(button.dataset.homeCategory === category));
    }
    search.disabled = !enabled;
  }

  function renderGallery() {
    if (!ready) return;
    setControls(true);
    const query = search.value.trim().toLowerCase();
    const matches = catalog.filter(design => (category === 'all' || design.category === category) &&
      (design.id + ' ' + design.label).toLowerCase().includes(query));
    const visible = matches.slice(0, limit);
    grid.innerHTML = visible.map(design => {
      const tag = nativePreview ? 'button' : 'a';
      const action = nativePreview ? 'type="button"' : 'href="/order?design=' + encodeURIComponent(design.id) + '"';
      return '<' + tag + ' class="home-design-card" ' + action + ' data-home-design="' + escape(design.id) + '" aria-label="' +
        (nativePreview ? 'Preview design ' : 'Choose design ') + escape(design.label) + '"><img class="home-design-image" src="' + escape(design.thumbnail) +
        '" alt="Design ' + escape(design.label) + ' front" width="320" height="202" loading="lazy" decoding="async"><span class="home-design-meta"><strong>' +
        escape(design.label) + '</strong><span>' + labels[design.category] + '</span></span></' + tag + '>';
    }).join('');
    status.textContent = matches.length ? 'Showing ' + visible.length + ' of ' + matches.length + ' ' + labels[category].toLowerCase() +
      (nativePreview ? '. Select a card to preview both sides.' : '. Select a card to choose it at checkout.') : 'No designs match this search in ' + labels[category] + '.';
    more.hidden = visible.length >= matches.length;
    more.disabled = more.hidden;
    retry.hidden = true;
  }

  async function loadCatalog() {
    const currentRequest = ++requestId;
    ready = false;
    setControls(false);
    more.hidden = true;
    retry.hidden = true;
    retry.disabled = true;
    status.textContent = 'Loading card previews. The design links below are still available.';
    try {
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(10000) : undefined;
      const response = await fetch('/card-designs/catalog.json', { credentials: 'same-origin', cache: 'no-cache', signal });
      if (!response.ok) throw new Error('Catalog unavailable');
      const data = validateCatalog(await response.json());
      if (currentRequest !== requestId) return;
      catalog = data;
      ready = true;
      renderGallery();
    } catch {
      if (currentRequest !== requestId) return;
      catalog = [];
      ready = false;
      grid.innerHTML = initialMarkup;
      setControls(false);
      status.textContent = 'Card previews could not load. You can still choose a Nextap design using the links below, or retry to browse all designs.';
      retry.hidden = false;
    } finally {
      if (currentRequest === requestId) retry.disabled = false;
    }
  }

  for (const button of categories) button.addEventListener('click', () => {
    if (!ready || !Object.prototype.hasOwnProperty.call(labels, button.dataset.homeCategory)) return;
    category = button.dataset.homeCategory;
    limit = 12;
    renderGallery();
  });
  search.addEventListener('input', () => { limit = 12; renderGallery(); });
  more.addEventListener('click', () => { limit += 12; renderGallery(); });
  retry.addEventListener('click', loadCatalog);

  function renderPreview() {
    if (!preview) return;
    title.textContent = 'Design ' + preview.label;
    description.textContent = labels[preview.category] + ' · Matching front and back. Available for Basic, Premium, and Elite.';
    image.hidden = false;
    image.src = preview[previewSide];
    image.alt = 'Design ' + preview.label + ' ' + previewSide;
    front.setAttribute('aria-pressed', String(previewSide === 'front'));
    back.setAttribute('aria-pressed', String(previewSide === 'back'));
    order.setAttribute('href', '/order?design=' + encodeURIComponent(preview.id));
  }

  grid.addEventListener('click', event => {
    const card = event.target?.closest?.('[data-home-design]');
    if (!ready || !nativePreview || !card || !grid.contains(card)) return;
    const design = catalog.find(item => item.id === card.dataset.homeDesign);
    if (!design) return;
    event.preventDefault();
    preview = design;
    previewSide = 'front';
    opener = card;
    renderPreview();
    try {
      if (!dialog.open) dialog.showModal();
      close.focus();
    } catch {
      nativePreview = false;
      preview = null;
      renderGallery();
      status.textContent = 'Your browser could not open the preview. Use the design links to choose a card at checkout.';
    }
  });
  front.addEventListener('click', () => { previewSide = 'front'; renderPreview(); });
  back.addEventListener('click', () => { previewSide = 'back'; renderPreview(); });
  close.addEventListener('click', () => { if (dialog.open) dialog.close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog && dialog.open) dialog.close(); });
  // Native Escape handling dispatches close; leaving cancel untouched preserves
  // the browser's focus trap, keyboard behavior and accessible dialog semantics.
  dialog.addEventListener('close', () => {
    preview = null;
    const target = opener?.isConnected ? opener : search;
    target.focus();
    opener = null;
  });
  image.addEventListener('error', () => {
    if (!preview) return;
    image.hidden = true;
    description.textContent = 'This preview image could not load. You can still choose this design at checkout.';
  });

  loadCatalog();
})();
