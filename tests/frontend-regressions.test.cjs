const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const scripts = html => [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);

class Element {
  constructor() {
    this.dataset = {};
    this.style = {};
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.files = [];
    this.children = [];
    this.listeners = {};
    this.disabled = false;
    this.isConnected = true;
    this.attributes = {};
    const classes = new Set();
    this.classList = {add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name)};
  }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  replaceChildren(...children) { this.children = children; this.value = children[0]?.value ?? ''; }
  appendChild(child) { this.children.push(child); }
  toggleAttribute(name, enabled) { if (enabled) this.attributes[name] = ''; else delete this.attributes[name]; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() { this.focusCount = (this.focusCount || 0) + 1;this.onHarnessFocus?.(); }
  closest() { return null; }
  getClientRects() { return [{}]; }
  get selectedOptions() { return this.children.filter(child => child.value === this.value); }
}

function checkoutHarness(options = {}) {
  const ids = new Map(), names = new Map(), controls = new Map(), listeners = {}, storage = new Map();
  const getId = id => { if (!ids.has(id)) ids.set(id, new Element()); return ids.get(id); };
  const getName = name => { if (!names.has(name)) names.set(name, new Element()); return names.get(name); };
  const requests = [], addressRequests = [], catalogRequests = [], canvases = [];
  const defaultCatalog=Array.from({length:36},(_,index)=>({id:'A'+(index+1),label:'A'+(index+1),front:'/card-designs/a'+(index+1)+'-abc123-front.webp',back:'/card-designs/a'+(index+1)+'-abc123-back.webp',thumbnail:'/card-designs/a'+(index+1)+'-abc123-thumb.webp',version:'abc123'}));
  const catalog='catalog' in options?options.catalog:defaultCatalog;
  const body=new Element(),background=[new Element(),new Element(),getId('drawer'),getId('modal')];
  let activeElement=body;
  const bindFocus=element=>{if(!element.onHarnessFocus)element.onHarnessFocus=()=>{activeElement=element};return element};
  const getControl=selector=>{if(!controls.has(selector))controls.set(selector,bindFocus(new Element()));return controls.get(selector)};
  getId('designPicker').querySelectorAll=()=>['closeDesignPicker','categoryNextap','categoryAnimated','categoryCustomized','categoryAll','designSearch','moreDesigns','retryDesigns','previewFront','previewBack','confirmDesign'].map(id=>bindFocus(getId(id)));
  for (const name of ['region','province','city','barangay']) getName(name).required = true;
  if ('storedCart' in options) storage.set('nextap_order_cart', options.storedCart);
  const form = getId('orderForm');
  form.payload = {customer_name: 'Sample Buyer', customer_email: 'buyer@example.com', customer_phone: '09123456789', street: '1 Sample Street', postal_code: '1000', address_label: 'Home', card_name: 'Sample', title_role: 'Designer', design_request: 'Blue logo on the front'};
  const context = vm.createContext({
    console: options.quietErrors ? {error() {}} : console,
    URLSearchParams,
    location: {search: options.search || ''},
    localStorage: {
      getItem: key => { if (options.storageError) throw new Error('Storage denied'); return storage.get(key) ?? null; },
      setItem: (key, value) => { if (options.storageError) throw new Error('Storage denied'); storage.set(key, value); }
    },
    document: {
      getElementById: id=>bindFocus(getId(id)),
      get activeElement(){return activeElement},body,
      querySelector: selector => { const match = selector.match(/^\[name="(.*)"\]$/); return match ? getName(match[1]) : getControl(selector); },
      querySelectorAll:selector=>selector==='header,main,#drawer,#modal'?background:[],
      addEventListener: (type, listener) => { (listeners[type] ||= []).push(listener); },
      createElement: tag => {
        const element = new Element();
        if (tag === 'canvas') {
          canvases.push(element);
          element.getContext = () => ({fillRect() {}, drawImage() {}});
          element.toDataURL = (_type, quality) => options.encode ? options.encode(element, quality) : 'data:image/jpeg;base64,/9j/AAAA';
        }
        return element;
      }
    },
    fetch: async (url, init) => {
      if (url.startsWith('/api/address')) { addressRequests.push(url); return options.addressFetch ? options.addressFetch(url) : {ok: true, json: async () => []}; }
      if(url==='/card-designs/catalog.json'){catalogRequests.push({url,init});if(options.catalogFetch)return options.catalogFetch(url,init);return {ok:options.catalogError?false:true,json:async()=>catalog};}
      requests.push({url, init, body: JSON.parse(init.body)});
      if (options.fetchError) throw new Error('Network unavailable');
      if (options.jsonError) return {ok: true, json: async () => { throw new Error('Invalid server response'); }};
      return {ok: options.orderError ? false : true, json: async () => options.orderError ? {error: options.orderError} : (options.orderResponse||{order_id: 'NX-TEST-001'})};
    },
    FormData: class { constructor(target) { this.payload = target.payload; } entries() { return Object.entries(this.payload); } },
    FileReader: class {
      readAsDataURL(file) { queueMicrotask(() => { if (file.readError) this.onerror(); else { this.result = 'data:image/png;base64,iVBORw0KGgo='; this.onload(); } }); }
    },
    Image: class {
      constructor() { this.naturalWidth = options.imageWidth || 1600; this.naturalHeight = options.imageHeight || 900; }
      set src(_value) { queueMicrotask(() => options.imageDecodeError ? this.onerror() : this.onload()); }
    },
    alert() {}
  });
  vm.runInContext(scripts(read('public/order.html'))[0], context);
  return {
    context, ids, names, storage, requests, addressRequests, catalogRequests, canvases, listeners, getId, getName,getControl,background,body,catalog,
    run: code => vm.runInContext(code, context),
    submit: async ({completeAddress=true,completeDesign=true} = {}) => {
      await new Promise(resolve=>setImmediate(resolve));
      if (completeAddress) for (const name of ['region','province','city','barangay']) {
        const select = getName(name);
        if (select.required===false || select.value) continue;
        const option = new Element();option.value = name==='region'?'1300000000':'sample-'+name;option.dataset.name = 'Sample '+name;
        select.appendChild(option);select.value = option.value;select.disabled = false;
      }
      if(completeDesign&&catalog?.length)vm.runInContext(`for(const item of cart)if(!item.custom&&!item.design_id)item.design_id=${JSON.stringify(catalog[0].id)}`,context);
      return form.onsubmit({preventDefault() {}, target: form});
    }
  };
}

test('all inline scripts in affected pages parse successfully', () => {
  for (const file of ['public/order.html', 'public/admin/index.html', 'public/admin/orders.html']) {
    scripts(read(file)).forEach((script, index) => assert.doesNotThrow(() => new vm.Script(script), `${file} script ${index + 1}`));
  }
});

test('corrupt or unavailable cart storage does not stop checkout initialization', () => {
  for (const storedCart of ['{broken', '{}', 'null', '[{"id":"missing","qty":2}]']) {
    const harness = checkoutHarness({storedCart});
    assert.equal(harness.run('cart.length'), 0);
    assert.equal(harness.getId('total').textContent, '₱0');
  }
  assert.doesNotThrow(() => checkoutHarness({storageError: true, search: '?plan=elite'}));
});

