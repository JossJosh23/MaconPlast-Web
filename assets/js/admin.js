const state = { products: [], categories: [], orders: [], quotes: [], customers: [], inventory: null, reports: null, adminEmail: '', setupRequired: false };
const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const money = (value) => `$${Number(value).toFixed(Number(value) < 1 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '')}`;
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));

function showToast(text, type = 'success') {
  const region = $('#toast-region');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.innerHTML = `<span class="toast-icon">${type === 'success' ? '✓' : '!'}</span><div><strong>${type === 'success' ? 'Operación completada' : 'No se pudo completar'}</strong><p>${escapeHtml(text)}</p></div><button type="button" aria-label="Cerrar notificación">×</button>`;
  const close = () => { toast.classList.add('leaving'); setTimeout(() => toast.remove(), 220); };
  toast.querySelector('button').addEventListener('click', close);
  region.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(close, 4200);
}

function toLocalDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function saleState(product) {
  if (product.sale_price === null || product.sale_price >= product.price) return 'none';
  const now = Date.now();
  if (product.sale_start && new Date(product.sale_start).getTime() > now) return 'scheduled';
  if (product.sale_end && new Date(product.sale_end).getTime() < now) return 'expired';
  return 'active';
}

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

async function logout() {
  await api('/api/auth/logout', { method: 'POST' });
  showAuth(false);
}
$('#logout').addEventListener('click', logout);
$('#logout-mobile').addEventListener('click', logout);

const titles = { dashboard: 'Resumen', products: 'Productos', inventory: 'Inventario', customers: 'Clientes', categories: 'Categorías', orders: 'Ventas', quotes: 'Cotizaciones', settings: 'Configuración', reports: 'Reportes' };
async function openView(name) {
  $$('.admin-nav').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  $$('.admin-view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
  $('#view-title').textContent = titles[name];
  if (name === 'orders') await loadOrders();
  if (name === 'quotes') await loadQuotes();
  if (name === 'settings') await loadSettings();
  if (name === 'inventory') await loadInventory();
  if (name === 'customers') await loadCustomers();
  if (name === 'reports') await loadReports();
}
const inventoryNavGroup = $('#inventory-nav-group');
const inventoryNavButton = inventoryNavGroup.querySelector('.admin-nav');
function toggleInventoryMenu(force) {
  const open = typeof force === 'boolean' ? force : !inventoryNavGroup.classList.contains('open');
  inventoryNavGroup.classList.toggle('open', open);
  inventoryNavButton.setAttribute('aria-expanded', String(open));
}
$$('.admin-nav').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.view === 'inventory') toggleInventoryMenu();
  else toggleInventoryMenu(false);
  openView(button.dataset.view);
}));
$$('[data-go]').forEach((button) => button.addEventListener('click', () => openView(button.dataset.go)));

async function loadDashboard() {
  const metrics = await api('/api/admin/dashboard');
  $('#metric-products').textContent = metrics.products;
  $('#metric-stock').textContent = metrics.lowStock;
  $('#metric-orders').textContent = metrics.pendingOrders;
  $('#metric-quotes').textContent = metrics.pendingQuotes;
  $('#metric-sales').textContent = money(metrics.sales);
  updateInventoryAlertBadge(metrics.lowStock);
}

