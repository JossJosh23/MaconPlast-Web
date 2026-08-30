const store = { products: [], categories: [], settings: {}, cart: JSON.parse(localStorage.getItem('maconta_cart') || '[]'), activeFilter: 'all' };
const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const money = (value) => `$${Number(value).toFixed(Number(value) < 1 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '')}`;
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));

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
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeMenu(); closeCart(); } });

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
  return `<article class="product-card reveal" data-category="${escapeHtml(product.category_slug)}" data-id="${product.id}">
    <div class="card-number">${String(index + 1).padStart(2, '0')}</div>
    <span class="stock-badge ${product.availability}">${stockText}</span>
    <div class="product-visual"><img src="/${escapeHtml(product.image)}" alt="${escapeHtml(product.alt || product.name)}" loading="lazy"></div>
    <div class="card-copy"><small>${escapeHtml(product.label || product.category_name)}</small><h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(product.description)}</p>
      <div class="product-price"><span>Precio</span><strong>${money(product.price)}</strong></div>
      <button class="add-cart" type="button" data-add-cart="${product.id}" ${available ? '' : 'disabled'} aria-label="${available ? `Agregar ${escapeHtml(product.name)} al carrito` : `${escapeHtml(product.name)} agotado`}">${available ? '+' : '×'}</button>
    </div></article>`;
}

function renderCatalog() {
  const filters = $('.filters');
  filters.innerHTML = `<button class="filter active" type="button" data-filter="all" aria-pressed="true">Todos</button>${store.categories.map((category) => `<button class="filter" type="button" data-filter="${escapeHtml(category.slug)}" aria-pressed="false">${escapeHtml(category.name)}</button>`).join('')}`;
  $('.catalog-grid').innerHTML = store.products.map(productCard).join('');
  $('#catalog-count').textContent = store.products.length;
  revealElements($('.catalog-grid'));
}

$('.filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  store.activeFilter = button.dataset.filter;
  $$('.filter').forEach((item) => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); });
  $$('.product-card').forEach((card) => card.classList.toggle('hidden', store.activeFilter !== 'all' && card.dataset.category !== store.activeFilter));
});

$$('[data-footer-filter]').forEach((link) => link.addEventListener('click', () => {
  setTimeout(() => $(`.filter[data-filter="${link.dataset.footerFilter}"]`)?.click(), 100);
}));