test('cart recovery keeps valid plans, merges duplicates, and bounds integer quantities', () => {
  const storedCart = JSON.stringify([{id:'elite',qty:99,custom:true},{id:'elite',qty:4,custom:true},{id:'basic',qty:200,custom:false},{id:'premium',qty:1.5},{id:'basic',qty:-1},{id:'fake',qty:1},null]);
  const harness = checkoutHarness({storedCart});
  assert.deepEqual(JSON.parse(harness.run('JSON.stringify(cart)')), [{id:'elite',qty:99,custom:true},{id:'basic',qty:99,custom:false}]);
  assert.equal(harness.run('total()'), (499 + 49) * 99 + 199 * 99);
  harness.run('draft.elite=99');
  harness.listeners.click[0]({target:{dataset:{inc:'elite'}}});
  assert.equal(harness.run('draft.elite'), 99);
  harness.getId('items').listeners.click[0]({target:{dataset:{ci:'0',dir:'1'}}});
  assert.equal(harness.run('cart[0].qty'), 99);
});

test('custom artwork labels and recovered carts use the current 49 peso add-on per card', async () => {
  const html=read('public/order.html');
  assert.doesNotMatch(html,/₱69/);
  assert.match(html,/optional ₱49 add-on per card/);
  const harness=checkoutHarness({storedCart:JSON.stringify(['basic','premium','elite'].map(id=>({id,qty:2,custom:true,custom_design_fee:69})))});
  await settleCheckout();
  assert.equal(harness.run('total()'),(199+49)*2+(299+49)*2+(499+49)*2);
  assert.match(harness.getId('plans').innerHTML,/Custom design \(\+₱49\)/);
  const checkbox=harness.getControl('[data-custom="basic"]');checkbox.checked=true;checkbox.dataset.custom='basic';
  harness.listeners.change[0]({target:checkbox});assert.equal(harness.getId('design-choice-basic').textContent,'Custom design (+₱49 / card)');
  assert.deepEqual(JSON.parse(harness.run('JSON.stringify(cart)')),['basic','premium','elite'].map(id=>({id,qty:2,custom:true})));
  await harness.submit({completeDesign:false});
  assert.deepEqual(harness.requests[0].body.items.map(item=>item.unit_price),[199,299,499]);
  assert.ok(harness.requests[0].body.items.every(item=>item.custom_design_fee===49));
  assert.equal(harness.requests[0].body.subtotal,2288);assert.equal(harness.requests[0].body.shipping_fee,70);assert.equal(harness.requests[0].body.total,2358);
});

const settleCheckout=()=>new Promise(resolve=>setImmediate(resolve));
test('homepage design links preselect trusted artwork for plans without adding or changing saved cart items', async () => {
  const catalog=JSON.parse(read('public/card-designs/catalog.json'));
  const storedCart=JSON.stringify([{id:'elite',qty:3,custom:true},{id:'basic',qty:2,custom:false,design_id:'A1'}]);
  for(const search of ['?design=N1','?plan=premium&design=PN7']){
    const harness=checkoutHarness({search,catalog,storedCart});await settleCheckout();
    assert.equal(harness.run('JSON.stringify(cart)'),storedCart);
    assert.equal(harness.storage.get('nextap_order_cart'),storedCart);
    assert.equal(harness.requests.length,0);
    const chosen=search.includes('PN7')?'PN7':'N1';
    assert.equal(harness.run('draftDesigns.premium'),chosen);
    assert.equal(harness.run('draftDesigns.basic'),search.includes('plan=premium')?'':chosen);
    assert.match(harness.getId('linkedDesignNote').textContent,/Choose your plan/);
    harness.listeners.click[0]({target:{dataset:{add:'premium'}}});
    assert.equal(harness.run('cart[2].design_id'),chosen);
    assert.equal(harness.run('cart[2].custom'),false);
    assert.equal(harness.run('total()'),(499+49)*3+199*2+299);
  }
});
test('unavailable or unsafe linked design IDs cannot alter a saved cart or select artwork', async () => {
  const storedCart=JSON.stringify([{id:'basic',qty:4,custom:false,design_id:'A1'}]);
  for(const design of ['A99','../../private','<img src=x onerror=alert(1)>','']){
    const harness=checkoutHarness({search:'?plan=elite&design='+encodeURIComponent(design),storedCart});await settleCheckout();
    assert.equal(harness.run('JSON.stringify(cart)'),storedCart);
    assert.deepEqual(JSON.parse(harness.run('JSON.stringify(draftDesigns)')),{basic:'',premium:'',elite:''});
    assert.match(harness.getId('linkedDesignNote').textContent,/unavailable/);
    assert.equal(harness.requests.length,0);
  }
});
const visibleDesignCount=harness=>(harness.getId('designGrid').innerHTML.match(/data-design-id=/g)||[]).length;
const categoryDesign=(id,category)=>({id,label:id,category,front:'/card-designs/'+id.toLowerCase()+'-abc123-front.webp',back:'/card-designs/'+id.toLowerCase()+'-abc123-back.webp',thumbnail:'/card-designs/'+id.toLowerCase()+'-abc123-thumb.webp'});

test('new design picker defaults to Nextap Design with N1 first and every category button in the requested order', async () => {
  const catalog=JSON.parse(read('public/card-designs/catalog.json')),harness=checkoutHarness({catalog});await settleCheckout();
  for(const plan of ['basic','premium','elite']){
    harness.run(`openDesignPicker('${plan}')`);
    assert.equal(harness.run('designPickerContext.category'),'nextap');
    assert.equal(harness.getId('categoryNextap').getAttribute('aria-pressed'),'true');
    assert.equal(harness.getId('categoryAnimated').getAttribute('aria-pressed'),'false');
    assert.equal(harness.getId('categoryCustomized').getAttribute('aria-pressed'),'false');
    assert.equal(visibleDesignCount(harness),12);
    assert.equal(harness.getId('designGrid').innerHTML.match(/data-design-id="([^"]+)"/)[1],'N1');
    assert.doesNotMatch(harness.getId('designGrid').innerHTML,/data-design-id="(?:A|Q|C)\d+"/);
    harness.getId('closeDesignPicker').onclick();
  }
  const html=read('public/order.html');
  assert.match(html,/role="group" aria-label="Design category"/);
  const positions=['categoryNextap','categoryAnimated','categoryCustomized','categoryAll'].map(id=>html.indexOf('id="'+id+'"'));
  assert.ok(positions.every((position,index)=>position>=0&&(index===0||position>positions[index-1])));
});

