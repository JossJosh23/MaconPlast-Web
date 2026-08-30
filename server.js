const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');

const app = express();
const root = __dirname;
const dataDir = path.join(root, 'data');
const uploadDir = path.join(root, 'images', 'uploads');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

const databaseFile = process.env.MACONTA_DB ? path.resolve(process.env.MACONTA_DB) : path.join(dataDir, 'maconta.db');
const db = new DatabaseSync(databaseFile);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    label TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    price REAL NOT NULL DEFAULT 0 CHECK(price >= 0),
    image TEXT NOT NULL DEFAULT '',
    alt TEXT NOT NULL DEFAULT '',
    stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
    availability TEXT NOT NULL DEFAULT 'available' CHECK(availability IN ('available','out_of_stock','hidden')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    customer_name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    total REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','completed','cancelled')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    product_name TEXT NOT NULL,
    unit_price REAL NOT NULL,
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    subtotal REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const defaults = {
  whatsapp: '593000000000',
  email: 'ventas@maconplast.com',
  address: 'Atención a nivel nacional',
  business_hours: 'Lunes a viernes · 08:00–17:00',
  footer_text: 'Soluciones plásticas que hacen avanzar tu negocio.',
  whatsapp_message: 'Hola, quiero información sobre los productos de Maconta Plast.'
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
Object.entries(defaults).forEach(([key, value]) => insertSetting.run(key, value));

function slugify(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function seedCatalog() {
  const count = db.prepare('SELECT COUNT(*) AS total FROM products').get().total;
  if (count) return;
  const categoryNames = { envases: 'Envases', desechables: 'Desechables', fundas: 'Fundas', cocina: 'Cocina e higiene' };
  const categoryIds = {};
  const addCategory = db.prepare('INSERT INTO categories (name, slug, sort_order) VALUES (?, ?, ?)');
  Object.entries(categoryNames).forEach(([slug, name], index) => {
    categoryIds[slug] = Number(addCategory.run(name, slug, index + 1).lastInsertRowid);
  });
  const products = JSON.parse(fs.readFileSync(path.join(dataDir, 'seed-products.json'), 'utf8'));
  const addProduct = db.prepare(`INSERT INTO products
    (name, category_id, label, description, price, image, alt, stock, availability, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  products.forEach((product) => addProduct.run(product.name, categoryIds[product.categorySlug], product.label, product.description, product.price, product.image, product.alt, product.stock, product.availability, product.sortOrder));
}
seedCatalog();

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const storage = multer.diskStorage({
  destination: (_request, _file, callback) => callback(null, uploadDir),
  filename: (_request, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase() || '.jpg';
    callback(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${extension}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => callback(null, ['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(file.mimetype))
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 25,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera unos minutos y vuelve a intentarlo.' }
});
const orderLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(':');
  const actual = crypto.scryptSync(password, salt, 64);
  return expected && crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

function ensureTemporaryAdmin() {
  const hasAdmins = db.prepare('SELECT COUNT(*) AS total FROM admins').get().total > 0;
  if (!hasAdmins) db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)').run('admin1', hashPassword('admin1'));
}
ensureTemporaryAdmin();

function cookieToken(request) {
  const cookies = Object.fromEntries((request.headers.cookie || '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((part) => part.length === 2));
  return cookies.maconta_session || '';
}

function requireAdmin(request, response, next) {
  const token = cookieToken(request);
  if (!token) return response.status(401).json({ error: 'Debes iniciar sesión.' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const session = db.prepare(`SELECT admins.id, admins.email FROM sessions JOIN admins ON admins.id = sessions.admin_id
    WHERE token_hash = ? AND expires_at > datetime('now')`).get(tokenHash);
  if (!session) return response.status(401).json({ error: 'La sesión expiró.' });
  request.admin = session;
  request.sessionHash = tokenHash;
  next();
}

function publicSettings() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((row) => [row.key, row.value]));
}

function productQuery(where = '') {
  return `SELECT products.*, categories.name AS category_name, categories.slug AS category_slug
    FROM products JOIN categories ON categories.id = products.category_id ${where} ORDER BY products.sort_order, products.id`;
}

app.get('/api/store', (_request, response) => {
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all();
  const products = db.prepare(productQuery("WHERE products.availability != 'hidden'" )).all();
  response.json({ categories, products, settings: publicSettings() });
});

app.get('/api/auth/status', (_request, response) => {
  const setupRequired = db.prepare('SELECT COUNT(*) AS total FROM admins').get().total === 0;
  response.json({ setupRequired });
});

app.post('/api/auth/setup', authLimiter, (request, response) => {
  if (db.prepare('SELECT COUNT(*) AS total FROM admins').get().total) return response.status(409).json({ error: 'El administrador ya fue configurado.' });
  const email = String(request.body.email || '').trim().toLowerCase();
  const password = String(request.body.password || '');
  const temporaryCredentials = email === 'admin1' && password === 'admin1';
  if (!temporaryCredentials && (!/^\S+@\S+\.\S+$/.test(email) || password.length < 10)) return response.status(400).json({ error: 'Usa un correo válido y una contraseña de al menos 10 caracteres.' });
  db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)').run(email, hashPassword(password));
  response.status(201).json({ message: 'Administrador creado. Ya puedes iniciar sesión.' });
});

app.post('/api/auth/login', authLimiter, (request, response) => {
  const email = String(request.body.email || '').trim().toLowerCase();
  const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(email);
  if (!admin || !verifyPassword(String(request.body.password || ''), admin.password_hash)) return response.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  db.prepare("INSERT INTO sessions (token_hash, admin_id, expires_at) VALUES (?, ?, datetime('now', '+7 days'))").run(tokenHash, admin.id);
  response.cookie('maconta_session', token, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 86400000, path: '/' });
  response.json({ email: admin.email });
});

app.post('/api/auth/logout', requireAdmin, (request, response) => {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(request.sessionHash);
  response.clearCookie('maconta_session', { path: '/' });
  response.status(204).end();
});

app.get('/api/admin/session', requireAdmin, (request, response) => response.json({ email: request.admin.email }));

app.get('/api/admin/dashboard', requireAdmin, (_request, response) => {
  const products = db.prepare('SELECT COUNT(*) AS total FROM products').get().total;
  const outOfStock = db.prepare("SELECT COUNT(*) AS total FROM products WHERE availability = 'out_of_stock'").get().total;
  const pendingOrders = db.prepare("SELECT COUNT(*) AS total FROM orders WHERE status = 'pending'").get().total;
  const sales = db.prepare("SELECT COALESCE(SUM(total), 0) AS total FROM orders WHERE status != 'cancelled'").get().total;
  response.json({ products, outOfStock, pendingOrders, sales });
});

app.get('/api/admin/categories', requireAdmin, (_request, response) => response.json(db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all()));
app.post('/api/admin/categories', requireAdmin, (request, response) => {
  const name = String(request.body.name || '').trim();
  const slug = slugify(request.body.slug || name);
  if (!name || !slug) return response.status(400).json({ error: 'La categoría necesita un nombre.' });
  try {
    const result = db.prepare('INSERT INTO categories (name, slug, sort_order) VALUES (?, ?, ?)').run(name, slug, Number(request.body.sort_order) || 0);
    response.status(201).json({ id: Number(result.lastInsertRowid), name, slug });
  } catch { response.status(409).json({ error: 'Ya existe una categoría con ese nombre.' }); }
});
app.put('/api/admin/categories/:id', requireAdmin, (request, response) => {
  const name = String(request.body.name || '').trim();
  const slug = slugify(request.body.slug || name);
  try {
    const result = db.prepare('UPDATE categories SET name = ?, slug = ?, sort_order = ? WHERE id = ?').run(name, slug, Number(request.body.sort_order) || 0, Number(request.params.id));
    if (!result.changes) return response.status(404).json({ error: 'Categoría no encontrada.' });
    response.json({ message: 'Categoría actualizada.' });
  } catch { response.status(409).json({ error: 'Nombre o identificador duplicado.' }); }
});
app.delete('/api/admin/categories/:id', requireAdmin, (request, response) => {
  const used = db.prepare('SELECT COUNT(*) AS total FROM products WHERE category_id = ?').get(Number(request.params.id)).total;
  if (used) return response.status(409).json({ error: 'Mueve los productos a otra categoría antes de eliminarla.' });
  db.prepare('DELETE FROM categories WHERE id = ?').run(Number(request.params.id));
  response.status(204).end();
});

app.get('/api/admin/products', requireAdmin, (_request, response) => response.json(db.prepare(productQuery()).all()));

function productFields(request, existing = {}) {
  return {
    name: String(request.body.name || '').trim(),
    categoryId: Number(request.body.category_id),
    label: String(request.body.label || '').trim(),
    description: String(request.body.description || '').trim(),
    price: Number(request.body.price),
    image: request.file ? `images/uploads/${request.file.filename}` : String(request.body.image || existing.image || ''),
    alt: String(request.body.alt || request.body.name || '').trim(),
    stock: Math.max(0, Number.parseInt(request.body.stock, 10) || 0),
    availability: ['available', 'out_of_stock', 'hidden'].includes(request.body.availability) ? request.body.availability : 'available',
    sortOrder: Number.parseInt(request.body.sort_order, 10) || 0
  };
}

app.post('/api/admin/products', requireAdmin, upload.single('image_file'), (request, response) => {
  const product = productFields(request);
  if (!product.name || !product.categoryId || !Number.isFinite(product.price) || product.price < 0) return response.status(400).json({ error: 'Completa nombre, categoría y un precio válido.' });
  const result = db.prepare(`INSERT INTO products (name, category_id, label, description, price, image, alt, stock, availability, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(product.name, product.categoryId, product.label, product.description, product.price, product.image, product.alt, product.stock, product.availability, product.sortOrder);
  response.status(201).json({ id: Number(result.lastInsertRowid) });
});

app.put('/api/admin/products/:id', requireAdmin, upload.single('image_file'), (request, response) => {
  const id = Number(request.params.id);
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!existing) return response.status(404).json({ error: 'Producto no encontrado.' });
  const product = productFields(request, existing);
  if (!product.name || !product.categoryId || !Number.isFinite(product.price) || product.price < 0) return response.status(400).json({ error: 'Completa nombre, categoría y un precio válido.' });
  db.prepare(`UPDATE products SET name=?, category_id=?, label=?, description=?, price=?, image=?, alt=?, stock=?, availability=?, sort_order=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(product.name, product.categoryId, product.label, product.description, product.price, product.image, product.alt, product.stock, product.availability, product.sortOrder, id);
  response.json({ message: 'Producto actualizado.' });
});

app.delete('/api/admin/products/:id', requireAdmin, (request, response) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(Number(request.params.id));
  response.status(204).end();
});

app.post('/api/orders', orderLimiter, (request, response) => {
  const customerName = String(request.body.customer_name || '').trim();
  const phone = String(request.body.phone || '').trim();
  const items = Array.isArray(request.body.items) ? request.body.items : [];
  if (!customerName || phone.length < 7 || !items.length) return response.status(400).json({ error: 'Indica tu nombre, teléfono y al menos un producto.' });
  const getProduct = db.prepare("SELECT * FROM products WHERE id = ? AND availability = 'available'");
  const normalized = [];
  for (const item of items) {
    const product = getProduct.get(Number(item.product_id));
    const quantity = Math.max(1, Number.parseInt(item.quantity, 10) || 1);
    if (!product) return response.status(409).json({ error: 'Uno de los productos ya no está disponible.' });
    if (product.stock > 0 && quantity > product.stock) return response.status(409).json({ error: `Solo quedan ${product.stock} unidades de ${product.name}.` });
    normalized.push({ product, quantity, subtotal: Number((product.price * quantity).toFixed(3)) });
  }
  const total = Number(normalized.reduce((sum, item) => sum + item.subtotal, 0).toFixed(3));
  db.exec('BEGIN IMMEDIATE');
  try {
    const order = db.prepare(`INSERT INTO orders (customer_name,email,phone,address,notes,total) VALUES (?,?,?,?,?,?)`).run(customerName, String(request.body.email || '').trim(), phone, String(request.body.address || '').trim(), String(request.body.notes || '').trim(), total);
    const orderId = Number(order.lastInsertRowid);
    const addItem = db.prepare('INSERT INTO order_items (order_id,product_id,product_name,unit_price,quantity,subtotal) VALUES (?,?,?,?,?,?)');
    const reduceStock = db.prepare("UPDATE products SET stock = stock - ?, availability = CASE WHEN stock - ? <= 0 THEN 'out_of_stock' ELSE availability END WHERE id = ? AND stock > 0");
    normalized.forEach(({ product, quantity, subtotal }) => {
      addItem.run(orderId, product.id, product.name, product.price, quantity, subtotal);
      reduceStock.run(quantity, quantity, product.id);
    });
    db.exec('COMMIT');
    response.status(201).json({ id: orderId, total, message: 'Pedido recibido correctamente.' });
  } catch (error) {
    db.exec('ROLLBACK');
    response.status(500).json({ error: 'No se pudo registrar el pedido.' });
  }
});

app.get('/api/admin/orders', requireAdmin, (_request, response) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC, id DESC').all();
  const getItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  response.json(orders.map((order) => ({ ...order, items: getItems.all(order.id) })));
});
app.patch('/api/admin/orders/:id', requireAdmin, (request, response) => {
  if (!['pending', 'confirmed', 'completed', 'cancelled'].includes(request.body.status)) return response.status(400).json({ error: 'Estado no válido.' });
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(request.body.status, Number(request.params.id));
  response.json({ message: 'Venta actualizada.' });
});

app.get('/api/admin/settings', requireAdmin, (_request, response) => response.json(publicSettings()));
app.put('/api/admin/settings', requireAdmin, (request, response) => {
  const allowed = Object.keys(defaults);
  const update = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  allowed.forEach((key) => { if (request.body[key] !== undefined) update.run(key, String(request.body[key]).trim()); });
  if (request.body.admin_email) {
    const email = String(request.body.admin_email).trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return response.status(400).json({ error: 'Correo administrativo no válido.' });
    db.prepare('UPDATE admins SET email = ? WHERE id = ?').run(email, request.admin.id);
  }
  response.json({ message: 'Configuración guardada.' });
});
app.put('/api/admin/password', requireAdmin, authLimiter, (request, response) => {
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(request.admin.id);
  if (!verifyPassword(String(request.body.current_password || ''), admin.password_hash)) return response.status(401).json({ error: 'La contraseña actual no coincide.' });
  if (String(request.body.new_password || '').length < 10) return response.status(400).json({ error: 'La nueva contraseña debe tener al menos 10 caracteres.' });
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(request.body.new_password), admin.id);
  db.prepare('DELETE FROM sessions WHERE admin_id = ? AND token_hash != ?').run(admin.id, request.sessionHash);
  response.json({ message: 'Contraseña actualizada.' });
});

app.use(express.static(root, { extensions: ['html'] }));

app.use((error, _request, response, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError) return response.status(400).json({ error: 'La imagen es demasiado grande o no es válida.' });
  response.status(500).json({ error: 'Ocurrió un error inesperado.' });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Maconta Plast disponible en http://localhost:${port}`));
