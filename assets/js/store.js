function readStoredCart() {
  try { const cart = JSON.parse(localStorage.getItem('maconta_cart') || '[]'); return Array.isArray(cart) ? cart : []; }
  catch { return []; }
}
const store = { products: [], categories: [], settings: {}, cart: readStoredCart(), activeFilter: 'all' };
const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const money = (value) => `$${Number(value).toFixed(Number(value) < 1 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '')}`;
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
const normalizeSearch = (value = '') => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const productDetails = (product, limit = 4) => String(product?.description || '').split(/\s*[·•,]\s*/).filter(Boolean).slice(0, limit);
const fallbackCatalogMarkup = $('.catalog-grid').innerHTML;

async function fetchJson(url, options = {}) {
  let response;
  try { response = await fetch(url, options); }
  catch { throw new Error('No hay conexión con el servidor.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la operación.');
  return data;
}

function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try { localStorage.setItem('maconta_theme', dark ? 'dark' : 'light'); } catch { /* El tema sigue activo durante esta sesión. */ }
  $('#theme-toggle').setAttribute('aria-label', dark ? 'Activar modo claro' : 'Activar modo oscuro');
  $('#theme-toggle').setAttribute('aria-pressed', String(dark));
  $('#theme-color').content = dark ? '#07172b' : '#f2f8fc';
}

applyTheme(document.documentElement.dataset.theme);
$('#theme-toggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
const priceVisible = (product) => store.settings.prices_visible !== 'false' && product?.show_price !== false;

const menuButton = $('.menu-btn');
const navigation = $('.nav');
function closeMenu() {
  navigation.classList.remove('open');
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-label', 'Abrir menú');
}
menuButton.addEventListener('click', () => {
  const isOpen = navigation.classList.toggle('open');
  menuButton.setAttribute('aria-expanded', String(isOpen));
  menuButton.setAttribute('aria-label', isOpen ? 'Cerrar menú' : 'Abrir menú');
});
$$('.nav a').forEach((link) => link.addEventListener('click', closeMenu));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });

function revealElements(scope = document) {
  const elements = $$('.reveal:not(.visible)', scope);
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return elements.forEach((element) => element.classList.add('visible'));
  const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('visible');
    observer.unobserve(entry.target);
  }), { threshold: 0.1 });
  elements.forEach((element) => observer.observe(element));
}
revealElements();

function productCard(product, index) {
  const available = product.availability === 'available';
  const stockText = product.availability === 'out_of_stock' ? 'Agotado' : product.stock > 0 ? `${product.stock} disponibles` : 'Disponible';
  const visible = priceVisible(product);
  const commercialDetails = productDetails(product);
  const detailsMarkup = commercialDetails.length
    ? `<div class="commercial-details"><strong>Presentación</strong><div>${commercialDetails.map((detail) => `<span><i>${/bulto|caja|paquete|unidades|pares/i.test(detail) ? '▦' : '✓'}</i>${escapeHtml(detail)}</span>`).join('')}</div></div>`
    : '<div class="commercial-details"><strong>Presentación</strong><div><span><i>✓</i>Consultar opciones</span></div></div>';
  const priceMarkup = !visible
    ? '<span>Cotización</span><strong>Consultar</strong>'
    : product.sale_active
      ? `<span>Precio especial</span><div class="offer-price"><del>${money(product.regular_price)}</del><strong>${money(product.price)}</strong></div>`
      : `<span>Precio</span><strong>${money(product.price)}</strong>`;
  return `<article class="product-card reveal" data-category="${escapeHtml(product.category_slug)}" data-id="${product.id}" aria-labelledby="product-name-${product.id}">
    <div class="card-number">${String(index + 1).padStart(2, '0')}</div>
    <span class="stock-badge ${product.availability}">${stockText}</span>
    <div class="product-visual"><img src="/${escapeHtml(product.image)}" alt="${escapeHtml(product.alt || product.name)}" loading="lazy" decoding="async"></div>
    <div class="card-copy"><small>${escapeHtml(product.label || product.category_name)}</small><h3 id="product-name-${product.id}">${escapeHtml(product.name)}</h3>${detailsMarkup}
      <div class="product-price ${visible ? '' : 'price-hidden'} ${product.sale_active ? 'has-offer' : ''}">${priceMarkup}</div>
      <button class="view-product" type="button" data-view-product="${product.id}">Ver detalles <span>→</span></button>
      <button class="add-cart" type="button" data-add-cart="${product.id}" ${available ? '' : 'disabled'} aria-label="${available ? `Agregar ${escapeHtml(product.name)} al carrito` : `${escapeHtml(product.name)} agotado`}">${available ? '+' : '×'}</button>
    </div></article>`;
}