test('category filtering precedes search and pagination while switching retains focus and the chosen preview', async () => {
  const catalog=[...Array.from({length:25},(_,index)=>categoryDesign('A'+(index+1),'animated')),...Array.from({length:16},(_,index)=>categoryDesign('N'+(index+1),'nextap')),categoryDesign('C1','customized')];
  const harness=checkoutHarness({catalog});await settleCheckout();harness.run(`openDesignPicker('basic')`);
  assert.equal(visibleDesignCount(harness),12);harness.getId('moreDesigns').onclick();assert.equal(visibleDesignCount(harness),16);
  const animatedButton=harness.getId('categoryAnimated');animatedButton.focus();animatedButton.onclick();
  assert.equal(harness.context.document.activeElement,animatedButton);
  assert.equal(harness.run('designPickerContext.limit'),12);assert.equal(visibleDesignCount(harness),12);
  harness.getId('designSearch').value='A20';harness.getId('designSearch').listeners.input[0]();
  assert.equal(visibleDesignCount(harness),1);harness.run(`chooseDesign('A20')`);
  harness.getId('categoryNextap').onclick();
  assert.equal(visibleDesignCount(harness),0,'A20 must not leak into the Nextap category');
  assert.equal(harness.getId('designSearch').value,'A20');
  assert.equal(harness.run('designPickerContext.selectedId'),'A20');
  assert.equal(harness.getId('previewDesignImage').alt,'Design A20 front');
  assert.equal(harness.getId('confirmDesign').disabled,false);
  harness.getId('designSearch').value='';harness.getId('designSearch').listeners.input[0]();
  harness.getId('categoryAll').onclick();
  assert.equal(visibleDesignCount(harness),12);assert.equal(harness.getId('designGrid').innerHTML.match(/data-design-id="([^"]+)"/)[1],'N1');
  harness.getId('moreDesigns').onclick();assert.equal(visibleDesignCount(harness),24);
  harness.getId('categoryCustomized').onclick();assert.equal(visibleDesignCount(harness),1);
  assert.equal(harness.run('designPickerContext.limit'),12);
  assert.equal(harness.run('cart.length'),0,'category switches do not assign artwork to the cart');
});

test('editing a saved design opens its own category and reveals a selected design beyond the first page', async () => {
  const catalog=JSON.parse(read('public/card-designs/catalog.json'));
  for(const [id,category] of [['PN7','nextap'],['A20','animated'],['C4','customized']]){
    const harness=checkoutHarness({catalog,storedCart:JSON.stringify([{id:'premium',qty:2,custom:false,design_id:id}])});await settleCheckout();
    const before=harness.run('JSON.stringify(cart)');harness.getId('items').listeners.click[0]({target:{dataset:{editDesign:'0'}}});
    assert.equal(harness.run('designPickerContext.category'),category);
    assert.match(harness.getId('designGrid').innerHTML,new RegExp('data-design-id="'+id+'" aria-pressed="true"'));
    assert.equal(harness.getId('previewDesignName').textContent,'Design '+id);
    assert.equal(harness.run('JSON.stringify(cart)'),before);
    if(id==='A20')assert.equal(harness.run('designPickerContext.limit'),24);
    harness.getId('closeDesignPicker').onclick();harness.run(`openDesignPicker('premium')`);
    assert.equal(harness.run('designPickerContext.category'),'nextap','a new plan picker resets to Nextap');
  }
});

test('cached catalogs infer legacy series categories while unsupported explicit categories are rejected', async () => {
  const catalog=['N1','PN1','A1','Q1','C1'].map(id=>{const design=categoryDesign(id);delete design.category;return design});
  const harness=checkoutHarness({catalog,storedCart:'[{"id":"basic","qty":1,"custom":false,"design_id":"C1"}]'});await settleCheckout();
  assert.equal(harness.run('designCatalogStatus'),'ready');
  for(const [id,category] of [['N1','nextap'],['PN1','nextap'],['A1','animated'],['Q1','animated'],['C1','customized']])assert.equal(harness.run(`findDesign('${id}').category`),category);
  harness.run(`openDesignPicker('basic',null,{cartIndex:0})`);assert.equal(harness.run('designPickerContext.category'),'customized');
  for(const category of ['unknown','all',null,{}]){
    const invalid=checkoutHarness({catalog:[categoryDesign('N1',category)],storedCart:'[{"id":"basic","qty":2,"custom":false,"design_id":"N1"}]'});await settleCheckout();
    assert.equal(invalid.run('designCatalogStatus'),'error');assert.equal(invalid.run('cart[0].qty'),2);
  }
});

test('Customized Design category uses normal premade pricing and sends C design IDs without the custom artwork fee', async () => {
  const catalog=JSON.parse(read('public/card-designs/catalog.json')),harness=checkoutHarness({catalog});await settleCheckout();
  for(const plan of ['basic','premium','elite']){
    harness.run(`openDesignPicker('${plan}',null,{add:true})`);harness.getId('categoryCustomized').onclick();
    assert.equal(visibleDesignCount(harness),4);harness.run(`chooseDesign('C2');confirmDesignSelection()`);
  }
  assert.equal(harness.run('total()'),199+299+499);
  assert.equal(harness.run('cart.every(item=>!item.custom&&item.design_id==="C2")'),true);
  await harness.submit({completeDesign:false});
  const payload=harness.requests[0].body;
  for(const item of payload.items){assert.equal(item.design_id,'C2');assert.equal(item.custom_design,false);assert.equal(item.custom_design_fee,0);assert.equal('category' in item,false);}
  assert.equal(payload.subtotal,997);assert.equal(payload.shipping_fee,70);assert.equal(payload.total,1067);
});

test('design gallery loads twelve at a time, searches by code, and previews matching front and back', async () => {
  const harness=checkoutHarness();await settleCheckout();
  harness.run(`openDesignPicker('basic');setDesignCategory('all')`);
  assert.equal(visibleDesignCount(harness),12);
  assert.equal(harness.getId('moreDesigns').hidden,false);
  assert.equal(harness.getId('designPickerTitle').textContent,'Choose a design · Basic Card');
  harness.getId('moreDesigns').onclick();assert.equal(visibleDesignCount(harness),24);
  harness.getId('moreDesigns').onclick();assert.equal(visibleDesignCount(harness),36);
  assert.equal(harness.getId('moreDesigns').hidden,true);
  harness.getId('designSearch').value='a13';harness.getId('designSearch').listeners.input[0]();
  assert.equal(visibleDesignCount(harness),1);
  assert.match(harness.getId('designGrid').innerHTML,/data-design-id="A13"/);
  harness.getId('designGrid').listeners.click[0]({target:{closest:()=>({dataset:{designId:'A13'}})}});
  assert.equal(harness.getId('previewDesignImage').src,'/card-designs/a13-abc123-front.webp');
  assert.equal(harness.getId('previewDesignImage').alt,'Design A13 front');
  harness.getId('previewBack').onclick();
  assert.equal(harness.getId('previewDesignImage').src,'/card-designs/a13-abc123-back.webp');
  assert.equal(harness.getId('previewBack').getAttribute('aria-pressed'),'true');
  assert.equal(harness.getId('previewFront').getAttribute('aria-pressed'),'false');
  harness.getId('previewFront').onclick();assert.equal(harness.getId('previewDesignImage').alt,'Design A13 front');
  harness.getId('designSearch').value='no-match';harness.getId('designSearch').listeners.input[0]();
  assert.equal(visibleDesignCount(harness),0);
  assert.equal(harness.getId('designStatus').textContent,'No designs match this code.');
  assert.equal(harness.getId('confirmDesign').disabled,false,'search does not discard an explicitly selected design');
  assert.equal(harness.catalogRequests[0].init.credentials,'same-origin');
});

test('every catalog design remains selectable for every plan across category filters', async () => {
  const harness=checkoutHarness();await settleCheckout();
  for(const plan of ['basic','premium','elite']){
    harness.run(`openDesignPicker('${plan}',null,{add:true});setDesignCategory('animated');chooseDesign('A20');confirmDesignSelection()`);
  }
  assert.deepEqual(JSON.parse(harness.run('JSON.stringify(cart)')),[
    {id:'basic',qty:1,custom:false,design_id:'A20'},
    {id:'premium',qty:1,custom:false,design_id:'A20'},
    {id:'elite',qty:1,custom:false,design_id:'A20'}
  ]);
  assert.equal(harness.run('total()'),199+299+499);
  assert.equal(harness.requests.length,0);
});

