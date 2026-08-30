const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', 1);

const root = __dirname;
const uploadDir = path.join(root, 'images', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

if (!process.env.DATABASE_URL && !process.env.PGHOST) {
  console.error('Falta DATABASE_URL o PGHOST. PostgreSQL es obligatorio para iniciar la aplicación.');
  process.exit(1);
}

const pool = new Pool({
  ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}),
  max: Number(process.env.PG_POOL_SIZE) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false
});

const defaults = {
  whatsapp: '593000000000',
  email: 'ventas@maconplast.com',
  address: 'Atención a nivel nacional',
  business_hours: 'Lunes a viernes · 08:00–17:00',
  footer_text: 'Soluciones plásticas que hacen avanzar tu negocio.',
  whatsapp_message: 'Hola, quiero información sobre los productos de Maconta Plast.',
  quote_enabled: 'true',
  quote_title: 'Tu próximo proyecto empieza aquí.',
  quote_description: 'Solicita atención personalizada para compras por volumen, medidas especiales o necesidades empresariales.',
  prices_visible: 'true',
  about_kicker: 'POR QUÉ MACONTA PLAST',
  about_title: 'Más que plástico, una alianza.',
  about_description: 'Entendemos que detrás de cada pedido hay una operación que no puede detenerse. Por eso combinamos experiencia, inventario y servicio para darte respuestas claras.',
  about_stat_1_value: '12',
  about_stat_1_suffix: '+',
  about_stat_1_label: 'Años de experiencia',
  about_stat_2_value: '250',
  about_stat_2_suffix: '+',
  about_stat_2_label: 'Clientes atendidos',
  about_stat_3_value: '98',
  about_stat_3_suffix: '%',
  about_stat_3_label: 'Entregas a tiempo',
  about_stat_4_value: '24',
  about_stat_4_suffix: 'h',
  about_stat_4_label: 'Respuesta comercial'
};

function slugify(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || '').split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