function renderCatalog() {
  const filters = $('.filters');
  filters.innerHTML = `<button class="filter active" type="button" data-filter="all" aria-pressed="true">Todos</button>${store.categories.map((category) => `<button class="filter" type="button" data-filter="${escapeHtml(category.slug)}" aria-pressed="false">${escapeHtml(category.name)}</button>`).join('')}`;
  $('.catalog-grid').innerHTML = store.products.map(productCard).join('');
  $('#catalog-count').textContent = store.products.length;
  $('#product').innerHTML = `<option value="">Selecciona un producto</option>${store.products.filter((product) => product.availability !== 'hidden').map((product) => `<option value="${escapeHtml(product.name)}">${escapeHtml(product.name)}</option>`).join('')}<option value="Otro producto o medida especial">Otro producto o medida especial</option>`;
  revealElements($('.catalog-grid'));
  applyProductFilters();
}

function applyProductFilters() {
  const query = normalizeSearch($('#product-search').value);
  let visible = 0;
  $$('.product-card').forEach((card) => {
    const matchesCategory = store.activeFilter === 'all' || card.dataset.category === store.activeFilter;
    const matchesSearch = !query || normalizeSearch(card.textContent).includes(query);
    const show = matchesCategory && matchesSearch;
    card.classList.toggle('hidden', !show);
    if (show) visible += 1;
  });
  $('#search-results').textContent = `${visible} ${visible === 1 ? 'producto' : 'productos'}`;
  $('#catalog-empty').hidden = visible !== 0;
  $('#clear-product-search').hidden = !query;
}

$('.filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-filter]');
  if (!button || button.dataset.filter === store.activeFilter) return;
  const scrollPosition = window.scrollY;
  const applyFilter = () => {
    store.activeFilter = button.dataset.filter;
    $$('.filter').forEach((item) => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); });
    applyProductFilters();
    window.scrollTo({ top: scrollPosition, left: 0, behavior: 'instant' });
  };
  if (document.startViewTransition && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.startViewTransition(applyFilter).finished.finally(() => window.scrollTo({ top: scrollPosition, left: 0, behavior: 'instant' }));
  } else {
    applyFilter();
    requestAnimationFrame(() => window.scrollTo({ top: scrollPosition, left: 0, behavior: 'instant' }));
  }
});

$('#product-search').addEventListener('input', applyProductFilters);
$('#clear-product-search').addEventListener('click', () => { $('#product-search').value = ''; applyProductFilters(); $('#product-search').focus(); });
$('#reset-product-search').addEventListener('click', () => {
  $('#product-search').value = '';
  store.activeFilter = 'all';
  $$('.filter').forEach((item) => { const active = item.dataset.filter === 'all'; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); });
  applyProductFilters();
  $('#product-search').focus();
});

$$('[data-footer-filter]').forEach((link) => link.addEventListener('click', () => {
  setTimeout(() => $(`.filter[data-filter="${link.dataset.footerFilter}"]`)?.click(), 100);
}));

function saveCart() {
  try { localStorage.setItem('maconta_cart', JSON.stringify(store.cart)); } catch { /* El carrito sigue funcionando durante esta sesión. */ }
  renderCart();
}
function cartProduct(id) { return store.products.find((product) => product.id === Number(id)); }
function addToCart(id) {
  const product = cartProduct(id);
  if (!product || product.availability !== 'available') return;
  const existing = store.cart.find((item) => item.product_id === product.id);
  if (existing) existing.quantity += 1;
  else store.cart.push({ product_id: product.id, quantity: 1 });
  saveCart(); openCart();
}
function cartTotal() { return store.cart.reduce((total, item) => total + (cartProduct(item.product_id)?.price || 0) * item.quantity, 0); }