test('bundled catalog loads all complete pairs and offers the same collection for each plan', async () => {
  const catalog=JSON.parse(read('public/card-designs/catalog.json'));
  const harness=checkoutHarness({catalog});await settleCheckout();
  assert.equal(harness.run('designCatalog.length'),36);
  assert.equal(harness.run('Boolean(findDesign("A13")&&findDesign("A20"))'),true);
  assert.equal(harness.run('Boolean(findDesign("A6"))'),false);
  for(const plan of ['basic','premium','elite']){
    harness.run(`openDesignPicker('${plan}');setDesignCategory('all');designPickerContext.limit=100;renderDesignGallery()`);
    assert.equal(visibleDesignCount(harness),catalog.length);
    for(const design of catalog)assert.ok(harness.getId('designGrid').innerHTML.includes('data-design-id="'+design.id+'"'));
    harness.getId('closeDesignPicker').onclick();
  }
});

test('new premade Add to Cart opens the picker and adds only the explicitly confirmed design', async () => {
  const harness=checkoutHarness();await settleCheckout();
  harness.run('draft.basic=2');
  harness.listeners.click[0]({target:{dataset:{add:'basic'}}});
  assert.equal(harness.run('cart.length'),0);
  assert.equal(harness.getId('designPicker').classList.contains('on'),true);
  assert.equal(harness.getId('confirmDesign').disabled,true);
  harness.run(`chooseDesign('A1');confirmDesignSelection()`);
  assert.equal(harness.run('cart[0].design_id'),'A1');assert.equal(harness.run('cart[0].qty'),2);
  assert.equal(harness.getId('designPicker').hidden,true);
  assert.match(harness.getId('items').innerHTML,/Design A1/);
  assert.match(harness.getId('items').innerHTML,/a1-abc123-thumb\.webp/);
  harness.listeners.click[0]({target:{dataset:{add:'basic'}}});
  assert.equal(harness.run('cart[0].qty'),3,'later adds reuse the explicitly selected plan design');
  assert.equal(harness.run('cart.length'),1);
});

test('cart keeps different designs separate, preserves legacy entries, and merges only identical variants', async () => {
  const harness=checkoutHarness({storedCart:JSON.stringify([
    {id:'basic',qty:2,custom:false,design_id:'A1',design_label:'Forged label',thumbnail:'https://evil.test/art'},
    {id:'basic',qty:3,custom:false,design_id:'A2'},
    {id:'basic',qty:4,custom:false,design_id:'A1'},
    {id:'basic',qty:1,custom:false},
    {id:'basic',qty:1,custom:true,design_id:'A2'}
  ])});await settleCheckout();
  assert.deepEqual(JSON.parse(harness.run('JSON.stringify(cart)')),[
    {id:'basic',qty:6,custom:false,design_id:'A1'},
    {id:'basic',qty:3,custom:false,design_id:'A2'},
    {id:'basic',qty:1,custom:false},
    {id:'basic',qty:1,custom:true}
  ]);
  assert.doesNotMatch(harness.getId('items').innerHTML,/Forged label|evil\.test/);
  harness.getId('items').listeners.click[0]({target:{dataset:{editDesign:'2'}}});
  harness.run(`chooseDesign('A2');confirmDesignSelection()`);
  assert.equal(harness.run('cart.length'),3);
  assert.equal(harness.run('cart[1].qty'),4);
  assert.equal(harness.run('cart[1].design_id'),'A2');
  assert.equal(harness.run('total()'),199*10+248);
});

test('editing a design merges up to 99 cards and blocks overflow without dropping either cart line', async () => {
  assert.match(read('public/order.html'),/<div class="error" id="designPickerError" role="alert"><\/div>/);
  for(const [existingQuantity,blocked] of [[97,false],[98,true],[99,true]]){
    const harness=checkoutHarness({storedCart:JSON.stringify([{id:'basic',qty:existingQuantity,custom:false,design_id:'A1'},{id:'basic',qty:2,custom:false,design_id:'A2'}])});await settleCheckout();
    const before=harness.run('JSON.stringify(cart)'),subtotal=harness.run('total()');
    harness.run(`openDesignPicker('basic',null,{cartIndex:1});chooseDesign('A1');confirmDesignSelection()`);
    if(blocked){
      assert.equal(harness.run('JSON.stringify(cart)'),before);
      assert.equal(harness.run('total()'),subtotal);
      assert.equal(harness.getId('designPicker').hidden,false);
      assert.equal(harness.getId('designPickerError').classList.contains('on'),true);
      assert.match(harness.getId('designPickerError').textContent,/exceed 99 cards.*reduce the cart quantities/);
      harness.run(`chooseDesign('A2')`);assert.equal(harness.getId('designPickerError').classList.contains('on'),false);
      harness.getId('closeDesignPicker').onclick();
      harness.getId('items').listeners.click[0]({target:{dataset:{ci:'0',dir:'-1'}}});
      harness.getId('items').listeners.click[0]({target:{dataset:{ci:'0',dir:'-1'}}});
      harness.run(`openDesignPicker('basic',null,{cartIndex:1});chooseDesign('A1');confirmDesignSelection()`);
      assert.equal(harness.run('cart.length'),1);
      assert.equal(harness.run('cart[0].qty'),existingQuantity);
    }else{
      assert.equal(harness.run('cart.length'),1);assert.equal(harness.run('cart[0].qty'),99);
      assert.equal(harness.run('total()'),subtotal);assert.equal(harness.getId('designPicker').hidden,true);
    }
  }
});

test('legacy plan links and stale saved designs require selection without losing cart quantities', async () => {
  for(const options of [{search:'?plan=elite'},{storedCart:'[{"id":"basic","qty":4,"custom":false,"design_id":"A99"}]'}]){
    const harness=checkoutHarness(options);await settleCheckout();
    const before=harness.run('JSON.stringify(cart)');harness.getId('checkout').onclick();
    assert.equal(harness.getId('designPicker').classList.contains('on'),true);
    assert.equal(harness.run('JSON.stringify(cart)'),before);
    assert.equal(harness.getId('confirmDesign').disabled,true);
    harness.getId('closeDesignPicker').onclick();
    await harness.submit({completeDesign:false});
    assert.match(harness.getId('error').textContent,/choose an available card design/);
    assert.equal(harness.requests.length,0);
    assert.equal(harness.run('JSON.stringify(cart)'),before);
    harness.run(`openDesignPicker(cart[0].id,null,{cartIndex:0});chooseDesign('A1');confirmDesignSelection()`);
    assert.equal(harness.run('cart[0].design_id'),'A1');
    await harness.submit({completeDesign:false});assert.equal(harness.requests.length,1);
  }
});

