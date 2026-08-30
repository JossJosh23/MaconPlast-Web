const state = { products: [], categories: [], orders: [], quotes: [], adminEmail: '', setupRequired: false };
const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const money = (value) => `$${Number(value).toFixed(Number(value) < 1 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '')}`;
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));

async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error('No hay conexión con el servidor. Abre el panel desde http://localhost:3000/admin.html');
  }
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !url.includes('/auth/')) showAuth(false);
    throw new Error(data?.error || 'No se pudo completar la operación.');
  }
  return data;
}

function message(form, text, success = false) {
  const element = $('.form-message', form);
  element.textContent = text;
  element.style.color = success ? '#438719' : '';
}

function showAuth(setupRequired) {
  state.setupRequired = setupRequired;
  $('#auth-shell').hidden = false;
  $('#admin-app').hidden = true;
  $('#setup-copy').hidden = !setupRequired;
  $('#login-copy').hidden = setupRequired;
  const button = $('#auth-form button');
  button.firstChild.textContent = setupRequired ? 'Crear administrador ' : 'Entrar al panel ';
  $('#auth-form [name=password]').autocomplete = setupRequired ? 'new-password' : 'current-password';
}

async function showAdmin(session) {
  state.adminEmail = session.email;
  $('#admin-email').textContent = session.email;
  $('#auth-shell').hidden = true;
  $('#admin-app').hidden = false;
  await Promise.all([loadDashboard(), loadCategories(), loadProducts()]);
}

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  try {
    if (state.setupRequired) {
      await api('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      state.setupRequired = false;
      $('#setup-copy').hidden = true;
      $('#login-copy').hidden = false;
      message(form, 'Administrador creado. Ahora inicia sesión.', true);
      form.querySelector('button').firstChild.textContent = 'Entrar al panel ';
      return;
    }
    const session = await api('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    form.reset();
    await showAdmin(session);
  } catch (error) { message(form, error.message); }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  showAuth(false);
});

const titles = { dashboard: 'Resumen', products: 'Productos', categories: 'Categorías', orders: 'Ventas', quotes: 'Cotizaciones', settings: 'Configuración' };
async function openView(name) {
  $$('.admin-nav').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  $$('.admin-view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
  $('#view-title').textContent = titles[name];
  if (name === 'orders') await loadOrders();
  if (name === 'quotes') await loadQuotes();
  if (name === 'settings') await loadSettings();
}
$$('.admin-nav').forEach((button) => button.addEventListener('click', () => openView(button.dataset.view)));
$$('[data-go]').forEach((button) => button.addEventListener('click', () => openView(button.dataset.go)));

async function loadDashboard() {
  const metrics = await api('/api/admin/dashboard');
  $('#metric-products').textContent = metrics.products;
  $('#metric-stock').textContent = metrics.outOfStock;
  $('#metric-orders').textContent = metrics.pendingOrders;
  $('#metric-quotes').textContent = metrics.pendingQuotes;
  $('#metric-sales').textContent = money(metrics.sales);
}

async function loadCategories() {
  state.categories = await api('/api/admin/categories');
  const options = state.categories.map((category) => `<option value="${category.id}">${escapeHtml(category.name)}</option>`).join('');
  $('#product-form [name=category_id]').innerHTML = `<option value="">Selecciona…</option>${options}`;
  $('#product-category-filter').innerHTML = `<option value="">Todas las categorías</option>${options}`;
  $('#category-list').innerHTML = state.categories.map((category) => `<div class="category-row"><div><strong>${escapeHtml(category.name)}</strong><small>${escapeHtml(category.slug)} · orden ${category.sort_order}</small></div><div class="actions"><button data-edit-category="${category.id}">Editar</button><button class="delete" data-delete-category="${category.id}">Eliminar</button></div></div>`).join('');
}

async function loadProducts() {
  state.products = await api('/api/admin/products');
  renderProducts();
}

function renderProducts() {
  const search = $('#product-search').value.trim().toLowerCase();
  const categoryId = Number($('#product-category-filter').value || 0);
  const products = state.products.filter((product) => (!search || `${product.name} ${product.description}`.toLowerCase().includes(search)) && (!categoryId || product.category_id === categoryId));
  const labels = { available: 'Disponible', out_of_stock: 'Agotado', hidden: 'Oculto' };
  $('#products-table').innerHTML = products.map((product) => `<tr><td><div class="product-cell"><img src="/${escapeHtml(product.image || 'images/catalogo/maconta-plast-logo-cropped.png')}" alt=""><div><strong>${escapeHtml(product.name)}</strong><small>Orden ${product.sort_order}</small></div></div></td><td>${escapeHtml(product.category_name)}</td><td><strong>${money(product.price)}</strong></td><td>${product.stock || 'Sin control'}</td><td><span class="status ${product.availability}">${labels[product.availability]}</span></td><td><div class="actions"><button data-edit-product="${product.id}">Editar</button><button class="delete" data-delete-product="${product.id}">Eliminar</button></div></td></tr>`).join('') || '<tr><td colspan="6">No hay productos que coincidan.</td></tr>';
}
$('#product-search').addEventListener('input', renderProducts);
$('#product-category-filter').addEventListener('change', renderProducts);

function openProduct(product = null) {
  const form = $('#product-form');
  form.reset();
  form.elements.id.value = product?.id || '';
  form.elements.image.value = product?.image || '';
  form.elements.name.value = product?.name || '';
  form.elements.category_id.value = product?.category_id || '';
  form.elements.label.value = product?.label || '';
  form.elements.price.value = product?.price ?? '';
  form.elements.stock.value = product?.stock ?? 0;
  form.elements.availability.value = product?.availability || 'available';
  form.elements.sort_order.value = product?.sort_order ?? state.products.length + 1;
  form.elements.description.value = product?.description || '';
  $('#product-dialog-title').textContent = product ? 'Editar producto' : 'Agregar producto';
  message(form, '');
  $('#product-dialog').showModal();
}
$('#new-product').addEventListener('click', () => openProduct());
$('#close-product').addEventListener('click', () => $('#product-dialog').close());

$('#product-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  try {
    await api(id ? `/api/admin/products/${id}` : '/api/admin/products', { method: id ? 'PUT' : 'POST', body: new FormData(form) });
    $('#product-dialog').close();
    await Promise.all([loadProducts(), loadDashboard()]);
  } catch (error) { message(form, error.message); }
});