function openProductDetails(id) {
  const product = cartProduct(id);
  if (!product) return;
  const dialog = $('#product-dialog');
  const available = product.availability === 'available';
  const details = productDetails(product, 6);
  const visible = priceVisible(product);
  $('#product-detail-image').src = `/${product.image}`;
  $('#product-detail-image').alt = product.alt || product.name;
  $('#product-detail-category').textContent = product.label || product.category_name || 'Producto Maconta Plast';
  $('#product-detail-name').textContent = product.name;
  $('#product-detail-description').textContent = product.description || 'Consulta con nuestro equipo las presentaciones disponibles.';
  $('#product-detail-status').textContent = available ? (product.stock > 0 ? `${product.stock} disponibles` : 'Disponible') : 'Agotado';
  $('#product-detail-status').className = available ? 'available' : 'out_of_stock';
  $('#product-detail-specs').innerHTML = details.map((detail) => `<span><i>✓</i>${escapeHtml(detail)}</span>`).join('') || '<span><i>✓</i>Presentaciones disponibles bajo consulta</span>';
  $('#product-detail-price-label').textContent = visible ? (product.sale_active ? 'Precio especial' : 'Precio') : 'Cotización';
  $('#product-detail-price').textContent = visible ? money(product.price) : 'Consultar';
  const addButton = $('#product-detail-add');
  addButton.disabled = !available;
  addButton.firstChild.textContent = available ? 'Agregar al carrito ' : 'Producto agotado ';
  addButton.dataset.productId = product.id;
  dialog.showModal();
  document.body.classList.add('product-open');
}

function closeProductDetails() { $('#product-dialog').close(); document.body.classList.remove('product-open'); }

function renderCart() {
  store.cart = store.cart.filter((item) => cartProduct(item.product_id));
  const count = store.cart.reduce((total, item) => total + item.quantity, 0);
  $('#cart-count').textContent = count;
  $('#cart-items').innerHTML = store.cart.map((item) => {
    const product = cartProduct(item.product_id);
    const visible = priceVisible(product);
    return `<article class="cart-item"><img src="/${escapeHtml(product.image)}" alt=""><div><strong>${escapeHtml(product.name)}</strong><span>${visible ? money(product.price) : 'Precio por cotizar'}</span><div class="quantity"><button data-quantity="-1" data-id="${product.id}" aria-label="Quitar uno">−</button><b>${item.quantity}</b><button data-quantity="1" data-id="${product.id}" aria-label="Agregar uno">+</button><button class="remove-item" data-remove="${product.id}">Eliminar</button></div></div><strong>${visible ? money(product.price * item.quantity) : 'Consultar'}</strong></article>`;
  }).join('');
  $('#cart-empty').hidden = store.cart.length > 0;
  $('.cart-footer').hidden = store.cart.length === 0;
  const allPricesVisible = store.cart.every((item) => priceVisible(cartProduct(item.product_id)));
  const displayedTotal = allPricesVisible ? money(cartTotal()) : 'Por cotizar';
  $('#cart-total').textContent = displayedTotal;
  $('#checkout-total').textContent = displayedTotal;
}

$('.catalog-grid').addEventListener('click', (event) => {
  const button = event.target.closest('[data-add-cart]');
  if (button) { addToCart(Number(button.dataset.addCart)); return; }
  const detailButton = event.target.closest('[data-view-product]');
  const card = event.target.closest('.product-card');
  if (detailButton || (card && !event.target.closest('a,button'))) openProductDetails(Number(detailButton?.dataset.viewProduct || card.dataset.id));
});
$('#product-dialog-close').addEventListener('click', closeProductDetails);
$('#product-dialog').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeProductDetails(); });
$('#product-dialog').addEventListener('close', () => document.body.classList.remove('product-open'));
$('#product-detail-add').addEventListener('click', (event) => { const id = Number(event.currentTarget.dataset.productId); closeProductDetails(); addToCart(id); });
$('#cart-items').addEventListener('click', (event) => {
  const id = Number(event.target.dataset.id || event.target.dataset.remove);
  if (!id) return;
  const item = store.cart.find((entry) => entry.product_id === id);
  if (event.target.dataset.remove) store.cart = store.cart.filter((entry) => entry.product_id !== id);
  else if (item) { item.quantity += Number(event.target.dataset.quantity); if (item.quantity <= 0) store.cart = store.cart.filter((entry) => entry.product_id !== id); }
  saveCart();
});