test('catalog loading and retry errors keep saved designs and cart data intact', async () => {
  let finishFirst,calls=0;const harness=checkoutHarness({storedCart:'[{"id":"basic","qty":2,"custom":false,"design_id":"A1"}]',catalogFetch:()=>{
    calls++;if(calls===1)return new Promise(resolve=>finishFirst=resolve);
    return {ok:true,json:async()=>harness.catalog};
  }});
  harness.run(`openDesignPicker('basic',null,{cartIndex:0})`);
  assert.equal(harness.getId('designStatus').textContent,'Loading card designs…');
  assert.equal(harness.getId('confirmDesign').disabled,true);
  assert.equal(harness.run('cart[0].design_id'),'A1');
  finishFirst({ok:false});await settleCheckout();
  assert.match(harness.getId('designStatus').textContent,/Unable to load card designs.*cart is saved/);
  assert.equal(harness.getId('retryDesigns').hidden,false);
  await harness.submit({completeDesign:false});
  assert.equal(harness.requests.length,0);assert.match(harness.getId('error').textContent,/Unable to load card designs/);
  await harness.getId('retryDesigns').onclick();
  assert.equal(harness.getId('retryDesigns').hidden,true);
  assert.equal(harness.getId('confirmDesign').disabled,false);
  assert.equal(harness.run('cart[0].qty'),2);
  assert.equal(harness.run('cart[0].design_id'),'A1');
});