function cookieToken(request) {
  const entries = (request.headers.cookie || '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((part) => part.length === 2);
  return Object.fromEntries(entries).maconta_session || '';
}

function mapProduct(row) {
  return row ? { ...row, id: Number(row.id), category_id: Number(row.category_id), price: Number(row.price), sale_price: row.sale_price === null ? null : Number(row.sale_price), stock: Number(row.stock), sort_order: Number(row.sort_order) } : row;
}

function saleIsActive(product, now = new Date()) {
  if (product.sale_price === null || product.sale_price >= product.price) return false;
  const starts = product.sale_start ? new Date(product.sale_start) : null;
  const ends = product.sale_end ? new Date(product.sale_end) : null;
  return (!starts || starts <= now) && (!ends || ends >= now);
}

function effectiveProductPrice(product) {
  return saleIsActive(product) ? product.sale_price : product.price;
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      admin_id BIGINT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS products (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category_id BIGINT NOT NULL REFERENCES categories(id),
      label TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      price NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK(price >= 0),
      sale_price NUMERIC(12,3) CHECK(sale_price IS NULL OR sale_price >= 0),
      sale_start TIMESTAMPTZ,
      sale_end TIMESTAMPTZ,
      tax_status TEXT NOT NULL DEFAULT 'taxable' CHECK(tax_status IN ('taxable','none')),
      tax_class TEXT NOT NULL DEFAULT 'standard' CHECK(tax_class IN ('standard','zero','exempt')),
      show_price BOOLEAN NOT NULL DEFAULT TRUE,
      image TEXT NOT NULL DEFAULT '',
      alt TEXT NOT NULL DEFAULT '',
      stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
      availability TEXT NOT NULL DEFAULT 'available' CHECK(availability IN ('available','out_of_stock','hidden')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      total NUMERIC(14,3) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','completed','cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
      product_name TEXT NOT NULL,
      unit_price NUMERIC(12,3) NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      subtotal NUMERIC(14,3) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quotes (
      id BIGSERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      product TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewing','answered','discarded')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS show_price BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_price NUMERIC(12,3) CHECK(sale_price IS NULL OR sale_price >= 0);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_start TIMESTAMPTZ;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_end TIMESTAMPTZ;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_status TEXT NOT NULL DEFAULT 'taxable';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_class TEXT NOT NULL DEFAULT 'standard';
    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_quotes_created ON quotes(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  `);

  for (const [key, value] of Object.entries(defaults)) {
    await pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [key, value]);
  }

  const adminCount = Number((await pool.query('SELECT COUNT(*) AS total FROM admins')).rows[0].total);
  if (!adminCount) {
    const user = String(process.env.ADMIN_USER || 'admin1').toLowerCase();
    const password = String(process.env.ADMIN_PASSWORD || 'admin1');
    await pool.query('INSERT INTO admins (email,password_hash) VALUES ($1,$2)', [user, hashPassword(password)]);
  }

  const productCount = Number((await pool.query('SELECT COUNT(*) AS total FROM products')).rows[0].total);
  if (!productCount) {
    const categoryNames = { envases: 'Envases', desechables: 'Desechables', fundas: 'Fundas', cocina: 'Cocina e higiene' };
    const categoryIds = {};
    let order = 1;
    for (const [slug, name] of Object.entries(categoryNames)) {
      const result = await pool.query(`INSERT INTO categories (name,slug,sort_order) VALUES ($1,$2,$3)
        ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [name, slug, order++]);
      categoryIds[slug] = Number(result.rows[0].id);
    }
    const products = JSON.parse(fs.readFileSync(path.join(root, 'seed-products.json'), 'utf8'));
    for (const product of products) {
      await pool.query(`INSERT INTO products (name,category_id,label,description,price,image,alt,stock,availability,sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [product.name, categoryIds[product.categorySlug], product.label, product.description, product.price, product.image, product.alt, product.stock, product.availability, product.sortOrder]);
    }
  }
}

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const storage = multer.diskStorage({
  destination: (_request, _file, callback) => callback(null, uploadDir),
  filename: (_request, file, callback) => callback(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase() || '.jpg'}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => callback(null, ['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(file.mimetype))
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 25, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: { error: 'Demasiados intentos. Espera unos minutos y vuelve a intentarlo.' } });
const orderLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

async function requireAdmin(request, response, next) {
  const token = cookieToken(request);
  if (!token) return response.status(401).json({ error: 'Debes iniciar sesión.' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const result = await pool.query(`SELECT admins.id,admins.email FROM sessions JOIN admins ON admins.id=sessions.admin_id
    WHERE sessions.token_hash=$1 AND sessions.expires_at>NOW()`, [tokenHash]);
  if (!result.rows[0]) return response.status(401).json({ error: 'La sesión expiró.' });
  request.admin = result.rows[0];
  request.sessionHash = tokenHash;
  next();
}

async function publicSettings() {
  return Object.fromEntries((await pool.query('SELECT key,value FROM settings')).rows.map((row) => [row.key, row.value]));
}

const productSelect = `SELECT products.*,categories.name AS category_name,categories.slug AS category_slug
  FROM products JOIN categories ON categories.id=products.category_id`;

app.get('/api/health', async (_request, response) => {
  await pool.query('SELECT 1');
  response.json({ status: 'ok', database: 'postgresql' });
});

app.get('/api/store', async (_request, response) => {
  const [categories, products, settings] = await Promise.all([
    pool.query('SELECT * FROM categories ORDER BY sort_order,name'),
    pool.query(`${productSelect} WHERE products.availability!='hidden' ORDER BY products.sort_order,products.id`),
    publicSettings()
  ]);
  const publicProducts = products.rows.map(mapProduct).map((product) => {
    const saleActive = saleIsActive(product);
    const visible = settings.prices_visible === 'true' && product.show_price;
    return {
      ...product,
      price: visible ? effectiveProductPrice(product) : null,
      regular_price: visible && saleActive ? product.price : null,
      sale_price: visible && saleActive ? product.sale_price : null,
      sale_active: saleActive
    };
  });
  response.json({ categories: categories.rows.map((row) => ({ ...row, id: Number(row.id), sort_order: Number(row.sort_order) })), products: publicProducts, settings });
});

app.get('/api/auth/status', async (_request, response) => response.json({ setupRequired: Number((await pool.query('SELECT COUNT(*) AS total FROM admins')).rows[0].total) === 0 }));

app.post('/api/auth/setup', authLimiter, async (request, response) => {
  if (Number((await pool.query('SELECT COUNT(*) AS total FROM admins')).rows[0].total)) return response.status(409).json({ error: 'El administrador ya fue configurado.' });
  const email = String(request.body.email || '').trim().toLowerCase();
  const password = String(request.body.password || '');
  const temporary = email === 'admin1' && password === 'admin1';
  if (!temporary && (!/^\S+@\S+\.\S+$/.test(email) || password.length < 10)) return response.status(400).json({ error: 'Usa un correo válido y una contraseña de al menos 10 caracteres.' });
  await pool.query('INSERT INTO admins (email,password_hash) VALUES ($1,$2)', [email, hashPassword(password)]);
  response.status(201).json({ message: 'Administrador creado.' });
});

app.post('/api/auth/login', authLimiter, async (request, response) => {
  const email = String(request.body.email || '').trim().toLowerCase();
  const admin = (await pool.query('SELECT * FROM admins WHERE email=$1', [email])).rows[0];
  if (!admin || !verifyPassword(String(request.body.password || ''), admin.password_hash)) return response.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query('DELETE FROM sessions WHERE expires_at<=NOW()');
  await pool.query("INSERT INTO sessions (token_hash,admin_id,expires_at) VALUES ($1,$2,NOW()+INTERVAL '7 days')", [tokenHash, admin.id]);
  response.cookie('maconta_session', token, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 86400000, path: '/' });
  response.json({ email: admin.email });
});

app.post('/api/auth/logout', requireAdmin, async (request, response) => { await pool.query('DELETE FROM sessions WHERE token_hash=$1', [request.sessionHash]); response.clearCookie('maconta_session', { path: '/' }); response.status(204).end(); });
app.get('/api/admin/session', requireAdmin, (request, response) => response.json({ email: request.admin.email }));

app.get('/api/admin/dashboard', requireAdmin, async (_request, response) => {
  const result = await pool.query(`SELECT
    (SELECT COUNT(*) FROM products) AS products,
    (SELECT COUNT(*) FROM products WHERE availability='out_of_stock') AS out_of_stock,
    (SELECT COUNT(*) FROM orders WHERE status='pending') AS pending_orders,
    (SELECT COUNT(*) FROM quotes WHERE status IN ('new','reviewing')) AS pending_quotes,
    (SELECT COALESCE(SUM(total),0) FROM orders WHERE status!='cancelled') AS sales`);
  const row = result.rows[0];
  response.json({ products: Number(row.products), outOfStock: Number(row.out_of_stock), pendingOrders: Number(row.pending_orders), pendingQuotes: Number(row.pending_quotes), sales: Number(row.sales) });
});

app.get('/api/admin/categories', requireAdmin, async (_request, response) => response.json((await pool.query('SELECT * FROM categories ORDER BY sort_order,name')).rows.map((row) => ({ ...row, id: Number(row.id), sort_order: Number(row.sort_order) }))));
app.post('/api/admin/categories', requireAdmin, async (request, response) => {
  const name = String(request.body.name || '').trim(); const slug = slugify(request.body.slug || name);
  if (!name || !slug) return response.status(400).json({ error: 'La categoría necesita un nombre.' });
  try { const row = (await pool.query('INSERT INTO categories (name,slug,sort_order) VALUES ($1,$2,$3) RETURNING *', [name, slug, Number(request.body.sort_order) || 0])).rows[0]; response.status(201).json({ ...row, id: Number(row.id) }); }
  catch (error) { if (error.code === '23505') return response.status(409).json({ error: 'Ya existe esa categoría.' }); throw error; }
});
app.put('/api/admin/categories/:id', requireAdmin, async (request, response) => {
  const name = String(request.body.name || '').trim(); const slug = slugify(request.body.slug || name);
  try { const result = await pool.query('UPDATE categories SET name=$1,slug=$2,sort_order=$3 WHERE id=$4 RETURNING id', [name, slug, Number(request.body.sort_order) || 0, request.params.id]); if (!result.rowCount) return response.status(404).json({ error: 'Categoría no encontrada.' }); response.json({ message: 'Categoría actualizada.' }); }
  catch (error) { if (error.code === '23505') return response.status(409).json({ error: 'Nombre o identificador duplicado.' }); throw error; }
});
app.delete('/api/admin/categories/:id', requireAdmin, async (request, response) => {
  const used = Number((await pool.query('SELECT COUNT(*) AS total FROM products WHERE category_id=$1', [request.params.id])).rows[0].total);
  if (used) return response.status(409).json({ error: 'Mueve los productos antes de eliminar la categoría.' });
  await pool.query('DELETE FROM categories WHERE id=$1', [request.params.id]); response.status(204).end();
});

app.get('/api/admin/products', requireAdmin, async (_request, response) => response.json((await pool.query(`${productSelect} ORDER BY products.sort_order,products.id`)).rows.map(mapProduct)));

function productFields(request, existing = {}) {
  const salePrice = request.body.sale_price === '' || request.body.sale_price === undefined ? null : Number(request.body.sale_price);
  const saleStart = request.body.sale_start ? new Date(request.body.sale_start) : null;
  const saleEnd = request.body.sale_end ? new Date(request.body.sale_end) : null;
  return { name: String(request.body.name || '').trim(), categoryId: Number(request.body.category_id), label: String(request.body.label || '').trim(), description: String(request.body.description || '').trim(), price: Number(request.body.price), salePrice, saleStart: saleStart && !Number.isNaN(saleStart.valueOf()) ? saleStart.toISOString() : null, saleEnd: saleEnd && !Number.isNaN(saleEnd.valueOf()) ? saleEnd.toISOString() : null, taxStatus: ['taxable','none'].includes(request.body.tax_status) ? request.body.tax_status : 'taxable', taxClass: ['standard','zero','exempt'].includes(request.body.tax_class) ? request.body.tax_class : 'standard', showPrice: request.body.show_price === 'true' || request.body.show_price === 'on', image: request.file ? `images/uploads/${request.file.filename}` : String(request.body.image || existing.image || ''), alt: String(request.body.alt || request.body.name || '').trim(), stock: Math.max(0, Number.parseInt(request.body.stock, 10) || 0), availability: ['available', 'out_of_stock', 'hidden'].includes(request.body.availability) ? request.body.availability : 'available', sortOrder: Number.parseInt(request.body.sort_order, 10) || 0 };
}
app.post('/api/admin/products', requireAdmin, upload.single('image_file'), async (request, response) => {
  const p = productFields(request); if (!p.name || !p.categoryId || !Number.isFinite(p.price) || p.price < 0) return response.status(400).json({ error: 'Completa nombre, categoría y precio.' });
  if (p.salePrice !== null && (!Number.isFinite(p.salePrice) || p.salePrice < 0 || p.salePrice >= p.price)) return response.status(400).json({ error: 'El precio rebajado debe ser menor que el precio normal.' });
  if (p.saleStart && p.saleEnd && p.saleEnd <= p.saleStart) return response.status(400).json({ error: 'La fecha final de la oferta debe ser posterior al inicio.' });
  const row = (await pool.query(`INSERT INTO products (name,category_id,label,description,price,sale_price,sale_start,sale_end,tax_status,tax_class,show_price,image,alt,stock,availability,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`, [p.name,p.categoryId,p.label,p.description,p.price,p.salePrice,p.saleStart,p.saleEnd,p.taxStatus,p.taxClass,p.showPrice,p.image,p.alt,p.stock,p.availability,p.sortOrder])).rows[0];
  response.status(201).json({ id: Number(row.id) });
});
app.put('/api/admin/products/:id', requireAdmin, upload.single('image_file'), async (request, response) => {
  const existing = (await pool.query('SELECT * FROM products WHERE id=$1', [request.params.id])).rows[0]; if (!existing) return response.status(404).json({ error: 'Producto no encontrado.' });
  const p = productFields(request, existing); if (!p.name || !p.categoryId || !Number.isFinite(p.price) || p.price < 0) return response.status(400).json({ error: 'Completa nombre, categoría y precio.' });
  if (p.salePrice !== null && (!Number.isFinite(p.salePrice) || p.salePrice < 0 || p.salePrice >= p.price)) return response.status(400).json({ error: 'El precio rebajado debe ser menor que el precio normal.' });
  if (p.saleStart && p.saleEnd && p.saleEnd <= p.saleStart) return response.status(400).json({ error: 'La fecha final de la oferta debe ser posterior al inicio.' });
  await pool.query(`UPDATE products SET name=$1,category_id=$2,label=$3,description=$4,price=$5,sale_price=$6,sale_start=$7,sale_end=$8,tax_status=$9,tax_class=$10,show_price=$11,image=$12,alt=$13,stock=$14,availability=$15,sort_order=$16,updated_at=NOW() WHERE id=$17`, [p.name,p.categoryId,p.label,p.description,p.price,p.salePrice,p.saleStart,p.saleEnd,p.taxStatus,p.taxClass,p.showPrice,p.image,p.alt,p.stock,p.availability,p.sortOrder,request.params.id]);
  response.json({ message: 'Producto actualizado.' });
});
app.patch('/api/admin/products/:id/visibility', requireAdmin, async (request, response) => {
  const result = await pool.query("UPDATE products SET availability=CASE WHEN availability='hidden' THEN 'available' ELSE 'hidden' END,updated_at=NOW() WHERE id=$1 RETURNING availability", [request.params.id]);
  if (!result.rowCount) return response.status(404).json({ error: 'Producto no encontrado.' });
  response.json({ availability: result.rows[0].availability });
});
app.patch('/api/admin/products/:id/price-visibility', requireAdmin, async (request, response) => {
  const result = await pool.query('UPDATE products SET show_price=NOT show_price,updated_at=NOW() WHERE id=$1 RETURNING show_price', [request.params.id]);
  if (!result.rowCount) return response.status(404).json({ error: 'Producto no encontrado.' });
  response.json({ show_price: result.rows[0].show_price });
});
app.delete('/api/admin/products/:id', requireAdmin, async (request, response) => { await pool.query('DELETE FROM products WHERE id=$1', [request.params.id]); response.status(204).end(); });

app.post('/api/orders', orderLimiter, async (request, response) => {
  const customerName = String(request.body.customer_name || '').trim(); const phone = String(request.body.phone || '').trim(); const items = Array.isArray(request.body.items) ? request.body.items : [];
  if (!customerName || phone.length < 7 || !items.length) return response.status(400).json({ error: 'Indica nombre, teléfono y productos.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); const normalized = [];
    for (const item of items) {
      const product = mapProduct((await client.query("SELECT * FROM products WHERE id=$1 AND availability='available' FOR UPDATE", [item.product_id])).rows[0]);
      const quantity = Math.max(1, Number.parseInt(item.quantity, 10) || 1);
      if (!product) { const error = new Error('Uno de los productos ya no está disponible.'); error.status = 409; throw error; }
      if (product.stock > 0 && quantity > product.stock) { const error = new Error(`Solo quedan ${product.stock} unidades de ${product.name}.`); error.status = 409; throw error; }
      const unitPrice = effectiveProductPrice(product);
      normalized.push({ product, unitPrice, quantity, subtotal: Number((unitPrice * quantity).toFixed(3)) });
    }
    const total = Number(normalized.reduce((sum, item) => sum + item.subtotal, 0).toFixed(3));
    const order = (await client.query(`INSERT INTO orders (customer_name,email,phone,address,notes,total) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [customerName,String(request.body.email||'').trim(),phone,String(request.body.address||'').trim(),String(request.body.notes||'').trim(),total])).rows[0];
    for (const item of normalized) {
      await client.query('INSERT INTO order_items (order_id,product_id,product_name,unit_price,quantity,subtotal) VALUES ($1,$2,$3,$4,$5,$6)', [order.id,item.product.id,item.product.name,item.unitPrice,item.quantity,item.subtotal]);
      if (item.product.stock > 0) await client.query("UPDATE products SET stock=stock-$1,availability=CASE WHEN stock-$1<=0 THEN 'out_of_stock' ELSE availability END WHERE id=$2", [item.quantity,item.product.id]);
    }
    await client.query('COMMIT'); response.status(201).json({ id: Number(order.id), total, message: 'Pedido recibido.' });
  } catch (error) { await client.query('ROLLBACK'); if (error.status) return response.status(error.status).json({ error: error.message }); throw error; }
  finally { client.release(); }
});

app.post('/api/quotes', orderLimiter, async (request, response) => {
  if ((await publicSettings()).quote_enabled !== 'true') return response.status(403).json({ error: 'Las cotizaciones están desactivadas.' });
  const name=String(request.body.customer_name||'').trim(), email=String(request.body.email||'').trim().toLowerCase(), phone=String(request.body.phone||'').trim(), product=String(request.body.product||'').trim(), message=String(request.body.message||'').trim();
  if (!name || !/^\S+@\S+\.\S+$/.test(email) || !product) return response.status(400).json({ error: 'Completa nombre, correo y producto.' });
  const row=(await pool.query('INSERT INTO quotes (customer_name,email,phone,product,message) VALUES ($1,$2,$3,$4,$5) RETURNING id',[name,email,phone,product,message])).rows[0]; response.status(201).json({ id:Number(row.id),message:'Cotización recibida.' });
});

app.get('/api/admin/orders', requireAdmin, async (_request,response)=>{const orders=(await pool.query('SELECT * FROM orders ORDER BY created_at DESC,id DESC')).rows;const items=(await pool.query('SELECT * FROM order_items ORDER BY id')).rows;response.json(orders.map((order)=>({...order,id:Number(order.id),total:Number(order.total),items:items.filter((item)=>String(item.order_id)===String(order.id)).map((item)=>({...item,id:Number(item.id),order_id:Number(item.order_id),product_id:item.product_id?Number(item.product_id):null,unit_price:Number(item.unit_price),quantity:Number(item.quantity),subtotal:Number(item.subtotal)}))})));});
app.patch('/api/admin/orders/:id', requireAdmin, async (request,response)=>{if(!['pending','confirmed','completed','cancelled'].includes(request.body.status))return response.status(400).json({error:'Estado no válido.'});await pool.query('UPDATE orders SET status=$1 WHERE id=$2',[request.body.status,request.params.id]);response.json({message:'Venta actualizada.'});});
app.get('/api/admin/quotes', requireAdmin, async (_request,response)=>response.json((await pool.query('SELECT * FROM quotes ORDER BY created_at DESC,id DESC')).rows.map((row)=>({...row,id:Number(row.id)}))));
app.patch('/api/admin/quotes/:id', requireAdmin, async (request,response)=>{if(!['new','reviewing','answered','discarded'].includes(request.body.status))return response.status(400).json({error:'Estado no válido.'});await pool.query('UPDATE quotes SET status=$1 WHERE id=$2',[request.body.status,request.params.id]);response.json({message:'Cotización actualizada.'});});
app.delete('/api/admin/quotes/:id', requireAdmin, async (request,response)=>{await pool.query('DELETE FROM quotes WHERE id=$1',[request.params.id]);response.status(204).end();});

app.get('/api/admin/settings', requireAdmin, async (_request,response)=>response.json(await publicSettings()));
app.put('/api/admin/settings', requireAdmin, async (request,response)=>{for(const key of Object.keys(defaults)){if(request.body[key]!==undefined)await pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value',[key,String(request.body[key]).trim()]);}if(request.body.admin_email){const login=String(request.body.admin_email).trim().toLowerCase();if(login.length<3)return response.status(400).json({error:'Usuario administrativo no válido.'});try{await pool.query('UPDATE admins SET email=$1 WHERE id=$2',[login,request.admin.id]);}catch(error){if(error.code==='23505')return response.status(409).json({error:'Ese usuario ya existe.'});throw error;}}response.json({message:'Configuración guardada.'});});
app.put('/api/admin/password', requireAdmin, authLimiter, async (request,response)=>{const admin=(await pool.query('SELECT * FROM admins WHERE id=$1',[request.admin.id])).rows[0];if(!verifyPassword(String(request.body.current_password||''),admin.password_hash))return response.status(401).json({error:'La contraseña actual no coincide.'});if(String(request.body.new_password||'').length<10)return response.status(400).json({error:'La nueva contraseña debe tener al menos 10 caracteres.'});await pool.query('UPDATE admins SET password_hash=$1 WHERE id=$2',[hashPassword(request.body.new_password),admin.id]);await pool.query('DELETE FROM sessions WHERE admin_id=$1 AND token_hash!=$2',[admin.id,request.sessionHash]);response.json({message:'Contraseña actualizada.'});});

app.use(express.static(root,{extensions:['html']}));
app.use((error,_request,response,_next)=>{console.error(error);if(error instanceof multer.MulterError)return response.status(400).json({error:'La imagen es demasiado grande o no es válida.'});if(error.code==='23503')return response.status(400).json({error:'La categoría seleccionada no existe.'});response.status(500).json({error:'Ocurrió un error inesperado.'});});

const port=Number(process.env.PORT)||3000;
initializeDatabase().then(()=>app.listen(port,()=>console.log(`Maconta Plast con PostgreSQL disponible en http://localhost:${port}`))).catch((error)=>{console.error('No se pudo inicializar PostgreSQL:',error);process.exit(1);});

async function shutdown(){await pool.end();process.exit(0);}process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