function openCart() { $('#cart-overlay').hidden = false; $('#cart-drawer').classList.add('open'); $('#cart-drawer').setAttribute('aria-hidden', 'false'); document.body.classList.add('cart-open'); requestAnimationFrame(() => $('#cart-close').focus()); }
function closeCart(returnFocus = true) { $('#cart-overlay').hidden = true; $('#cart-drawer').classList.remove('open'); $('#cart-drawer').setAttribute('aria-hidden', 'true'); document.body.classList.remove('cart-open'); if (returnFocus) $('#cart-open').focus(); }
$('#cart-open').addEventListener('click', openCart); $('#cart-close').addEventListener('click', closeCart); $('#cart-overlay').addEventListener('click', closeCart);
document.addEventListener('keydown', (event) => {
  const drawer = $('#cart-drawer');
  if (!drawer.classList.contains('open')) return;
  if (event.key === 'Escape') { closeCart(); return; }
  if (event.key === 'Tab') {
    const focusable = $$('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled])', drawer);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
$('#checkout-open').addEventListener('click', () => { closeCart(false); $('#checkout-dialog').showModal(); });
$('#checkout-close').addEventListener('click', () => $('#checkout-dialog').close());
$('#checkout-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const status = $('.checkout-status', form);
  const submit = form.querySelector('[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true; submit.classList.add('is-loading'); submit.setAttribute('aria-busy', 'true');
  status.textContent = 'Enviando pedido…';
  const payload = { ...Object.fromEntries(new FormData(form)), items: store.cart };
  try {
    const data = await fetchJson('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    status.textContent = `¡Pedido #${data.id} recibido! Te contactaremos para confirmarlo.`;
    store.cart = []; saveCart(); form.reset();
    setTimeout(() => $('#checkout-dialog').close(), 2800);
    await loadStore();
  } catch (error) { status.textContent = error.message || 'No se pudo enviar el pedido. Revisa tu conexión e inténtalo nuevamente.'; }
  finally { submit.disabled = false; submit.classList.remove('is-loading'); submit.removeAttribute('aria-busy'); }
});

function applySettings() {
  const settings = store.settings;
  const number = String(settings.whatsapp || '').replace(/\D/g, '');
  const whatsappUrl = `https://wa.me/${number}?text=${encodeURIComponent(settings.whatsapp_message || '')}`;
  $('#whatsapp-widget').href = whatsappUrl;
  $('#footer-whatsapp').href = whatsappUrl;
  $('#footer-email').textContent = settings.email;
  $('#footer-email').href = `mailto:${settings.email}`;
  $('#footer-address').textContent = settings.address;
  $('#footer-hours').textContent = settings.business_hours;
  $('#footer-text').textContent = settings.footer_text;
  $('#contacto').hidden = settings.quote_enabled !== 'true';
  $$('a[href="#contacto"]').forEach((link) => { link.hidden = settings.quote_enabled !== 'true'; });
  $('#quote-title').textContent = settings.quote_title;
  $('#quote-description').textContent = settings.quote_description;
  $('#about-kicker').textContent = settings.about_kicker;
  $('#about-title').textContent = settings.about_title;
  $('#about-description').textContent = settings.about_description;
  for (let index = 1; index <= 4; index += 1) {
    const value = Number(settings[`about_stat_${index}_value`]) || 0;
    const stat = $(`#about-stat-${index}`);
    stat.dataset.count = value;
    stat.textContent = value;
    $(`#about-suffix-${index}`).textContent = settings[`about_stat_${index}_suffix`] || '';
    $(`#about-label-${index}`).textContent = settings[`about_stat_${index}_label`] || '';
  }
  const contactEmail = $('.contact-row a[href^="mailto:"]');
  if (contactEmail) { contactEmail.textContent = settings.email; contactEmail.href = `mailto:${settings.email}`; }
  const contactAddress = $('.contact-row p');
  if (contactAddress) contactAddress.textContent = settings.address;
}

async function loadStore() {
  const grid = $('.catalog-grid');
  const retry = $('#retry-catalog');
  $('#catalog-feedback').hidden = true;
  $('#catalog-empty').hidden = true;
  retry.disabled = true;
  $('#product-search').disabled = true;
  $$('.filter').forEach((button) => { button.disabled = true; });
  grid.setAttribute('aria-busy', 'true');
  grid.innerHTML = Array.from({ length: 8 }, () => '<article class="product-skeleton" aria-hidden="true"><div></div><span></span><b></b><i></i><i></i></article>').join('');
  try {
    const data = await fetchJson('/api/store');
    store.products = data.products;
    store.categories = data.categories;
    store.settings = data.settings;
    renderCatalog(); applySettings(); renderCart();
  } catch {
    console.warn('El catálogo dinámico requiere iniciar el servidor con npm start.');
    grid.innerHTML = fallbackCatalogMarkup;
    store.products = $$('.product-card').map((card, index) => ({ id: index + 1, name: $('h3', card)?.textContent || '', price: Number($('.product-price strong', card)?.textContent.replace('$', '')) || 0, image: $('img', card)?.getAttribute('src') || '', availability: 'available' }));
    $$('.product-card').forEach((card, index) => { card.dataset.id = String(index + 1); card.classList.add('visible'); });
    applyProductFilters();
    renderCart();
    $('#catalog-feedback').hidden = false;
  } finally {
    grid.removeAttribute('aria-busy');
    retry.disabled = false;
    $('#product-search').disabled = false;
    $$('.filter').forEach((button) => { button.disabled = false; });
  }
}

$('#retry-catalog').addEventListener('click', loadStore);

const stats = $('.stats');
let hasCounted = false;
if (stats && 'IntersectionObserver' in window) new IntersectionObserver((entries, observer) => {
  if (!entries[0].isIntersecting || hasCounted) return;
  hasCounted = true; observer.disconnect();
  $$('[data-count]').forEach((element) => { const target = Number(element.dataset.count); let current = 0; const step = Math.max(1, Math.ceil(target / 45)); const timer = setInterval(() => { current = Math.min(target, current + step); element.textContent = current; if (current === target) clearInterval(timer); }, 28); });
}, { threshold: 0.3 }).observe(stats);

const sections = $$('main section[id]');
window.addEventListener('scroll', () => { let current = 'inicio'; sections.forEach((section) => { if (scrollY >= section.offsetTop - 150) current = section.id; }); $$('.nav a').forEach((link) => { const active=link.getAttribute('href') === `#${current}`; link.classList.toggle('active',active); if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current'); }); }, { passive: true });

$('.quote-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const status = $('.form-status', form);
  if (!form.checkValidity()) { status.textContent = 'Completa los campos obligatorios antes de continuar.'; form.reportValidity(); return; }
  const submit = form.querySelector('[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true; submit.classList.add('is-loading'); submit.setAttribute('aria-busy', 'true');
  const fields = Object.fromEntries(new FormData(form));
  status.textContent = 'Enviando solicitud…';
  try {
    const data = await fetchJson('/api/quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_name: fields.name, email: fields.email, phone: fields.phone, tax_id: fields.tax_id, product: fields.product, message: fields.message }) });
    status.textContent = `¡Solicitud #C${String(data.id).padStart(4, '0')} recibida! La revisaremos y te contactaremos.`;
    form.reset();
  } catch (error) { status.textContent = error.message || 'No se pudo enviar la solicitud. Revisa tu conexión e inténtalo nuevamente.'; }
  finally { submit.disabled = false; submit.classList.remove('is-loading'); submit.removeAttribute('aria-busy'); }
});

loadStore();