$('#products-table').addEventListener('click', async (event) => {
  const editId = event.target.dataset.editProduct;
  const deleteId = event.target.dataset.deleteProduct;
  if (editId) openProduct(state.products.find((product) => product.id === Number(editId)));
  if (deleteId && confirm('¿Eliminar este producto? Esta acción no se puede deshacer.')) {
    try { await api(`/api/admin/products/${deleteId}`, { method: 'DELETE' }); await Promise.all([loadProducts(), loadDashboard()]); } catch (error) { alert(error.message); }
  }
});

$('#category-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const id = data.id;
  try {
    await api(id ? `/api/admin/categories/${id}` : '/api/admin/categories', { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    form.reset(); form.elements.id.value = ''; $('#cancel-category').hidden = true; message(form, 'Categoría guardada.', true);
    await Promise.all([loadCategories(), loadProducts()]);
  } catch (error) { message(form, error.message); }
});
$('#cancel-category').addEventListener('click', () => { $('#category-form').reset(); $('#category-form [name=id]').value = ''; $('#cancel-category').hidden = true; });
$('#category-list').addEventListener('click', async (event) => {
  const editId = event.target.dataset.editCategory;
  const deleteId = event.target.dataset.deleteCategory;
  if (editId) {
    const category = state.categories.find((item) => item.id === Number(editId));
    const form = $('#category-form'); form.elements.id.value = category.id; form.elements.name.value = category.name; form.elements.sort_order.value = category.sort_order; $('#cancel-category').hidden = false;
  }
  if (deleteId && confirm('¿Eliminar esta categoría?')) {
    try { await api(`/api/admin/categories/${deleteId}`, { method: 'DELETE' }); await loadCategories(); } catch (error) { alert(error.message); }
  }
});

async function loadOrders() {
  state.orders = await api('/api/admin/orders');
  renderOrders();
}
function renderOrders() {
  const filter = $('#order-filter').value;
  const labels = { pending: 'Pendiente', confirmed: 'Confirmado', completed: 'Completado', cancelled: 'Cancelado' };
  const orders = state.orders.filter((order) => !filter || order.status === filter);
  $('#orders-list').innerHTML = orders.map((order) => `<article class="order-card"><div class="order-summary"><strong>#${String(order.id).padStart(4, '0')}</strong><div><strong>${escapeHtml(order.customer_name)}</strong><small>${new Date(`${order.created_at}Z`).toLocaleString('es-EC')}</small></div><strong class="order-total">${money(order.total)}</strong><select class="order-status status ${order.status}" data-order-status="${order.id}">${Object.entries(labels).map(([value, label]) => `<option value="${value}" ${value === order.status ? 'selected' : ''}>${label}</option>`).join('')}</select></div><details><summary>Ver ${order.items.length} producto(s)</summary><div class="order-items">${order.items.map((item) => `<div class="order-item"><span>${item.quantity} × ${escapeHtml(item.product_name)}</span><strong>${money(item.subtotal)}</strong></div>`).join('')}</div><div class="order-meta"><strong>Teléfono:</strong> ${escapeHtml(order.phone)}<br><strong>Correo:</strong> ${escapeHtml(order.email || 'No indicado')}<br><strong>Dirección:</strong> ${escapeHtml(order.address || 'No indicada')}<br><strong>Notas:</strong> ${escapeHtml(order.notes || 'Sin notas')}</div></details></article>`).join('') || '<div class="welcome-card">No hay ventas en este estado.</div>';
}
$('#order-filter').addEventListener('change', renderOrders);
$('#refresh-orders').addEventListener('click', loadOrders);
$('#orders-list').addEventListener('change', async (event) => {
  if (!event.target.dataset.orderStatus) return;
  try { await api(`/api/admin/orders/${event.target.dataset.orderStatus}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: event.target.value }) }); await Promise.all([loadOrders(), loadDashboard()]); } catch (error) { alert(error.message); }
});

async function loadQuotes() {
  state.quotes = await api('/api/admin/quotes');
  renderQuotes();
}
function renderQuotes() {
  const filter = $('#quote-filter').value;
  const labels = { new: 'Nueva', reviewing: 'En revisión', answered: 'Respondida', discarded: 'Descartada' };
  const quotes = state.quotes.filter((quote) => !filter || quote.status === filter);
  $('#quotes-list').innerHTML = quotes.map((quote) => `<article class="order-card"><div class="order-summary"><strong>#C${String(quote.id).padStart(4, '0')}</strong><div><strong>${escapeHtml(quote.customer_name)}</strong><small>${new Date(`${quote.created_at}Z`).toLocaleString('es-EC')} · ${escapeHtml(quote.product)}</small></div><div class="quote-actions"><a href="mailto:${escapeHtml(quote.email)}?subject=${encodeURIComponent(`Cotización Maconta Plast #${quote.id}`)}">Responder</a><button data-delete-quote="${quote.id}">Eliminar</button></div><select class="order-status status ${quote.status}" data-quote-status="${quote.id}">${Object.entries(labels).map(([value, label]) => `<option value="${value}" ${value === quote.status ? 'selected' : ''}>${label}</option>`).join('')}</select></div><details><summary>Ver solicitud</summary><div class="order-meta"><strong>Correo:</strong> ${escapeHtml(quote.email)}<br><strong>Teléfono:</strong> ${escapeHtml(quote.phone || 'No indicado')}<br><strong>Producto:</strong> ${escapeHtml(quote.product)}<br><strong>Mensaje:</strong> ${escapeHtml(quote.message || 'Sin detalles adicionales')}</div></details></article>`).join('') || '<div class="welcome-card">No hay cotizaciones en este estado.</div>';
}
$('#quote-filter').addEventListener('change', renderQuotes);
$('#refresh-quotes').addEventListener('click', loadQuotes);
$('#quotes-list').addEventListener('change', async (event) => {
  if (!event.target.dataset.quoteStatus) return;
  try { await api(`/api/admin/quotes/${event.target.dataset.quoteStatus}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: event.target.value }) }); await Promise.all([loadQuotes(), loadDashboard()]); } catch (error) { alert(error.message); }
});
$('#quotes-list').addEventListener('click', async (event) => {
  const id = event.target.dataset.deleteQuote;
  if (!id || !confirm('¿Eliminar esta cotización?')) return;
  try { await api(`/api/admin/quotes/${id}`, { method: 'DELETE' }); await Promise.all([loadQuotes(), loadDashboard()]); } catch (error) { alert(error.message); }
});

async function loadSettings() {
  const settings = await api('/api/admin/settings');
  const form = $('#settings-form');
  Object.entries(settings).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value; });
  form.elements.quote_enabled.checked = settings.quote_enabled === 'true';
  form.elements.admin_email.value = state.adminEmail;
}
$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  try { const payload = Object.fromEntries(new FormData(form)); payload.quote_enabled = String(form.elements.quote_enabled.checked); const data = await api('/api/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); state.adminEmail = form.elements.admin_email.value; $('#admin-email').textContent = state.adminEmail; message(form, data.message, true); } catch (error) { message(form, error.message); }
});
$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  try { const data = await api('/api/admin/password', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.reset(); message(form, data.message, true); } catch (error) { message(form, error.message); }
});

(async function init() {
  try {
    const session = await api('/api/admin/session');
    await showAdmin(session);
  } catch {
    const status = await api('/api/auth/status');
    if (status.setupRequired) {
      try {
        await api('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin1', password: 'admin1' }) });
      } catch (error) { console.warn(error.message); }
    }
    showAuth(false);
  }
})();