function saveCart() {
  localStorage.setItem('maconta_cart', JSON.stringify(store.cart));
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
function renderCart() {
  store.cart = store.cart.filter((item) => cartProduct(item.product_id));
  const count = store.cart.reduce((total, item) => total + item.quantity, 0);
  $('#cart-count').textContent = count;
  $('#cart-items').innerHTML = store.cart.map((item) => {
    const product = cartProduct(item.product_id);
    return `<article class="cart-item"><img src="/${escapeHtml(product.image)}" alt=""><div><strong>${escapeHtml(product.name)}</strong><span>${money(product.price)}</span><div class="quantity"><button data-quantity="-1" data-id="${product.id}" aria-label="Quitar uno">−</button><b>${item.quantity}</b><button data-quantity="1" data-id="${product.id}" aria-label="Agregar uno">+</button><button class="remove-item" data-remove="${product.id}">Eliminar</button></div></div><strong>${money(product.price * item.quantity)}</strong></article>`;
  }).join('');
  $('#cart-empty').hidden = store.cart.length > 0;
  $('.cart-footer').hidden = store.cart.length === 0;
  $('#cart-total').textContent = money(cartTotal());
  $('#checkout-total').textContent = money(cartTotal());
}

$('.catalog-grid').addEventListener('click', (event) => {
  const button = event.target.closest('[data-add-cart]');
  if (button) addToCart(Number(button.dataset.addCart));
});
$('#cart-items').addEventListener('click', (event) => {
  const id = Number(event.target.dataset.id || event.target.dataset.remove);
  if (!id) return;
  const item = store.cart.find((entry) => entry.product_id === id);
  if (event.target.dataset.remove) store.cart = store.cart.filter((entry) => entry.product_id !== id);
  else if (item) { item.quantity += Number(event.target.dataset.quantity); if (item.quantity <= 0) store.cart = store.cart.filter((entry) => entry.product_id !== id); }
  saveCart();
});

function openCart() { $('#cart-overlay').hidden = false; $('#cart-drawer').classList.add('open'); $('#cart-drawer').setAttribute('aria-hidden', 'false'); document.body.classList.add('cart-open'); }
function closeCart() { $('#cart-overlay').hidden = true; $('#cart-drawer').classList.remove('open'); $('#cart-drawer').setAttribute('aria-hidden', 'true'); document.body.classList.remove('cart-open'); }
$('#cart-open').addEventListener('click', openCart); $('#cart-close').addEventListener('click', closeCart); $('#cart-overlay').addEventListener('click', closeCart);
$('#checkout-open').addEventListener('click', () => { closeCart(); $('#checkout-dialog').showModal(); });
$('#checkout-close').addEventListener('click', () => $('#checkout-dialog').close());
$('#checkout-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const status = $('.checkout-status', form);
  status.textContent = 'Enviando pedido…';
  const payload = { ...Object.fromEntries(new FormData(form)), items: store.cart };
  try {
    const response = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    status.textContent = `¡Pedido #${data.id} recibido! Te contactaremos para confirmarlo.`;
    store.cart = []; saveCart(); form.reset();
    setTimeout(() => $('#checkout-dialog').close(), 2800);
    await loadStore();
  } catch (error) { status.textContent = error.message || 'No se pudo enviar el pedido.'; }
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
  const contactEmail = $('.contact-row a[href^="mailto:"]');
  if (contactEmail) { contactEmail.textContent = settings.email; contactEmail.href = `mailto:${settings.email}`; }
}

async function loadStore() {
  try {
    const response = await fetch('/api/store');
    if (!response.ok) throw new Error();
    const data = await response.json();
    store.products = data.products;
    store.categories = data.categories;
    store.settings = data.settings;
    renderCatalog(); applySettings(); renderCart();
  } catch {
    console.warn('El catálogo dinámico requiere iniciar el servidor con npm start.');
    store.products = $$('.product-card').map((card, index) => ({ id: index + 1, name: $('h3', card)?.textContent || '', price: Number($('.product-price strong', card)?.textContent.replace('$', '')) || 0, image: $('img', card)?.getAttribute('src') || '', availability: 'available' }));
    renderCart();
  }
}

const stats = $('.stats');
let hasCounted = false;
if (stats && 'IntersectionObserver' in window) new IntersectionObserver((entries, observer) => {
  if (!entries[0].isIntersecting || hasCounted) return;
  hasCounted = true; observer.disconnect();
  $$('[data-count]').forEach((element) => { const target = Number(element.dataset.count); let current = 0; const step = Math.max(1, Math.ceil(target / 45)); const timer = setInterval(() => { current = Math.min(target, current + step); element.textContent = current; if (current === target) clearInterval(timer); }, 28); });
}, { threshold: 0.3 }).observe(stats);

const sections = $$('main section[id]');
window.addEventListener('scroll', () => { let current = 'inicio'; sections.forEach((section) => { if (scrollY >= section.offsetTop - 150) current = section.id; }); $$('.nav a').forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${current}`)); }, { passive: true });

$('.quote-form').addEventListener('submit', (event) => {
  event.preventDefault(); const form = event.currentTarget; const status = $('.form-status', form);
  if (!form.checkValidity()) { status.textContent = 'Completa los campos obligatorios antes de continuar.'; form.reportValidity(); return; }
  const number = String(store.settings.whatsapp || '').replace(/\D/g, '');
  const fields = Object.fromEntries(new FormData(form));
  const text = `Hola, soy ${fields.name}. Me interesa: ${fields.product}. ${fields.message || ''}`;
  window.open(`https://wa.me/${number}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  status.textContent = 'Abriendo WhatsApp para enviar tu solicitud…';
});

loadStore();