function updateInventoryAlertBadge(count = 0) {
  const badge = $('#inventory-alert-badge');
  const total = Math.max(0, Number(count) || 0);
  badge.textContent = total > 99 ? '99+' : total;
  badge.hidden = total === 0;
  inventoryNavButton.classList.toggle('has-alerts', total > 0);
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
  const priceMarkup = (product) => {
    const offer = saleState(product);
    if (offer === 'active') return `<span class="regular-price">${money(product.price)}</span><strong class="sale-price">${money(product.sale_price)}</strong><small>Oferta activa</small>`;
    const note = offer === 'scheduled' ? 'Oferta programada' : offer === 'expired' ? 'Oferta vencida' : '';
    return `<strong>${money(product.price)}</strong>${note ? `<small>${note}</small>` : ''}`;
  };
  $('#products-table').innerHTML = products.map((product) => `<tr>
    <td data-label="Producto"><div class="product-cell"><img src="/${escapeHtml(product.image || 'images/catalogo/maconta-plast-logo-cropped.png')}" alt=""><div><strong>${escapeHtml(product.name)}</strong><small>Orden ${product.sort_order}</small></div></div></td>
    <td data-label="Categoría">${escapeHtml(product.category_name)}</td>
    <td data-label="Precio">${priceMarkup(product)}<small>${product.show_price ? 'Visible' : 'Oculto al público'}</small></td>
    <td data-label="Stock">${product.stock || 'Sin control'}</td>
    <td data-label="Estado"><span class="status ${product.availability}">${labels[product.availability]}</span></td>
    <td data-label="Acciones"><div class="actions product-actions"><button data-edit-product="${product.id}">Editar</button><button data-toggle-product="${product.id}">${product.availability === 'hidden' ? 'Mostrar producto' : 'Ocultar producto'}</button><button data-toggle-price="${product.id}">${product.show_price ? 'Ocultar precio' : 'Mostrar precio'}</button><button class="delete" data-delete-product="${product.id}">Eliminar</button></div></td>
  </tr>`).join('') || '<tr><td colspan="6">No hay productos que coincidan.</td></tr>';
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
  form.elements.sale_price.value = product?.sale_price ?? '';
  form.elements.sale_start.value = toLocalDateTime(product?.sale_start);
  form.elements.sale_end.value = toLocalDateTime(product?.sale_end);
  form.elements.tax_status.value = product?.tax_status || 'taxable';
  form.elements.tax_class.value = product?.tax_class || 'standard';
  form.elements.show_price.checked = product?.show_price ?? true;
  form.elements.stock.value = product?.stock ?? 0;
  form.elements.min_stock.value = product?.min_stock ?? 0;
  form.elements.track_inventory.checked = product?.track_inventory ?? true;
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
    const payload = new FormData(form);
    for (const field of ['sale_start', 'sale_end']) {
      const value = form.elements[field].value;
      payload.set(field, value ? new Date(value).toISOString() : '');
    }
    await api(id ? `/api/admin/products/${id}` : '/api/admin/products', { method: id ? 'PUT' : 'POST', body: payload });
    $('#product-dialog').close();
    showToast(id ? 'Producto actualizado.' : 'Producto creado.');
    await Promise.all([loadProducts(), loadDashboard()]);
  } catch (error) { message(form, error.message); }
});

$('#products-table').addEventListener('click', async (event) => {
  const editId = event.target.dataset.editProduct;
  const deleteId = event.target.dataset.deleteProduct;
  const toggleProductId = event.target.dataset.toggleProduct;
  const togglePriceId = event.target.dataset.togglePrice;
  if (editId) openProduct(state.products.find((product) => product.id === Number(editId)));
  if (toggleProductId) {
    try { const data=await api(`/api/admin/products/${toggleProductId}/visibility`, { method: 'PATCH' }); showToast(data.availability==='hidden'?'Producto ocultado.':'Producto visible nuevamente.'); await Promise.all([loadProducts(), loadDashboard()]); } catch (error) { showToast(error.message,'error'); }
  }
  if (togglePriceId) {
    try { const data=await api(`/api/admin/products/${togglePriceId}/price-visibility`, { method: 'PATCH' }); showToast(data.show_price?'Precio visible nuevamente.':'Precio ocultado.'); await loadProducts(); } catch (error) { showToast(error.message,'error'); }
  }
  if (deleteId && confirm('¿Eliminar este producto? Esta acción no se puede deshacer.')) {
    try { await api(`/api/admin/products/${deleteId}`, { method: 'DELETE' }); showToast('Producto eliminado.'); await Promise.all([loadProducts(), loadDashboard()]); } catch (error) { showToast(error.message,'error'); }
  }
});