test('catalog text is escaped and remote, malformed, or duplicate artwork cannot enter the gallery', async () => {
  const good={id:'A1',label:'<img src=x onerror=alert(1)>',front:'/card-designs/a1-front.webp',back:'/card-designs/a1-back.webp',thumbnail:'/card-designs/a1-thumb.webp'};
  const harness=checkoutHarness({catalog:[good]});await settleCheckout();harness.run(`openDesignPicker('basic');setDesignCategory('animated')`);
  assert.match(harness.getId('designGrid').innerHTML,/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(harness.getId('designGrid').innerHTML,/<img src=x/);
  for(const catalog of [[{...good,front:'https://evil.test/front.webp'}],[{...good,back:'javascript:alert(1)'}],[{...good,id:'"><svg/onload=alert(1)>'}],[good,good]]){
    const bad=checkoutHarness({catalog,storedCart:'[{"id":"basic","qty":2,"custom":false,"design_id":"A1"}]'});await settleCheckout();bad.run(`openDesignPicker('basic')`);
    assert.equal(bad.run('designCatalogStatus'),'error');
    assert.equal(visibleDesignCount(bad),0);
    assert.equal(bad.run('cart[0].qty'),2);
  }
});

test('custom design remains available during catalog failure and payload sends only trusted premade IDs', async () => {
  const custom=checkoutHarness({catalogError:true});await settleCheckout();
  const check=custom.getControl('[data-custom="basic"]');check.checked=true;check.dataset.custom='basic';
  custom.listeners.change[0]({target:check});
  assert.equal(custom.getId('choose-design-basic').disabled,true);
  assert.match(custom.getId('design-choice-basic').textContent,/Custom design/);
  custom.listeners.click[0]({target:{dataset:{add:'basic'}}});
  assert.deepEqual(JSON.parse(custom.run('JSON.stringify(cart)')),[{id:'basic',qty:1,custom:true}]);
  await custom.submit({completeDesign:false});
  assert.equal(custom.requests[0].body.items[0].custom_design_fee,49);
  assert.equal('design_id' in custom.requests[0].body.items[0],false);
  const mixed=checkoutHarness({storedCart:JSON.stringify([{id:'elite',qty:2,custom:false,design_id:'A2',design_name:'forged',front:'https://evil.test'},{id:'basic',qty:1,custom:true}])});
  await mixed.submit({completeDesign:false});
  const payload=mixed.requests[0].body;
  assert.equal(payload.items[0].design_id,'A2');
  assert.equal('design_name' in payload.items[0],false);assert.equal('front' in payload.items[0],false);
  assert.equal(payload.subtotal,499*2+199+49);assert.equal(payload.shipping_fee,70);
  assert.equal(payload.total,499*2+199+49+70);
});

test('design dialog traps keyboard focus and restores the opener and background state on Escape', async () => {
  const harness=checkoutHarness();await settleCheckout();
  const opener=harness.getControl('design-opener');opener.focus();
  harness.background[0].inert=true;harness.background[1].inert=false;harness.body.style.overflow='auto';
  harness.run(`openDesignPicker('basic')`);
  assert.ok(harness.background.every(element=>element.inert===true));
  assert.equal(harness.context.document.activeElement,harness.getId('designSearch'));
  harness.run(`chooseDesign('A1')`);assert.equal(harness.context.document.activeElement,harness.getId('previewFront'));
  harness.getId('confirmDesign').focus();let prevented=0;
  harness.listeners.keydown[0]({key:'Tab',preventDefault(){prevented++}});
  assert.equal(harness.context.document.activeElement,harness.getId('closeDesignPicker'));
  harness.listeners.keydown[0]({key:'Tab',shiftKey:true,preventDefault(){prevented++}});
  assert.equal(harness.context.document.activeElement,harness.getId('confirmDesign'));
  harness.listeners.keydown[0]({key:'Escape',preventDefault(){prevented++}});
  assert.equal(prevented,3);assert.equal(harness.getId('designPicker').hidden,true);
  assert.equal(harness.context.document.activeElement,opener);
  assert.equal(harness.background[0].inert,true);assert.equal(harness.background[1].inert,false);
  assert.equal(harness.body.style.overflow,'auto');
});

test('shipping recognizes canonical and legacy region codes across Luzon, Visayas, and Mindanao', () => {
  const harness = checkoutHarness();
  for (const prefix of ['01','02','03','04','05','13','14','17']) {
    assert.equal(harness.run(`shippingFee('${prefix}00000000')`),70,prefix);
    assert.equal(harness.run(`shippingFee('${prefix}0000000')`),70,'legacy '+prefix);
  }
  for (const prefix of ['06','07','08','18','09','10','11','12','15','16','19']) {
    assert.equal(harness.run(`shippingFee('${prefix}00000000')`),99,prefix);
    assert.equal(harness.run(`shippingFee('${prefix}0000000')`),99,'legacy '+prefix);
  }
  for (const value of ['', 'NCR','Visayas','2000000000','0000000000','1300000001','1380600000','13000000','13000000000',' 1300000000','1300000000 ']) {
    assert.equal(harness.run(`shippingFee(${JSON.stringify(value)})`),null,value);
  }
});

test('checkout shipping matches the server for every accepted region and both code formats', () => {
  const shippingSource=read('src/index.js').match(/function shippingForRegion\(value\) \{[\s\S]*?\n\}/)[0];
  const serverShipping=vm.runInNewContext('('+shippingSource+')',{RequestError:class extends Error {}});
  const harness=checkoutHarness();
  for(let prefix=1;prefix<=19;prefix++)for(const zeros of [7,8]){
    const region=String(prefix).padStart(2,'0')+'0'.repeat(zeros);
    const server=serverShipping(region);
    assert.equal(harness.run(`shippingFee('${region}')`),server.shipping_fee,region);
    assert.equal(server.delivery_region_code,region.slice(0,2)+'00000000');
  }
  for(const region of ['','2000000000','1300000001','1380600000','NCR']){
    assert.throws(()=>serverShipping(region),/valid delivery region/);
    assert.equal(harness.run(`shippingFee(${JSON.stringify(region)})`),null);
  }
});

test('checkout shows item subtotal and waits for a selected delivery region before showing a grand total', () => {
  const harness = checkoutHarness({storedCart:'[{"id":"basic","qty":2,"custom":false}]'});
  harness.getId('checkout').onclick();
  assert.equal(harness.getId('total').textContent,'₱398');
  assert.equal(harness.getId('checkoutSubtotal').textContent,'₱398');
  assert.equal(harness.getId('checkoutShipping').textContent,'Select delivery region');
  assert.equal(harness.getId('checkoutGrandTotal').textContent,'Select delivery region');
  assert.equal(harness.getId('submitTotal').textContent,'Select delivery region');
});

test('shipping stays per order while custom card and cart quantity changes update the grand total', async () => {
  const harness = checkoutHarness({storedCart:JSON.stringify([{id:'premium',qty:2,custom:true},{id:'basic',qty:3,custom:false}])});
  await harness.run('loadRegions()');
  harness.getName('region').value='1300000000';
  await harness.run('loadProvinces()');
  assert.equal(harness.getId('checkoutSubtotal').textContent,'₱1,293');
  assert.equal(harness.getId('checkoutShipping').textContent,'₱70');
  assert.equal(harness.getId('checkoutGrandTotal').textContent,'₱1,363');
  harness.getId('items').listeners.click[0]({target:{dataset:{ci:'0',dir:'1'}}});
  assert.equal(harness.getId('checkoutSubtotal').textContent,'₱1,641');
  assert.equal(harness.getId('checkoutShipping').textContent,'₱70');
  assert.equal(harness.getId('submitTotal').textContent,'₱1,711');
  harness.getName('region').value='0700000000';
  await harness.run('loadProvinces()');
  assert.equal(harness.getId('checkoutShipping').textContent,'₱99');
  assert.equal(harness.getId('checkoutGrandTotal').textContent,'₱1,740');
  harness.getName('region').value='1100000000';
  for (const listener of harness.getName('barangay').listeners.change) listener();
  assert.equal(harness.getId('checkoutShipping').textContent,'₱99');
  assert.equal(harness.getId('submitTotal').textContent,'₱1,740');
  harness.getName('region').value='';
  await harness.run('loadProvinces()');
  assert.equal(harness.getId('checkoutShipping').textContent,'Select delivery region');
  assert.equal(harness.getId('submitTotal').textContent,'Select delivery region');
});

test('checkout sends the selected delivery region and one shipping fee for all cards', async () => {
  for (const [region,fee] of [['1300000000',70],['0700000000',99],['1100000000',99]]) {
    const harness = checkoutHarness({storedCart:'[{"id":"basic","qty":3,"custom":true}]'});
    await harness.run('loadRegions()');
    harness.getName('region').value=region;
    await harness.submit();
    const payload=harness.requests[0].body;
    assert.equal(payload.delivery_region_code,region);
    assert.equal(payload.subtotal,(199+49)*3);
    assert.equal(payload.shipping_fee,fee);
    assert.equal(payload.total,(199+49)*3+fee);
    assert.equal(payload.items[0].custom_design_fee,49);
    assert.equal(payload.items[0].quantity,3);
  }
});

test('checkout rejects unknown or non-region codes instead of charging a guessed shipping fee', async () => {
  for (const region of ['2000000000','1380600000','NCR']) {
    const harness = checkoutHarness({search:'?plan=basic'});
    await harness.run('loadRegions()');
    harness.getName('region').value=region;
    await harness.submit();
    assert.equal(harness.requests.length,0);
    assert.match(harness.getId('error').textContent,/select a valid delivery region/);
    assert.equal(harness.getId('submit').disabled,false);
    assert.equal(harness.getId('checkoutShipping').textContent,'Select delivery region');
    assert.equal(harness.run('cart.length'),1);
  }
});

test('changing delivery region while the custom image is prepared requires reviewing the new total', async () => {
  let harness;
  harness=checkoutHarness({storedCart:'[{"id":"basic","qty":1,"custom":true}]',encode:()=>{
    harness.getName('region').value='0700000000';
    return 'data:image/jpeg;base64,/9j/AAAA';
  }});
  harness.getId('designImage').files=[{size:100,type:'image/png'}];
  await harness.submit();
  assert.equal(harness.requests.length,0);
  assert.match(harness.getId('error').textContent,/delivery address changed/);
  assert.equal(harness.getId('checkoutShipping').textContent,'₱99');
  assert.equal(harness.getId('checkoutGrandTotal').textContent,'₱347');
  assert.equal(harness.getId('submit').disabled,false);
  assert.equal(harness.run('cart.length'),1);
});

test('order confirmation shows the saved server amounts and omits invalid or incomplete receipts', async () => {
  for (const [amounts,hidden] of [
    [{subtotal:199,shipping_fee:70,total:269},false],
    [{subtotal:199,shipping_fee:99,total:298},false],
    [{subtotal:199,shipping_fee:99,total:269},true],
    [{subtotal:'199',shipping_fee:70,total:269},true],
    [{subtotal:199,shipping_fee:-1,total:198},true],
    [{},true]
  ]) {
    const harness=checkoutHarness({search:'?plan=basic',orderResponse:{order_id:'NX-CONFIRMED',...amounts}});
    await harness.submit();
    assert.equal(harness.getId('confirmedAmounts').hidden,hidden);
    if(!hidden){
      assert.equal(harness.getId('confirmedSubtotal').textContent,'₱199');
      assert.equal(harness.getId('confirmedShipping').textContent,'₱'+amounts.shipping_fee);
      assert.equal(harness.getId('confirmedGrandTotal').textContent,'₱'+amounts.total);
    }
    assert.equal(harness.getId('successView').classList.contains('on'),true);
    assert.equal(harness.run('cart.length'),0);
  }
});

test('address labels and values stay text even when the upstream data contains HTML', () => {
  const harness = checkoutHarness();
  harness.run(`fillSelect(provinceEl, [{name:'<img src=x onerror=alert(1)>',code:'" value="bad'},null], 'Select province')`);
  const option = harness.getName('province').children[1];
  assert.equal(option.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(option.value, '" value="bad');
  assert.equal(option.innerHTML, '');
  assert.equal(harness.getName('province').children.length, 2);
});

test('regions without provinces load their cities and barangays and submit a complete address', async () => {
  const harness = checkoutHarness({storedCart:'[{"id":"basic","qty":1,"custom":false}]', addressFetch:async url => {
    const endpoint = new URL(url,'https://nextap.test');
    const data = endpoint.pathname.endsWith('/regions') ? [{name:'NCR',code:'1300000000'}]
      : endpoint.pathname.endsWith('/provinces') ? []
      : endpoint.pathname.endsWith('/cities') ? [{name:'Manila',code:'1380600000'}]
      : [{name:'Barangay 1',code:'1380601000'}];
    return {ok:true,json:async()=>data};
  }});
  await harness.run('loadRegions()');
  harness.getName('region').value = '1300000000';
  await harness.run('loadProvinces()');
  assert.equal(harness.getName('province').disabled,true);
  assert.equal(harness.getName('province').required,false);
  assert.equal(harness.getName('province').children[0].textContent,'Not applicable');
  assert.equal(harness.getName('city').disabled,false);
  assert.equal(harness.getName('city').required,true);
  assert.equal(harness.getName('city').children[1].textContent,'Manila');
  harness.getName('city').value = '1380600000';
  await harness.run('loadBarangays()');
  assert.equal(harness.getName('barangay').disabled,false);
  assert.equal(harness.getName('barangay').required,true);
  harness.getName('barangay').value = '1380601000';
  assert.ok(harness.addressRequests.includes('/api/address/cities?region=1300000000'));
  assert.ok(harness.addressRequests.includes('/api/address/barangays?region=1300000000&city=1380600000'));
  await harness.submit();
  assert.equal(harness.requests[0].body.delivery_address,'1 Sample Street, Barangay 1, Manila, NCR, 1000, Home');
});

test('switching from a region without provinces restores province validation', async () => {
  const harness = checkoutHarness({addressFetch:async url => ({ok:true,json:async()=>url.includes('provinces?region=R2')?[{code:'P2',name:'Province 2'}]:[]})});
  await harness.run('loadRegions()');
  harness.getName('region').value = 'R1';
  await harness.run('loadProvinces()');
  assert.equal(harness.getName('province').required,false);
  harness.getName('region').value = 'R2';
  await harness.run('loadProvinces()');
  assert.equal(harness.getName('province').required,true);
  assert.equal(harness.getName('province').disabled,false);
  assert.equal(harness.getName('city').disabled,true);
  assert.equal(harness.getName('barangay').disabled,true);
});

test('stale province, city, and barangay responses cannot overwrite newer selections', async () => {
  for (const stage of ['provinces','cities','barangays']) {
    let finishOld;
    const harness = checkoutHarness({addressFetch:async url => {
      const endpoint = new URL(url,'https://nextap.test');
      if (!endpoint.pathname.endsWith('/'+stage)) return {ok:true,json:async()=>[]};
      const key = stage==='provinces'?'region':stage==='cities'?'province':'city';
      if (endpoint.searchParams.get(key)==='old') return new Promise(resolve=>finishOld=resolve);
      return {ok:true,json:async()=>[{code:'new-result',name:'New result'}]};
    }});
    await harness.run('loadRegions()');
    harness.getName('region').value = 'R';
    harness.getName('province').value = 'P';
    harness.getName('city').value = 'C';
    const changing = harness.getName(stage==='provinces'?'region':stage==='cities'?'province':'city');
    const result = harness.getName(stage==='provinces'?'province':stage==='cities'?'city':'barangay');
    const fn = stage==='provinces'?'loadProvinces()':stage==='cities'?'loadCities()':'loadBarangays()';
    changing.value = 'old';
    const oldRequest = harness.run(fn);
    changing.value = 'new';
    await harness.run(fn);
    finishOld({ok:true,json:async()=>[{code:'old-result',name:'Old result'}]});
    await oldRequest;
    assert.equal(result.children[1].value,'new-result',stage);
    assert.equal(result.children[1].textContent,'New result',stage);
  }
});

test('address failures keep the existing error labels and dependent selects disabled', async () => {
  const harness = checkoutHarness({quietErrors:true,addressFetch:async url=>url.endsWith('/regions')?{ok:true,json:async()=>[]}:{ok:false,status:503}});
  await harness.run('loadRegions()');
  harness.getName('region').value = 'R';
  await harness.run('loadProvinces()');
  assert.equal(harness.getName('province').children[0].textContent,'Unable to load provinces');
  assert.equal(harness.getName('province').disabled,true);
  assert.equal(harness.getName('province').required,true);
  await harness.run('loadCitiesForRegion()');
  assert.equal(harness.getName('city').children[0].textContent,'Unable to load cities / municipalities');
  assert.equal(harness.getName('city').disabled,true);
  harness.getName('city').value = 'C';
  await harness.run('loadBarangays()');
  assert.equal(harness.getName('barangay').children[0].textContent,'Unable to load barangays');
  assert.equal(harness.getName('barangay').disabled,true);
});

test('checkout rejects missing address selections even when disabled fields bypass native required checks', async () => {
  const harness = checkoutHarness({search:'?plan=basic'});
  await harness.submit({completeAddress:false});
  assert.match(harness.getId('error').textContent,/complete the delivery address selections/);
  assert.equal(harness.getId('submit').disabled,false);
  assert.equal(harness.requests.length,0);
  assert.equal(harness.run('cart.length'),1);
});

test('instruction-only custom checkout preserves details and clears cart immediately after success', async () => {
  const harness = checkoutHarness({storedCart: JSON.stringify([{id:'premium',qty:2,custom:true}])});
  await harness.submit();
  assert.equal(harness.requests[0].body.design_request, 'Blue logo on the front');
  assert.equal(harness.requests[0].body.items[0].custom_design_image, '');
  assert.equal(harness.requests[0].body.subtotal, (299 + 49) * 2);
  assert.equal(harness.requests[0].body.shipping_fee,70);
  assert.equal(harness.requests[0].body.total, (299 + 49) * 2 + 70);
  assert.equal(harness.storage.get('nextap_order_cart'), '[]');
  assert.equal(harness.getId('successView').classList.contains('on'), true);
  assert.equal(harness.getId('submit').disabled, false);
});

test('oversize, unreadable, and invalid images surface errors and always unlock submit', async () => {
  for (const scenario of [
    {file:{size:10*1024*1024+1,type:'image/png'}, message:/10 MB/},
    {file:{size:100,type:'image/svg+xml'}, message:/PNG, JPG, or WEBP/},
    {file:{size:100,type:'image/png',readError:true}, message:/Unable to read/},
    {file:{size:100,type:'image/png'}, imageDecodeError:true, message:/Unable to open/}
  ]) {
    const harness = checkoutHarness({storedCart:'[{"id":"basic","qty":1,"custom":true}]', imageDecodeError:scenario.imageDecodeError});
    harness.getId('designImage').files = [scenario.file];
    await harness.submit();
    assert.match(harness.getId('error').textContent, scenario.message);
    assert.equal(harness.getId('error').classList.contains('on'), true);
    assert.equal(harness.getId('submit').disabled, false);
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.run('cart.length'), 1);
  }
});

test('design references shrink to the encoded image budget and small images remain valid', async () => {
  const harness = checkoutHarness({storedCart:'[{"id":"elite","qty":1,"custom":true}]', encode:canvas => canvas.width>700 ? 'data:image/jpeg;base64,'+'A'.repeat(220000) : 'data:image/jpeg;base64,/9j/AAAA'});
  harness.getId('designImage').files = [{size:4*1024*1024,type:'image/png'}];
  await harness.submit();
  assert.equal(harness.requests.length, 1);
  assert.ok(harness.requests[0].body.items[0].custom_design_image.length <= 200*1024);
  assert.ok(harness.canvases[0].width <= 700);
  const tiny = checkoutHarness({imageWidth:64,imageHeight:32});
  const encoded = await tiny.run(`optimizeDesignImage({size:100,type:'image/png'})`);
  assert.match(encoded, /^data:image\/jpeg;base64,/);
  assert.equal(tiny.canvases[0].width, 64);
  assert.equal(tiny.canvases[0].height, 32);
});

test('server, network, and response parsing errors keep cart and unlock submit', async () => {
  for (const scenario of [{fetchError:true}, {jsonError:true}, {orderError:'The order could not be saved.'}]) {
    const harness = checkoutHarness({...scenario, search:'?plan=elite'});
    await harness.submit();
    assert.equal(harness.getId('error').classList.contains('on'), true);
    assert.equal(harness.getId('submit').disabled, false);
    assert.equal(harness.run('cart.length'), 1);
    assert.equal(harness.getId('successView').classList.contains('on'), false);
  }
});

function adminOrdersHarness(options = {}) {
  const ids = new Map(), listeners = {}, requests = [];
  const getId = id => { if (!ids.has(id)) ids.set(id, new Element()); return ids.get(id); };
  const context = vm.createContext({console,location:{href:''},document:{getElementById:getId,addEventListener:(type,fn)=>listeners[type]=fn},fetch:async (url, init) => {
    requests.push({url,init});
    if (init?.method==='PATCH') return {ok:false,status:403,json:async()=>({error:'Access denied'})};
    return {ok:true,json:async()=>options.orders||[]};
  }});
  vm.runInContext(scripts(read('public/admin/orders.html'))[0], context);
  return {context,getId,listeners,requests,run:code=>vm.runInContext(code,context)};
}

test('admin shows saved paired design snapshots and escapes IDs while rejecting unsafe artwork URLs', async () => {
  const orders=[{id:'NX-DESIGNS',created_at:'2026-10-03T01:00:00Z',customer_name:'Buyer',status:'new',items:[
    {plan:'Basic Card',quantity:2,design_id:'A1',design_version:'saved-version',design_front:'/card-designs/a1-old123-front.webp',design_back:'/card-designs/a1-old123-back.webp'},
    {plan:'Elite Card',quantity:1,design_id:'<svg onload=alert(1)>',design_version:'<script>bad</script>',design_front:'https://evil.test/front.webp',design_back:'javascript:alert(1)'}
  ]}];
  const harness=adminOrdersHarness({orders});await harness.run('load()');const html=harness.getId('list').innerHTML;
  assert.match(html,/Basic Card × 2 · Design A1 · saved-version/);
  assert.match(html,/href="\/card-designs\/a1-old123-front\.webp"/);
  assert.match(html,/href="\/card-designs\/a1-old123-back\.webp"/);
  assert.match(html,/Front preview/);assert.match(html,/Back preview/);
  assert.match(html,/&lt;svg onload=alert\(1\)&gt;/);assert.match(html,/&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(html,/<svg\b|<script>bad|evil\.test|javascript:/);
  assert.equal((html.match(/<img src="\/card-designs\//g)||[]).length,2);
});

test('admin pricing keeps stored zero shipping and escapes the shipping zone', () => {
  const harness=adminOrdersHarness();
  const legacy=harness.run(`renderPricing({subtotal:499,shipping_fee:0,shipping_zone:'',total:499})`);
  assert.match(legacy,/Subtotal: ₱499\.00/);
  assert.match(legacy,/Shipping: ₱0\.00/);
  assert.match(legacy,/Total: ₱499\.00/);
  assert.doesNotMatch(legacy,/₱(?:70|99)\.00/);
  const zero=harness.run(`renderPricing({subtotal:0,shipping_fee:0,shipping_zone:'',total:0})`);
  assert.match(zero,/Subtotal: ₱0\.00\nShipping: ₱0\.00\nTotal: ₱0\.00/);
  const malicious=harness.run(`renderPricing({subtotal:199,shipping_fee:99,shipping_zone:'<img src=x onerror=alert(1)>',total:298})`);
  assert.match(malicious,/Shipping \(&lt;img src=x onerror=alert\(1\)&gt;\): ₱99\.00/);
  assert.doesNotMatch(malicious,/<img\b/);
  assert.match(malicious,/Total: ₱298\.00/);
});

test('admin shows fulfillment details and only previews safe reference image URLs', async () => {
  const orders = [{id:'NX-1',created_at:'2026-10-01T12:00:00Z',customer_name:'Buyer',messenger:'buyer.page',whatsapp:'09123456789',viber:'09123456789',design_request:'Use <blue> logo',status:'new',items:[{plan:'Elite Card',quantity:1,custom_design:true,custom_design_image:'data:image/jpeg;base64,/9j/AAAA'},{plan:'Basic Card',quantity:1,custom_design:true,custom_design_image:'javascript:alert(1)'}]}];
  const harness = adminOrdersHarness({orders});
  await harness.run('load()');
  const html = harness.getId('list').innerHTML;
  assert.match(html,/Messenger: buyer.page/);
  assert.match(html,/WhatsApp: 09123456789/);
  assert.match(html,/Viber: 09123456789/);
  assert.match(html,/Use &lt;blue&gt; logo/);
  assert.match(html,/Download reference 1/);
  assert.match(html,/<img src="data:image\/jpeg;base64,/);
  assert.doesNotMatch(html,/javascript:/);
});

test('failed order status updates restore the prior value and display an error', async () => {
  const harness = adminOrdersHarness();
  await harness.run('load()');
  const select = new Element(), error = new Element();
  select.dataset = {status:'NX-1',currentStatus:'new'};
  select.value = 'completed';
  select.closest = () => ({querySelector:()=>error});
  await harness.listeners.change({target:select});
  assert.equal(select.value,'new');
  assert.equal(select.disabled,false);
  assert.equal(error.hidden,false);
  assert.equal(error.textContent,'Access denied');
});

test('admin drawer keeps the closed app usable and restores focus after closing', () => {
  const html = read('public/admin/index.html');
  const focusScript = scripts(html).find(script=>script.includes('let last=null,wasOpen=false'));
  const app = new Element(), drawer = new Element(), button = new Element(), close = new Element(), overlay = new Element(), first = new Element();
  drawer.setAttribute('aria-hidden','true');
  drawer.querySelectorAll = () => [first];
  let observer;
  const document = {activeElement:button,getElementById:id=>({nxAdminDrawer:drawer,nxAdminOverlay:overlay,nxAdminMenuBtn:button,nxAdminClose:close}[id]),querySelector:()=>app,addEventListener() {}};
  vm.runInNewContext(focusScript,{document,MutationObserver:class {constructor(fn) {observer=fn;}observe() {}},setTimeout:fn=>fn()});
  assert.equal(app.getAttribute('inert'),null);
  assert.equal(drawer.getAttribute('inert'),'');
  drawer.setAttribute('aria-hidden','false');
  button.listeners.click[0]();
  assert.equal(app.getAttribute('inert'),'');
  assert.equal(drawer.getAttribute('inert'),null);
  assert.equal(first.focusCount,1);
  observer();
  assert.equal(first.focusCount,1);
  drawer.setAttribute('aria-hidden','true');
  observer();
  assert.equal(app.getAttribute('inert'),null);
  assert.equal(button.focusCount,1);
});

test('admin drawer restores its opener after a click that does not focus the button', () => {
  const focusScript = scripts(read('public/admin/index.html')).find(script=>script.includes('let last=null,wasOpen=false'));
  const app = new Element(), drawer = new Element(), button = new Element(), close = new Element(), overlay = new Element(), first = new Element(), body = new Element();
  drawer.setAttribute('aria-hidden','true');drawer.querySelectorAll = () => [first];
  let observer;
  const document = {activeElement:body,getElementById:id=>({nxAdminDrawer:drawer,nxAdminOverlay:overlay,nxAdminMenuBtn:button,nxAdminClose:close}[id]),querySelector:()=>app,addEventListener() {}};
  vm.runInNewContext(focusScript,{document,MutationObserver:class {constructor(fn) {observer=fn;}observe() {}},setTimeout:fn=>fn()});
  drawer.setAttribute('aria-hidden','false');button.listeners.click[0]();
  drawer.setAttribute('aria-hidden','true');observer();
  assert.equal(button.focusCount,1);
  assert.equal(body.focusCount,undefined);
  assert.equal(app.getAttribute('inert'),null);
});
