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
  focus() { this.focusCount = (this.focusCount || 0) + 1; }
  closest() { return null; }
  getClientRects() { return [{}]; }
  get selectedOptions() { return this.children.filter(child => child.value === this.value); }
}

function checkoutHarness(options = {}) {
  const ids = new Map(), names = new Map(), listeners = {}, storage = new Map();
  const getId = id => { if (!ids.has(id)) ids.set(id, new Element()); return ids.get(id); };
  const getName = name => { if (!names.has(name)) names.set(name, new Element()); return names.get(name); };
  const requests = [], addressRequests = [], canvases = [];
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
      getElementById: getId,
      querySelector: selector => { const match = selector.match(/^\[name="(.*)"\]$/); return match ? getName(match[1]) : new Element(); },
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
    context, ids, names, storage, requests, addressRequests, canvases, listeners, getId, getName,
    run: code => vm.runInContext(code, context),
    submit: async ({completeAddress=true} = {}) => {
      await new Promise(resolve=>setImmediate(resolve));
      if (completeAddress) for (const name of ['region','province','city','barangay']) {
        const select = getName(name);
        if (select.required===false || select.value) continue;
        const option = new Element();option.value = name==='region'?'1300000000':'sample-'+name;option.dataset.name = 'Sample '+name;
        select.appendChild(option);select.value = option.value;select.disabled = false;
      }
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
  assert.equal(harness.run('total()'), (499 + 69) * 99 + 199 * 99);
  harness.run('draft.elite=99');
  harness.listeners.click[0]({target:{dataset:{inc:'elite'}}});
  assert.equal(harness.run('draft.elite'), 99);
  harness.getId('items').listeners.click[0]({target:{dataset:{ci:'0',dir:'1'}}});
  assert.equal(harness.run('cart[0].qty'), 99);
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
  assert.equal(harness.getId('checkoutSubtotal').textContent,'₱1,333');
  assert.equal(harness.getId('checkoutShipping').textContent,'₱70');
  assert.equal(harness.getId('checkoutGrandTotal').textContent,'₱1,403');
  harness.getId('items').listeners.click[0]({target:{dataset:{ci:'0',dir:'1'}}});
  assert.equal(harness.getId('checkoutSubtotal').textContent,'₱1,701');
  assert.equal(harness.getId('checkoutShipping').textContent,'₱70');
  assert.equal(harness.getId('submitTotal').textContent,'₱1,771');
  harness.getName('region').value='0700000000';
  await harness.run('loadProvinces()');
  assert.equal(harness.getId('checkoutShipping').textContent,'₱99');
  assert.equal(harness.getId('checkoutGrandTotal').textContent,'₱1,800');
  harness.getName('region').value='1100000000';
  for (const listener of harness.getName('barangay').listeners.change) listener();
  assert.equal(harness.getId('checkoutShipping').textContent,'₱99');
  assert.equal(harness.getId('submitTotal').textContent,'₱1,800');
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
    assert.equal(payload.subtotal,(199+69)*3);
    assert.equal(payload.shipping_fee,fee);
    assert.equal(payload.total,(199+69)*3+fee);
    assert.equal(payload.items[0].custom_design_fee,69);
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
  assert.equal(harness.getId('checkoutGrandTotal').textContent,'₱367');
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
  assert.equal(harness.requests[0].body.subtotal, (299 + 69) * 2);
  assert.equal(harness.requests[0].body.shipping_fee,70);
  assert.equal(harness.requests[0].body.total, (299 + 69) * 2 + 70);
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