$('#category-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const id = data.id;
  try {
    await api(id ? `/api/admin/categories/${id}` : '/api/admin/categories', { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    form.reset(); form.elements.id.value = ''; $('#cancel-category').hidden = true; message(form, ''); showToast(id ? 'Categoría actualizada y orden reorganizado.' : 'Categoría creada y orden reorganizado.');
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
    try { await api(`/api/admin/categories/${deleteId}`, { method: 'DELETE' }); showToast('Categoría eliminada y orden reorganizado.'); await loadCategories(); } catch (error) { showToast(error.message,'error'); }
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
  $('#orders-list').innerHTML = orders.map((order) => `<article class="order-card sale-card"><div class="order-summary"><strong>#${String(order.id).padStart(4, '0')}</strong><div><strong>${escapeHtml(order.customer_name)}</strong><small>${new Date(order.created_at).toLocaleString('es-EC')}</small></div><div class="order-grand-total"><small>Total del pedido</small><strong class="order-total">${money(order.total)}</strong></div><select class="order-status status ${order.status}" data-order-status="${order.id}">${Object.entries(labels).map(([value, label]) => `<option value="${value}" ${value === order.status ? 'selected' : ''}>${label}</option>`).join('')}</select></div><details><summary>Ver ${order.items.length} producto(s)</summary><div class="order-items order-items-detailed"><div class="order-item order-item-head"><span>Producto</span><span>Cantidad</span><span>Precio unitario</span><span>Total</span></div>${order.items.map((item) => `<div class="order-item"><span>${escapeHtml(item.product_name)}</span><span>${item.quantity}</span><span>${money(item.unit_price)}</span><strong>${money(item.subtotal)}</strong></div>`).join('')}</div><div class="order-meta"><strong>Teléfono:</strong> ${escapeHtml(order.phone)}<br><strong>Correo:</strong> ${escapeHtml(order.email || 'No indicado')}<br><strong>Dirección:</strong> ${escapeHtml(order.address || 'No indicada')}<br><strong>Notas:</strong> ${escapeHtml(order.notes || 'Sin notas')}</div></details></article>`).join('') || '<div class="welcome-card">No hay ventas en este estado.</div>';
}
$('#order-filter').addEventListener('change', renderOrders);
$('#refresh-orders').addEventListener('click', loadOrders);
$('#orders-list').addEventListener('change', async (event) => {
  if (!event.target.dataset.orderStatus) return;
  try { await api(`/api/admin/orders/${event.target.dataset.orderStatus}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: event.target.value }) }); showToast('Estado de la venta actualizado.'); await Promise.all([loadOrders(), loadDashboard()]); } catch (error) { showToast(error.message,'error'); }
});

async function loadQuotes() {
  state.quotes = await api('/api/admin/quotes');
  renderQuotes();
}
function renderQuotes() {
  const filter = $('#quote-filter').value;
  const labels = { new: 'Nueva', reviewing: 'En revisión', answered: 'Respondida', discarded: 'Descartada' };
  const quotes = state.quotes.filter((quote) => !filter || quote.status === filter);
  $('#quotes-list').innerHTML = quotes.map((quote) => { const phone=String(quote.phone||'').replace(/\D/g,''); return `<article class="order-card quote-card"><div class="quote-card-top"><div><span class="quote-number">#C${String(quote.id).padStart(4, '0')}</span><strong>${escapeHtml(quote.customer_name)}</strong><small>${new Date(quote.created_at).toLocaleString('es-EC')}</small></div><select class="order-status status ${quote.status}" data-quote-status="${quote.id}">${Object.entries(labels).map(([value, label]) => `<option value="${value}" ${value === quote.status ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div class="quote-product"><small>PRODUCTO SOLICITADO</small><strong>${escapeHtml(quote.product)}</strong><p>${escapeHtml(quote.message || 'Sin detalles adicionales')}</p></div><div class="quote-contact"><span>${escapeHtml(quote.email)}</span><span>${escapeHtml(quote.phone || 'Sin teléfono')}</span></div><div class="quote-actions"><a href="mailto:${escapeHtml(quote.email)}?subject=${encodeURIComponent(`Cotización Maconta Plast #${quote.id}`)}">Responder por correo</a>${phone?`<a class="whatsapp-action" href="https://wa.me/${phone}" target="_blank" rel="noopener">WhatsApp</a>`:''}<button data-delete-quote="${quote.id}">Eliminar</button></div></article>`; }).join('') || '<div class="welcome-card">No hay cotizaciones en este estado.</div>';
}
$('#quote-filter').addEventListener('change', renderQuotes);
$('#refresh-quotes').addEventListener('click', loadQuotes);
$('#quotes-list').addEventListener('change', async (event) => {
  if (!event.target.dataset.quoteStatus) return;
  try { await api(`/api/admin/quotes/${event.target.dataset.quoteStatus}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: event.target.value }) }); showToast('Estado de la cotización actualizado.'); await Promise.all([loadQuotes(), loadDashboard()]); } catch (error) { showToast(error.message,'error'); }
});
$('#quotes-list').addEventListener('click', async (event) => {
  const id = event.target.dataset.deleteQuote;
  if (!id || !confirm('¿Eliminar esta cotización?')) return;
  try { await api(`/api/admin/quotes/${id}`, { method: 'DELETE' }); showToast('Cotización eliminada.'); await Promise.all([loadQuotes(), loadDashboard()]); } catch (error) { showToast(error.message,'error'); }
});

const movementLabels = { purchase: 'Compra', sale: 'Venta', damage: 'Daño', correction: 'Corrección' };
const movementReasons = {
  entry: [['purchase', 'Compra'], ['correction', 'Corrección de inventario']],
  exit: [['sale', 'Venta manual'], ['damage', 'Daño o pérdida'], ['correction', 'Corrección de inventario']]
};
function updateMovementReasons() {
  const form = $('#inventory-form');
  const reasons = movementReasons[form.elements.direction.value] || movementReasons.entry;
  form.elements.reason.innerHTML = reasons.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
}
$('#inventory-form [name=direction]').addEventListener('change', updateMovementReasons);
function selectInventorySection(section) {
  $$('[data-inventory-nav]').forEach((item) => item.classList.toggle('active', item.dataset.inventoryNav === section));
  $$('.inventory-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `inventory-${section}`));
}
$$('[data-inventory-nav]').forEach((button) => button.addEventListener('click', async () => {
  selectInventorySection(button.dataset.inventoryNav);
  await openView('inventory');
  if (window.matchMedia('(max-width: 900px)').matches) toggleInventoryMenu(false);
}));
function fillInventoryProducts(products = state.products) {
  const select = $('#inventory-form').elements.product_id;
  select.innerHTML = `<option value="">Selecciona un producto</option>${products.map((product) => `<option value="${product.id}">${escapeHtml(product.name)} · stock ${product.stock}</option>`).join('')}`;
}
async function loadInventory() {
  fillInventoryProducts();
  try { state.inventory = await api('/api/admin/inventory'); } catch (error) { const notice=`<div class="inventory-error"><strong>No se pudo cargar el inventario.</strong><span>${escapeHtml(error.message)}</span></div>`;$('#stock-alerts').innerHTML=notice;$('#final-stock-table').innerHTML=`<tr><td colspan="6">${escapeHtml(error.message)}</td></tr>`;$('#inventory-movements').innerHTML=`<tr><td colspan="5">${escapeHtml(error.message)}</td></tr>`;showToast(error.message,'error');return; }
  fillInventoryProducts(state.inventory.products);
  $('#final-stock-table').innerHTML = state.inventory.products.map((product) => `<tr><td data-label="Producto"><strong>${escapeHtml(product.name)}</strong></td><td data-label="Categoría">${escapeHtml(product.category_name)}</td><td data-label="Stock final"><strong>${product.track_inventory ? product.stock : 'Sin control'}</strong></td><td data-label="Stock mínimo">${product.track_inventory ? product.min_stock : '—'}</td><td data-label="Estado"><span class="status ${product.low_stock ? 'out_of_stock' : 'available'}">${!product.track_inventory ? 'No controlado' : product.low_stock ? 'Stock bajo' : 'Correcto'}</span></td><td data-label="Valor">${product.track_inventory ? money(product.stock * product.price) : '—'}</td></tr>`).join('');
  const low = state.inventory.products.filter((product) => product.low_stock);
  updateInventoryAlertBadge(low.length);
  $('#stock-alerts').innerHTML = low.length ? `<div class="alert-heading"><span>ALERTAS DE STOCK</span><strong>${low.length} producto(s) requieren atención</strong></div>${low.map((product) => `<article><div><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.category_name)}</small></div><span>${product.stock} / mínimo ${product.min_stock}</span></article>`).join('')}` : '<div class="stock-ok">✓ Todo el inventario está sobre el mínimo.</div>';
  $('#inventory-movements').innerHTML = state.inventory.movements.map((movement) => `<tr><td data-label="Fecha">${new Date(movement.created_at).toLocaleString('es-EC')}</td><td data-label="Producto"><strong>${escapeHtml(movement.product_name)}</strong><small>${escapeHtml(movement.notes || '')}</small></td><td data-label="Movimiento"><span class="movement ${movement.quantity_change > 0 ? 'in' : 'out'}">${movement.quantity_change > 0 ? '+' : ''}${movement.quantity_change}</span></td><td data-label="Motivo">${movementLabels[movement.reason] || movement.reason}</td><td data-label="Existencia">${movement.stock_before} → ${movement.stock_after}</td></tr>`).join('') || '<tr><td colspan="5">Todavía no hay movimientos.</td></tr>';
}
$('#inventory-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  try { const data = await api('/api/admin/inventory/movements', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.reset(); updateMovementReasons(); message(form, ''); showToast(data.message); await Promise.all([loadInventory(), loadProducts(), loadDashboard()]); } catch (error) { message(form, ''); showToast(error.message, 'error'); }
});

function renderCustomers() {
  const search = $('#customer-search').value.trim().toLowerCase();
  const customers = state.customers.filter((customer) => !search || `${customer.name} ${customer.email} ${customer.phone} ${customer.tax_id}`.toLowerCase().includes(search));
  $('#customers-list').innerHTML = customers.map((customer) => { const phone=String(customer.phone||'').replace(/\D/g,''); return `<article class="customer-card"><div class="customer-avatar">${escapeHtml(customer.name.charAt(0).toUpperCase())}</div><div><strong>${escapeHtml(customer.name)}</strong><small>${escapeHtml(customer.tax_id || 'Sin RUC/Cédula')}</small><a href="mailto:${escapeHtml(customer.email)}">${escapeHtml(customer.email || 'Sin correo')}</a><span>${escapeHtml(customer.phone || 'Sin teléfono')}</span></div><div class="customer-address"><span>${escapeHtml(customer.address || 'Sin dirección registrada')}</span><small>${customer.last_order ? `Última compra: ${new Date(customer.last_order).toLocaleDateString('es-EC')}` : 'Sin compras todavía'}</small></div><div class="customer-stats"><span><b>${customer.order_count}</b> pedidos</span><span><b>${customer.quote_count}</b> cotizaciones</span><span><b>${money(customer.total_spent)}</b> vendido</span></div><div class="actions"><button data-edit-customer="${customer.id}">Ver ficha</button>${phone?`<a class="whatsapp-action" href="https://wa.me/${phone}" target="_blank" rel="noopener">WhatsApp</a>`:''}</div></article>`; }).join('') || '<div class="welcome-card">No hay clientes que coincidan.</div>';
}
async function loadCustomers() { state.customers = await api('/api/admin/customers'); renderCustomers(); }
$('#customer-search').addEventListener('input', renderCustomers);
async function openCustomer(customerId = null) {
  const form=$('#customer-form');form.reset();$('#customer-history').innerHTML='';
  if(customerId){const customer=await api(`/api/admin/customers/${customerId}`);for(const field of ['id','name','phone','email','tax_id','address','notes'])form.elements[field].value=customer[field]||'';$('#customer-dialog-title').textContent='Ficha del cliente';$('#customer-history').innerHTML=`<h3>Historial</h3><div class="history-grid"><div><strong>Pedidos</strong>${customer.orders.map((order)=>`<span>#${order.id} · ${money(order.total)} · ${escapeHtml(order.status)}</span>`).join('')||'<span>Sin pedidos</span>'}</div><div><strong>Cotizaciones</strong>${customer.quotes.map((quote)=>`<span>#C${quote.id} · ${escapeHtml(quote.product)} · ${escapeHtml(quote.status)}</span>`).join('')||'<span>Sin cotizaciones</span>'}</div></div>`;}else{$('#customer-dialog-title').textContent='Agregar cliente';}
  message(form,'');$('#customer-dialog').showModal();
}
$('#new-customer').addEventListener('click',()=>openCustomer());$('#close-customer').addEventListener('click',()=>$('#customer-dialog').close());
$('#customers-list').addEventListener('click',(event)=>{const id=event.target.dataset.editCustomer;if(id)openCustomer(id);});
$('#customer-form').addEventListener('submit',async(event)=>{event.preventDefault();const form=event.currentTarget,data=Object.fromEntries(new FormData(form)),id=data.id;try{await api(id?`/api/admin/customers/${id}`:'/api/admin/customers',{method:id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});$('#customer-dialog').close();showToast(id?'Ficha del cliente actualizada.':'Cliente agregado.');await loadCustomers();}catch(error){message(form,'');showToast(error.message,'error');}});

async function loadReports(){
  const data=await api('/api/admin/reports');state.reports=data;$('#report-sales').textContent=money(data.summary.sales);$('#report-orders').textContent=data.summary.orders;$('#report-inventory').textContent=money(data.summary.inventory_value);$('#report-low-stock').textContent=data.summary.low_stock;
  renderSalesChart();
  $('#top-products').innerHTML=data.top.map((row,index)=>`<div class="ranking-row"><b>${index+1}</b><span>${escapeHtml(row.product_name)}<small>${row.units} unidades</small></span><strong>${money(row.total)}</strong></div>`).join('')||'<p>Sin ventas todavía.</p>';
  $('#slow-products').innerHTML=data.slow.map((row)=>`<div class="ranking-row"><span>${escapeHtml(row.name)}<small>Stock ${row.stock}</small></span><strong>${row.units} vendidos</strong></div>`).join('');
}
function renderSalesChart(){const period=$('#report-period').value,data=state.reports?.[period]||[],titles={daily:'Ventas diarias',monthly:'Ventas mensuales',annual:'Ventas anuales'};$('#sales-chart-title').textContent=titles[period];const max=Math.max(...data.map((row)=>row.total),1);$('#sales-chart').innerHTML=data.map((row)=>`<div class="chart-row"><span>${escapeHtml(row.period)}</span><div><i style="width:${Math.max(2,row.total/max*100)}%"></i></div><strong>${money(row.total)}</strong></div>`).join('');}
$('#report-period').addEventListener('change',renderSalesChart);

async function loadSettings() {
  const settings = await api('/api/admin/settings');
  const form = $('#settings-form');
  Object.entries(settings).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value; });
  form.elements.quote_enabled.checked = settings.quote_enabled === 'true';
  form.elements.prices_visible.checked = settings.prices_visible === 'true';
  form.elements.admin_email.value = state.adminEmail;
  const aboutForm = $('#about-form');
  Object.entries(settings).forEach(([key, value]) => { if (aboutForm.elements[key]) aboutForm.elements[key].value = value; });
}
$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  try { const payload = Object.fromEntries(new FormData(form)); payload.quote_enabled = String(form.elements.quote_enabled.checked); payload.prices_visible = String(form.elements.prices_visible.checked); const data = await api('/api/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); state.adminEmail = form.elements.admin_email.value; $('#admin-email').textContent = state.adminEmail; message(form, ''); showToast(data.message); } catch (error) { message(form,''); showToast(error.message,'error'); }
});
$('#about-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  try { const data = await api('/api/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) }); message(form,''); showToast(data.message); } catch (error) { message(form,''); showToast(error.message,'error'); }
});
$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  try { const data = await api('/api/admin/password', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.reset(); message(form,''); showToast(data.message); } catch (error) { message(form,''); showToast(error.message,'error'); }
});

(async function init() {
  try {
    const session = await api('/api/admin/session');
    await showAdmin(session);
  } catch {
    const status = await api('/api/auth/status');
    showAuth(status.setupRequired);
  }
})();
