const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

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

async function normalizeCategoryOrder(database = pool) {
  const rows = (await database.query('SELECT id FROM categories ORDER BY sort_order,id')).rows;
  for (let index = 0; index < rows.length; index += 1) await database.query('UPDATE categories SET sort_order=$1 WHERE id=$2', [index + 1, rows[index].id]);
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
  for (const entry of (request.headers.cookie || '').split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0 || entry.slice(0, separator).trim() !== 'maconta_session') continue;
    try { return decodeURIComponent(entry.slice(separator + 1).trim()); } catch { return ''; }
  }
  return '';
}

function mapProduct(row) {
  return row ? { ...row, id: Number(row.id), category_id: Number(row.category_id), price: Number(row.price), sale_price: row.sale_price === null ? null : Number(row.sale_price), stock: Number(row.stock), min_stock: Number(row.min_stock), sort_order: Number(row.sort_order) } : row;
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
      min_stock INTEGER NOT NULL DEFAULT 0 CHECK(min_stock >= 0),
      track_inventory BOOLEAN NOT NULL DEFAULT TRUE,
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
    CREATE TABLE IF NOT EXISTS customers (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      tax_id TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id BIGSERIAL PRIMARY KEY,
      product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      admin_id BIGINT REFERENCES admins(id) ON DELETE SET NULL,
      movement_type TEXT NOT NULL CHECK(movement_type IN ('entry','exit','adjustment')),
      quantity_change INTEGER NOT NULL CHECK(quantity_change != 0),
      stock_before INTEGER NOT NULL,
      stock_after INTEGER NOT NULL CHECK(stock_after >= 0),
      reason TEXT NOT NULL CHECK(reason IN ('purchase','sale','damage','correction')),
      notes TEXT NOT NULL DEFAULT '',
      reference_type TEXT NOT NULL DEFAULT '',
      reference_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS show_price BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_price NUMERIC(12,3) CHECK(sale_price IS NULL OR sale_price >= 0);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_start TIMESTAMPTZ;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_end TIMESTAMPTZ;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_status TEXT NOT NULL DEFAULT 'taxable';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_class TEXT NOT NULL DEFAULT 'standard';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS min_stock INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS track_inventory BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL;
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_quotes_created ON quotes(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(LOWER(email));
    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
    CREATE INDEX IF NOT EXISTS idx_inventory_product_date ON inventory_movements(product_id,created_at DESC);
  `);

  for (const [key, value] of Object.entries(defaults)) {
    await pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [key, value]);
  }

  const adminCount = Number((await pool.query('SELECT COUNT(*) AS total FROM admins')).rows[0].total);
  if (!adminCount) {
    const user = String(process.env.ADMIN_USER || '').trim().toLowerCase();
    const password = String(process.env.ADMIN_PASSWORD || '');
    if (user && password) {
      if (process.env.NODE_ENV === 'production' && (user === 'admin1' || password === 'admin1' || password.length < 10)) throw new Error('Configura ADMIN_USER y una ADMIN_PASSWORD segura de al menos 10 caracteres.');
      await pool.query('INSERT INTO admins (email,password_hash) VALUES ($1,$2)', [user, hashPassword(password)]);
    }
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

  await normalizeCategoryOrder();

  const legacyOrders = (await pool.query('SELECT * FROM orders WHERE customer_id IS NULL')).rows;
  await pool.query(`INSERT INTO inventory_movements (product_id,movement_type,quantity_change,stock_before,stock_after,reason,notes)
    SELECT products.id,'adjustment',products.stock,0,products.stock,'correction','Existencia inicial migrada' FROM products
    WHERE products.track_inventory AND products.stock>0 AND NOT EXISTS (SELECT 1 FROM inventory_movements WHERE inventory_movements.product_id=products.id)`);
  for (const order of legacyOrders) {
    const customerId = await upsertCustomer(pool, { name: order.customer_name, email: order.email, phone: order.phone, address: order.address });
    await pool.query('UPDATE orders SET customer_id=$1 WHERE id=$2', [customerId, order.id]);
  }
  const legacyQuotes = (await pool.query('SELECT * FROM quotes WHERE customer_id IS NULL')).rows;
  for (const quote of legacyQuotes) {
    const customerId = await upsertCustomer(pool, { name: quote.customer_name, email: quote.email, phone: quote.phone });
    await pool.query('UPDATE quotes SET customer_id=$1 WHERE id=$2', [customerId, quote.id]);
  }
}

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(compression());
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

async function upsertCustomer(database, data) {
  const name = String(data.name || 'Cliente').trim();
  const email = String(data.email || '').trim().toLowerCase();
  const phone = String(data.phone || '').trim();
  const address = String(data.address || '').trim();
  const taxId = String(data.tax_id || '').trim();
  const found = (await database.query(`SELECT id FROM customers WHERE ($1<>'' AND LOWER(email)=LOWER($1)) OR ($2<>'' AND phone=$2) ORDER BY id LIMIT 1`, [email,phone])).rows[0];
  if (found) {
    await database.query(`UPDATE customers SET name=COALESCE(NULLIF($1,''),name),email=COALESCE(NULLIF($2,''),email),phone=COALESCE(NULLIF($3,''),phone),address=COALESCE(NULLIF($4,''),address),tax_id=COALESCE(NULLIF($5,''),tax_id),updated_at=NOW() WHERE id=$6`, [name,email,phone,address,taxId,found.id]);
    return found.id;
  }
  return (await database.query('INSERT INTO customers (name,email,phone,address,tax_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',[name,email,phone,address,taxId])).rows[0].id;
}

const productSelect = `SELECT products.*,categories.name AS category_name,categories.slug AS category_slug
  FROM products JOIN categories ON categories.id=products.category_id`;

app.get('/api/health', async (_request, response) => {
  await pool.query('SELECT 1');
  response.json({ status: 'ok', database: 'postgresql' });
});

app.get('/api/store', async (_request, response) => {
  response.set('Cache-Control', 'no-store');
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
  if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 10) return response.status(400).json({ error: 'Usa un correo válido y una contraseña de al menos 10 caracteres.' });
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
    (SELECT COUNT(*) FROM products WHERE track_inventory AND stock<=min_stock) AS low_stock,
    (SELECT COUNT(*) FROM orders WHERE status='pending') AS pending_orders,
    (SELECT COUNT(*) FROM quotes WHERE status IN ('new','reviewing')) AS pending_quotes,
    (SELECT COALESCE(SUM(total),0) FROM orders WHERE status!='cancelled') AS sales`);
  const row = result.rows[0];
  response.json({ products: Number(row.products), lowStock: Number(row.low_stock), pendingOrders: Number(row.pending_orders), pendingQuotes: Number(row.pending_quotes), sales: Number(row.sales) });
});

app.get('/api/admin/categories', requireAdmin, async (_request, response) => response.json((await pool.query('SELECT * FROM categories ORDER BY sort_order,name')).rows.map((row) => ({ ...row, id: Number(row.id), sort_order: Number(row.sort_order) }))));
app.post('/api/admin/categories', requireAdmin, async (request, response) => {
  const name = String(request.body.name || '').trim(); const slug = slugify(request.body.slug || name);
  if (!name || !slug) return response.status(400).json({ error: 'La categoría necesita un nombre.' });
  const client=await pool.connect();try{await client.query('BEGIN');await normalizeCategoryOrder(client);const count=Number((await client.query('SELECT COUNT(*) AS total FROM categories')).rows[0].total),desired=Math.min(Math.max(1,Number.parseInt(request.body.sort_order,10)||count+1),count+1);await client.query('UPDATE categories SET sort_order=sort_order+1 WHERE sort_order>=$1',[desired]);const row=(await client.query('INSERT INTO categories (name,slug,sort_order) VALUES ($1,$2,$3) RETURNING *',[name,slug,desired])).rows[0];await client.query('COMMIT');response.status(201).json({...row,id:Number(row.id)});}catch(error){await client.query('ROLLBACK');if(error.code==='23505')return response.status(409).json({error:'Ya existe esa categoría.'});throw error;}finally{client.release();}
});
app.put('/api/admin/categories/:id', requireAdmin, async (request, response) => {
  const name = String(request.body.name || '').trim(); const slug = slugify(request.body.slug || name);
  const client=await pool.connect();try{await client.query('BEGIN');await normalizeCategoryOrder(client);const current=(await client.query('SELECT * FROM categories WHERE id=$1 FOR UPDATE',[request.params.id])).rows[0];if(!current){await client.query('ROLLBACK');return response.status(404).json({error:'Categoría no encontrada.'});}const count=Number((await client.query('SELECT COUNT(*) AS total FROM categories')).rows[0].total),desired=Math.min(Math.max(1,Number.parseInt(request.body.sort_order,10)||Number(current.sort_order)),count),old=Number(current.sort_order);if(desired<old)await client.query('UPDATE categories SET sort_order=sort_order+1 WHERE sort_order>=$1 AND sort_order<$2 AND id!=$3',[desired,old,current.id]);if(desired>old)await client.query('UPDATE categories SET sort_order=sort_order-1 WHERE sort_order>$1 AND sort_order<=$2 AND id!=$3',[old,desired,current.id]);await client.query('UPDATE categories SET name=$1,slug=$2,sort_order=$3 WHERE id=$4',[name,slug,desired,current.id]);await client.query('COMMIT');response.json({message:'Categoría actualizada.'});}catch(error){await client.query('ROLLBACK');if(error.code==='23505')return response.status(409).json({error:'Nombre o identificador duplicado.'});throw error;}finally{client.release();}
});
app.delete('/api/admin/categories/:id', requireAdmin, async (request, response) => {
  const used = Number((await pool.query('SELECT COUNT(*) AS total FROM products WHERE category_id=$1', [request.params.id])).rows[0].total);
  if (used) return response.status(409).json({ error: 'Mueve los productos antes de eliminar la categoría.' });
  await pool.query('DELETE FROM categories WHERE id=$1', [request.params.id]); await normalizeCategoryOrder(); response.status(204).end();
});

app.get('/api/admin/products', requireAdmin, async (_request, response) => response.json((await pool.query(`${productSelect} ORDER BY products.sort_order,products.id`)).rows.map(mapProduct)));

function productFields(request, existing = {}) {
  const salePrice = request.body.sale_price === '' || request.body.sale_price === undefined ? null : Number(request.body.sale_price);
  const saleStart = request.body.sale_start ? new Date(request.body.sale_start) : null;
  const saleEnd = request.body.sale_end ? new Date(request.body.sale_end) : null;
  return { name: String(request.body.name || '').trim(), categoryId: Number(request.body.category_id), label: String(request.body.label || '').trim(), description: String(request.body.description || '').trim(), price: Number(request.body.price), salePrice, saleStart: saleStart && !Number.isNaN(saleStart.valueOf()) ? saleStart.toISOString() : null, saleEnd: saleEnd && !Number.isNaN(saleEnd.valueOf()) ? saleEnd.toISOString() : null, taxStatus: ['taxable','none'].includes(request.body.tax_status) ? request.body.tax_status : 'taxable', taxClass: ['standard','zero','exempt'].includes(request.body.tax_class) ? request.body.tax_class : 'standard', showPrice: request.body.show_price === 'true' || request.body.show_price === 'on', image: request.file ? `images/uploads/${request.file.filename}` : String(request.body.image || existing.image || ''), alt: String(request.body.alt || request.body.name || '').trim(), stock: Math.max(0, Number.parseInt(request.body.stock, 10) || 0), minStock: Math.max(0, Number.parseInt(request.body.min_stock, 10) || 0), trackInventory: request.body.track_inventory === 'true' || request.body.track_inventory === 'on', availability: ['available', 'out_of_stock', 'hidden'].includes(request.body.availability) ? request.body.availability : 'available', sortOrder: Number.parseInt(request.body.sort_order, 10) || 0 };
}
function validateProduct(product) {
  if (!product.name || !product.categoryId || !Number.isFinite(product.price) || product.price < 0) return 'Completa nombre, categoría y precio.';
  if (product.salePrice !== null && (!Number.isFinite(product.salePrice) || product.salePrice < 0 || product.salePrice >= product.price)) return 'El precio rebajado debe ser menor que el precio normal.';
  if (product.saleStart && product.saleEnd && product.saleEnd <= product.saleStart) return 'La fecha final de la oferta debe ser posterior al inicio.';
  return '';
}
async function deleteUploadedImage(imagePath) {
  if (!String(imagePath || '').startsWith('images/uploads/')) return;
  const target = path.resolve(root, imagePath);
  if (path.dirname(target) !== path.resolve(uploadDir)) return;
  try { await fs.promises.unlink(target); } catch (error) { if (error.code !== 'ENOENT') console.warn(`No se pudo eliminar la imagen ${target}:`,error.message); }
}
app.post('/api/admin/products', requireAdmin, upload.single('image_file'), async (request, response) => {
  const p = productFields(request); const validation = validateProduct(p); if (validation) { if (request.file) await deleteUploadedImage(`images/uploads/${request.file.filename}`); return response.status(400).json({ error: validation }); }
  const row = (await pool.query(`INSERT INTO products (name,category_id,label,description,price,sale_price,sale_start,sale_end,tax_status,tax_class,show_price,image,alt,stock,min_stock,track_inventory,availability,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`, [p.name,p.categoryId,p.label,p.description,p.price,p.salePrice,p.saleStart,p.saleEnd,p.taxStatus,p.taxClass,p.showPrice,p.image,p.alt,p.stock,p.minStock,p.trackInventory,p.availability,p.sortOrder])).rows[0];
  if (p.trackInventory && p.stock > 0) await pool.query("INSERT INTO inventory_movements (product_id,admin_id,movement_type,quantity_change,stock_before,stock_after,reason,notes) VALUES ($1,$2,'entry',$3,0,$3,'correction','Stock inicial')", [row.id,request.admin.id,p.stock]);
  response.status(201).json({ id: Number(row.id) });
});
app.put('/api/admin/products/:id', requireAdmin, upload.single('image_file'), async (request, response) => {
  const existing = (await pool.query('SELECT * FROM products WHERE id=$1', [request.params.id])).rows[0]; if (!existing) { if(request.file)await deleteUploadedImage(`images/uploads/${request.file.filename}`);return response.status(404).json({ error: 'Producto no encontrado.' }); }
  const p = productFields(request, existing); const validation = validateProduct(p); if (validation) { if (request.file) await deleteUploadedImage(`images/uploads/${request.file.filename}`); return response.status(400).json({ error: validation }); }
  await pool.query(`UPDATE products SET name=$1,category_id=$2,label=$3,description=$4,price=$5,sale_price=$6,sale_start=$7,sale_end=$8,tax_status=$9,tax_class=$10,show_price=$11,image=$12,alt=$13,stock=$14,min_stock=$15,track_inventory=$16,availability=$17,sort_order=$18,updated_at=NOW() WHERE id=$19`, [p.name,p.categoryId,p.label,p.description,p.price,p.salePrice,p.saleStart,p.saleEnd,p.taxStatus,p.taxClass,p.showPrice,p.image,p.alt,p.stock,p.minStock,p.trackInventory,p.availability,p.sortOrder,request.params.id]);
  const previousStock = Number(existing.stock);
  if (p.trackInventory && p.stock !== previousStock) await pool.query("INSERT INTO inventory_movements (product_id,admin_id,movement_type,quantity_change,stock_before,stock_after,reason,notes) VALUES ($1,$2,'adjustment',$3,$4,$5,'correction','Cambio desde el editor de producto')", [request.params.id,request.admin.id,p.stock-previousStock,previousStock,p.stock]);
  if (request.file && existing.image !== p.image) await deleteUploadedImage(existing.image);
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
app.delete('/api/admin/products/:id', requireAdmin, async (request, response) => { const product=(await pool.query('DELETE FROM products WHERE id=$1 RETURNING image',[request.params.id])).rows[0];if(!product)return response.status(404).json({error:'Producto no encontrado.'});await deleteUploadedImage(product.image);response.status(204).end(); });

app.post('/api/orders', orderLimiter, async (request, response) => {
  const customerName = String(request.body.customer_name || '').trim().slice(0,160); const phone = String(request.body.phone || '').trim().slice(0,40); const items = Array.isArray(request.body.items) ? request.body.items : [];
  if (!customerName || phone.length < 7 || !items.length || items.length > 100) return response.status(400).json({ error: 'Indica nombre, teléfono y una lista válida de productos.' });
  const quantities = new Map();
  for (const item of items) { const productId=Number(item.product_id),quantity=Number.parseInt(item.quantity,10);if(!Number.isSafeInteger(productId)||productId<=0||!Number.isSafeInteger(quantity)||quantity<=0||quantity>100000)return response.status(400).json({error:'La cantidad de un producto no es válida.'});quantities.set(productId,(quantities.get(productId)||0)+quantity); }
  if ([...quantities.values()].some((quantity)=>quantity>100000)) return response.status(400).json({error:'La cantidad solicitada es demasiado alta.'});
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); const normalized = [];
    for (const [productId, quantity] of quantities) {
      const product = mapProduct((await client.query("SELECT * FROM products WHERE id=$1 AND availability='available' FOR UPDATE", [productId])).rows[0]);
      if (!product) { const error = new Error('Uno de los productos ya no está disponible.'); error.status = 409; throw error; }
      if (product.track_inventory && quantity > product.stock) { const error = new Error(`Solo quedan ${product.stock} unidades de ${product.name}.`); error.status = 409; throw error; }
      const unitPrice = effectiveProductPrice(product);
      normalized.push({ product, unitPrice, quantity, subtotal: Number((unitPrice * quantity).toFixed(3)) });
    }
    const total = Number(normalized.reduce((sum, item) => sum + item.subtotal, 0).toFixed(3));
    const customerData = { name: customerName, email: request.body.email, phone, address: request.body.address, tax_id: request.body.tax_id };
    const customerId = await upsertCustomer(client, customerData);
    const order = (await client.query(`INSERT INTO orders (customer_id,customer_name,email,phone,address,notes,total) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [customerId,customerName,String(request.body.email||'').trim(),phone,String(request.body.address||'').trim(),String(request.body.notes||'').trim(),total])).rows[0];
    for (const item of normalized) {
      await client.query('INSERT INTO order_items (order_id,product_id,product_name,unit_price,quantity,subtotal) VALUES ($1,$2,$3,$4,$5,$6)', [order.id,item.product.id,item.product.name,item.unitPrice,item.quantity,item.subtotal]);
      if (item.product.track_inventory) {
        const stockAfter = item.product.stock-item.quantity;
        await client.query("UPDATE products SET stock=$1,availability=CASE WHEN $1<=0 THEN 'out_of_stock' ELSE availability END WHERE id=$2", [stockAfter,item.product.id]);
        await client.query("INSERT INTO inventory_movements (product_id,movement_type,quantity_change,stock_before,stock_after,reason,notes,reference_type,reference_id) VALUES ($1,'exit',$2,$3,$4,'sale','Salida automática por pedido','order',$5)",[item.product.id,-item.quantity,item.product.stock,stockAfter,order.id]);
      }
    }
    await client.query('COMMIT'); response.status(201).json({ id: Number(order.id), total, message: 'Pedido recibido.' });
  } catch (error) { await client.query('ROLLBACK'); if (error.status) return response.status(error.status).json({ error: error.message }); throw error; }
  finally { client.release(); }
});

app.post('/api/quotes', orderLimiter, async (request, response) => {
  if ((await publicSettings()).quote_enabled !== 'true') return response.status(403).json({ error: 'Las cotizaciones están desactivadas.' });
  const name=String(request.body.customer_name||'').trim(), email=String(request.body.email||'').trim().toLowerCase(), phone=String(request.body.phone||'').trim(), product=String(request.body.product||'').trim(), message=String(request.body.message||'').trim();
  if (!name || !/^\S+@\S+\.\S+$/.test(email) || !product) return response.status(400).json({ error: 'Completa nombre, correo y producto.' });
  const customerId=await upsertCustomer(pool,{name,email,phone,tax_id:request.body.tax_id});
  const row=(await pool.query('INSERT INTO quotes (customer_id,customer_name,email,phone,product,message) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',[customerId,name,email,phone,product,message])).rows[0]; response.status(201).json({ id:Number(row.id),message:'Cotización recibida.' });
});

app.get('/api/admin/orders', requireAdmin, async (_request,response)=>{const orders=(await pool.query('SELECT * FROM orders ORDER BY created_at DESC,id DESC')).rows;const items=(await pool.query('SELECT * FROM order_items ORDER BY id')).rows;response.json(orders.map((order)=>({...order,id:Number(order.id),total:Number(order.total),items:items.filter((item)=>String(item.order_id)===String(order.id)).map((item)=>({...item,id:Number(item.id),order_id:Number(item.order_id),product_id:item.product_id?Number(item.product_id):null,unit_price:Number(item.unit_price),quantity:Number(item.quantity),subtotal:Number(item.subtotal)}))})));});
app.patch('/api/admin/orders/:id', requireAdmin, async (request,response)=>{
  const nextStatus=request.body.status;if(!['pending','confirmed','completed','cancelled'].includes(nextStatus))return response.status(400).json({error:'Estado no válido.'});const client=await pool.connect();
  try{await client.query('BEGIN');const order=(await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[request.params.id])).rows[0];if(!order){await client.query('ROLLBACK');return response.status(404).json({error:'Venta no encontrada.'});}
    if(order.status!==nextStatus&&(order.status==='cancelled'||nextStatus==='cancelled')){const items=(await client.query('SELECT * FROM order_items WHERE order_id=$1',[order.id])).rows;for(const item of items){const product=(await client.query('SELECT * FROM products WHERE id=$1 FOR UPDATE',[item.product_id])).rows[0];if(!product||!product.track_inventory)continue;const before=Number(product.stock),change=nextStatus==='cancelled'?Number(item.quantity):-Number(item.quantity),after=before+change;if(after<0){await client.query('ROLLBACK');return response.status(409).json({error:`Stock insuficiente para reactivar el pedido: ${product.name}.`});}await client.query("UPDATE products SET stock=$1,availability=CASE WHEN availability='hidden' THEN availability WHEN $1=0 THEN 'out_of_stock' ELSE 'available' END WHERE id=$2",[after,product.id]);await client.query("INSERT INTO inventory_movements (product_id,admin_id,movement_type,quantity_change,stock_before,stock_after,reason,notes,reference_type,reference_id) VALUES ($1,$2,$3,$4,$5,$6,'sale',$7,'order',$8)",[product.id,request.admin.id,change>0?'entry':'exit',change,before,after,nextStatus==='cancelled'?'Devolución por pedido cancelado':'Salida por pedido reactivado',order.id]);}}
    await client.query('UPDATE orders SET status=$1 WHERE id=$2',[nextStatus,order.id]);await client.query('COMMIT');response.json({message:'Venta actualizada.'});
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
});
app.get('/api/admin/quotes', requireAdmin, async (_request,response)=>response.json((await pool.query('SELECT * FROM quotes ORDER BY created_at DESC,id DESC')).rows.map((row)=>({...row,id:Number(row.id)}))));
app.patch('/api/admin/quotes/:id', requireAdmin, async (request,response)=>{if(!['new','reviewing','answered','discarded'].includes(request.body.status))return response.status(400).json({error:'Estado no válido.'});await pool.query('UPDATE quotes SET status=$1 WHERE id=$2',[request.body.status,request.params.id]);response.json({message:'Cotización actualizada.'});});
app.delete('/api/admin/quotes/:id', requireAdmin, async (request,response)=>{await pool.query('DELETE FROM quotes WHERE id=$1',[request.params.id]);response.status(204).end();});

app.get('/api/admin/inventory', requireAdmin, async (_request,response)=>{
  const products=(await pool.query(`SELECT products.id,products.name,products.price,products.stock,products.min_stock,products.track_inventory,products.availability,categories.name AS category_name
    FROM products JOIN categories ON categories.id=products.category_id ORDER BY (products.track_inventory AND products.stock<=products.min_stock) DESC,products.stock,products.name`)).rows;
  const movements=(await pool.query(`SELECT inventory_movements.*,products.name AS product_name,admins.email AS admin_email
    FROM inventory_movements JOIN products ON products.id=inventory_movements.product_id LEFT JOIN admins ON admins.id=inventory_movements.admin_id
    ORDER BY inventory_movements.created_at DESC,inventory_movements.id DESC LIMIT 300`)).rows;
  response.json({products:products.map((row)=>({...row,id:Number(row.id),price:Number(row.price),stock:Number(row.stock),min_stock:Number(row.min_stock),low_stock:row.track_inventory&&Number(row.stock)<=Number(row.min_stock)})),movements:movements.map((row)=>({...row,id:Number(row.id),product_id:Number(row.product_id),quantity_change:Number(row.quantity_change),stock_before:Number(row.stock_before),stock_after:Number(row.stock_after)}))});
});

app.post('/api/admin/inventory/movements',requireAdmin,async(request,response)=>{
  const productId=Number(request.body.product_id),quantity=Math.max(1,Number.parseInt(request.body.quantity,10)||0),direction=request.body.direction;
  const reason=['purchase','sale','damage','correction'].includes(request.body.reason)?request.body.reason:'correction';
  if(!productId||!['entry','exit'].includes(direction)||!quantity)return response.status(400).json({error:'Selecciona producto, tipo y cantidad.'});
  const validReasons={entry:['purchase','correction'],exit:['sale','damage','correction']};
  if(!validReasons[direction].includes(reason))return response.status(400).json({error:'El motivo no corresponde al tipo de movimiento.'});
  const client=await pool.connect();
  try{await client.query('BEGIN');const product=(await client.query('SELECT * FROM products WHERE id=$1 FOR UPDATE',[productId])).rows[0];if(!product){await client.query('ROLLBACK');return response.status(404).json({error:'Producto no encontrado.'});}
    const before=Number(product.stock),change=direction==='entry'?quantity:-quantity,after=before+change;if(after<0){await client.query('ROLLBACK');return response.status(409).json({error:`No puedes retirar más de ${before} unidades.`});}
    await client.query(`UPDATE products SET stock=$1,track_inventory=TRUE,availability=CASE WHEN availability='hidden' THEN availability WHEN $1=0 THEN 'out_of_stock' ELSE 'available' END,updated_at=NOW() WHERE id=$2`,[after,productId]);
    const row=(await client.query(`INSERT INTO inventory_movements (product_id,admin_id,movement_type,quantity_change,stock_before,stock_after,reason,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[productId,request.admin.id,direction,change,before,after,reason,String(request.body.notes||'').trim()])).rows[0];
    await client.query('COMMIT');response.status(201).json({id:Number(row.id),stock:after,message:'Movimiento registrado.'});
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
});

app.get('/api/admin/customers',requireAdmin,async(_request,response)=>{
  const rows=(await pool.query(`SELECT customers.*,
    (SELECT COUNT(*) FROM orders WHERE orders.customer_id=customers.id)::int AS order_count,
    (SELECT COUNT(*) FROM quotes WHERE quotes.customer_id=customers.id)::int AS quote_count,
    (SELECT COALESCE(SUM(total),0) FROM orders WHERE orders.customer_id=customers.id AND status!='cancelled') AS total_spent,
    (SELECT MAX(created_at) FROM orders WHERE orders.customer_id=customers.id) AS last_order
    FROM customers ORDER BY customers.updated_at DESC`)).rows;
  response.json(rows.map((row)=>({...row,id:Number(row.id),order_count:Number(row.order_count),quote_count:Number(row.quote_count),total_spent:Number(row.total_spent)})));
});
app.post('/api/admin/customers',requireAdmin,async(request,response)=>{const data=request.body;if(!String(data.name||'').trim())return response.status(400).json({error:'El cliente necesita un nombre.'});const row=(await pool.query('INSERT INTO customers (name,email,phone,address,tax_id,notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',[String(data.name).trim(),String(data.email||'').trim().toLowerCase(),String(data.phone||'').trim(),String(data.address||'').trim(),String(data.tax_id||'').trim(),String(data.notes||'').trim()])).rows[0];response.status(201).json({id:Number(row.id)});});
app.get('/api/admin/customers/:id',requireAdmin,async(request,response)=>{const customer=(await pool.query('SELECT * FROM customers WHERE id=$1',[request.params.id])).rows[0];if(!customer)return response.status(404).json({error:'Cliente no encontrado.'});const [orders,quotes]=await Promise.all([pool.query('SELECT id,total,status,created_at FROM orders WHERE customer_id=$1 ORDER BY created_at DESC',[request.params.id]),pool.query('SELECT id,product,status,created_at FROM quotes WHERE customer_id=$1 ORDER BY created_at DESC',[request.params.id])]);response.json({...customer,id:Number(customer.id),orders:orders.rows.map((row)=>({...row,id:Number(row.id),total:Number(row.total)})),quotes:quotes.rows.map((row)=>({...row,id:Number(row.id)}))});});
app.put('/api/admin/customers/:id',requireAdmin,async(request,response)=>{const data=request.body,name=String(data.name||'').trim();if(!name)return response.status(400).json({error:'El cliente necesita un nombre.'});const result=await pool.query('UPDATE customers SET name=$1,email=$2,phone=$3,address=$4,tax_id=$5,notes=$6,updated_at=NOW() WHERE id=$7 RETURNING id',[name,String(data.email||'').trim().toLowerCase(),String(data.phone||'').trim(),String(data.address||'').trim(),String(data.tax_id||'').trim(),String(data.notes||'').trim(),request.params.id]);if(!result.rowCount)return response.status(404).json({error:'Cliente no encontrado.'});response.json({message:'Cliente actualizado.'});});

async function reportData(){
  const [summary,daily,monthly,annual,top,slow]=await Promise.all([
    pool.query(`SELECT COALESCE(SUM(total) FILTER(WHERE status!='cancelled'),0) AS sales,COUNT(*) FILTER(WHERE status!='cancelled') AS orders,(SELECT COALESCE(SUM(stock*price),0) FROM products WHERE track_inventory) AS inventory_value,(SELECT COUNT(*) FROM products WHERE track_inventory AND stock<=min_stock) AS low_stock FROM orders`),
    pool.query(`SELECT TO_CHAR(period_start,'YYYY-MM-DD') AS period,COALESCE(SUM(orders.total) FILTER(WHERE status!='cancelled'),0) AS total FROM GENERATE_SERIES(CURRENT_DATE-INTERVAL '29 days',CURRENT_DATE,INTERVAL '1 day') AS dates(period_start) LEFT JOIN orders ON orders.created_at>=period_start AND orders.created_at<period_start+INTERVAL '1 day' GROUP BY period_start ORDER BY period_start`),
    pool.query(`SELECT TO_CHAR(period_start,'YYYY-MM') AS period,COALESCE(SUM(orders.total) FILTER(WHERE status!='cancelled'),0) AS total FROM GENERATE_SERIES(DATE_TRUNC('month',CURRENT_DATE)-INTERVAL '11 months',DATE_TRUNC('month',CURRENT_DATE),INTERVAL '1 month') AS dates(period_start) LEFT JOIN orders ON orders.created_at>=period_start AND orders.created_at<period_start+INTERVAL '1 month' GROUP BY period_start ORDER BY period_start`),
    pool.query(`SELECT EXTRACT(YEAR FROM period_start)::int AS period,COALESCE(SUM(orders.total) FILTER(WHERE status!='cancelled'),0) AS total FROM GENERATE_SERIES(DATE_TRUNC('year',CURRENT_DATE)-INTERVAL '4 years',DATE_TRUNC('year',CURRENT_DATE),INTERVAL '1 year') AS dates(period_start) LEFT JOIN orders ON orders.created_at>=period_start AND orders.created_at<period_start+INTERVAL '1 year' GROUP BY period_start ORDER BY period_start`),
    pool.query(`SELECT order_items.product_name,SUM(order_items.quantity)::int AS units,SUM(order_items.subtotal) AS total FROM order_items JOIN orders ON orders.id=order_items.order_id WHERE orders.status!='cancelled' GROUP BY order_items.product_name ORDER BY units DESC,total DESC LIMIT 10`),
    pool.query(`SELECT products.name,products.stock,COALESCE(SUM(order_items.quantity) FILTER(WHERE orders.status!='cancelled'),0)::int AS units FROM products LEFT JOIN order_items ON order_items.product_id=products.id LEFT JOIN orders ON orders.id=order_items.order_id GROUP BY products.id ORDER BY units,products.name LIMIT 10`)
  ]);
  const sum=summary.rows[0];return{summary:{sales:Number(sum.sales),orders:Number(sum.orders),inventory_value:Number(sum.inventory_value),low_stock:Number(sum.low_stock)},daily:daily.rows.map(r=>({...r,total:Number(r.total)})),monthly:monthly.rows.map(r=>({...r,total:Number(r.total)})),annual:annual.rows.map(r=>({...r,total:Number(r.total)})),top:top.rows.map(r=>({...r,units:Number(r.units),total:Number(r.total)})),slow:slow.rows.map(r=>({...r,stock:Number(r.stock),units:Number(r.units)}))};
}
app.get('/api/admin/reports',requireAdmin,async(_request,response)=>response.json(await reportData()));

function csvCell(value){return `"${String(value??'').replace(/"/g,'""')}"`;}
app.get('/api/admin/reports/export.csv',requireAdmin,async(_request,response)=>{const data=await reportData();const lines=['Sección,Periodo o producto,Unidades,Total'];for(const row of data.daily)lines.push(['Venta diaria',row.period,'',row.total].map(csvCell).join(','));for(const row of data.monthly)lines.push(['Venta mensual',row.period,'',row.total].map(csvCell).join(','));for(const row of data.annual)lines.push(['Venta anual',row.period,'',row.total].map(csvCell).join(','));for(const row of data.top)lines.push(['Más vendido',row.product_name,row.units,row.total].map(csvCell).join(','));for(const row of data.slow)lines.push(['Poco movimiento',row.name,row.units,''].map(csvCell).join(','));response.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="reporte-maconta.csv"'}).send(`\uFEFF${lines.join('\n')}`);});
app.get('/api/admin/reports/export.xlsx',requireAdmin,async(_request,response)=>{const data=await reportData(),workbook=new ExcelJS.Workbook();const add=(name,columns,rows)=>{const sheet=workbook.addWorksheet(name);sheet.columns=columns.map(([header,key,width])=>({header,key,width}));sheet.addRows(rows);sheet.getRow(1).font={bold:true};sheet.views=[{state:'frozen',ySplit:1}];};add('Ventas diarias',[['Fecha','period',16],['Total','total',16]],data.daily);add('Ventas mensuales',[['Mes','period',16],['Total','total',16]],data.monthly);add('Ventas anuales',[['Año','period',12],['Total','total',16]],data.annual);add('Productos vendidos',[['Producto','product_name',35],['Unidades','units',12],['Total','total',16]],data.top);add('Poco movimiento',[['Producto','name',35],['Stock','stock',12],['Vendidos','units',12]],data.slow);response.set({'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="reporte-maconta.xlsx"'});await workbook.xlsx.write(response);response.end();});
app.get('/api/admin/reports/export.pdf',requireAdmin,async(_request,response)=>{const data=await reportData(),doc=new PDFDocument({margin:45,size:'A4'});response.set({'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="reporte-maconta.pdf"'});doc.pipe(response);doc.fontSize(20).fillColor('#05266e').text('Reporte Maconta Plast');doc.moveDown().fontSize(11).fillColor('#102b45').text(`Ventas acumuladas: $${data.summary.sales.toFixed(2)}`).text(`Pedidos: ${data.summary.orders}`).text(`Valor del inventario: $${data.summary.inventory_value.toFixed(2)}`).text(`Productos con stock bajo: ${data.summary.low_stock}`);doc.moveDown().fontSize(15).text('Productos más vendidos');data.top.forEach((row)=>doc.fontSize(10).text(`${row.product_name}: ${row.units} unidades · $${row.total.toFixed(2)}`));doc.moveDown().fontSize(15).text('Productos con poco movimiento');data.slow.forEach((row)=>doc.fontSize(10).text(`${row.name}: ${row.units} vendidos · stock ${row.stock}`));doc.end();});

app.get('/api/admin/settings', requireAdmin, async (_request,response)=>response.json(await publicSettings()));
app.put('/api/admin/settings', requireAdmin, async (request,response)=>{for(const key of Object.keys(defaults)){if(request.body[key]!==undefined)await pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value',[key,String(request.body[key]).trim()]);}if(request.body.admin_email){const login=String(request.body.admin_email).trim().toLowerCase();if(login.length<3)return response.status(400).json({error:'Usuario administrativo no válido.'});try{await pool.query('UPDATE admins SET email=$1 WHERE id=$2',[login,request.admin.id]);}catch(error){if(error.code==='23505')return response.status(409).json({error:'Ese usuario ya existe.'});throw error;}}response.json({message:'Configuración guardada.'});});
app.put('/api/admin/password', requireAdmin, authLimiter, async (request,response)=>{const admin=(await pool.query('SELECT * FROM admins WHERE id=$1',[request.admin.id])).rows[0];if(!verifyPassword(String(request.body.current_password||''),admin.password_hash))return response.status(401).json({error:'La contraseña actual no coincide.'});if(String(request.body.new_password||'').length<10)return response.status(400).json({error:'La nueva contraseña debe tener al menos 10 caracteres.'});await pool.query('UPDATE admins SET password_hash=$1 WHERE id=$2',[hashPassword(request.body.new_password),admin.id]);await pool.query('DELETE FROM sessions WHERE admin_id=$1 AND token_hash!=$2',[admin.id,request.sessionHash]);response.json({message:'Contraseña actualizada.'});});

app.use(express.static(root,{extensions:['html'],etag:true,maxAge:'7d',setHeaders(response,filePath){
  if(filePath.endsWith('.html'))response.setHeader('Cache-Control','no-cache');
  else response.setHeader('Cache-Control','public, max-age=604800');
}}));
app.use((error,request,response,_next)=>{console.error(error);if(request.file)deleteUploadedImage(`images/uploads/${request.file.filename}`);if(error instanceof multer.MulterError)return response.status(400).json({error:'La imagen es demasiado grande o no es válida.'});if(error.code==='23503')return response.status(400).json({error:'La categoría seleccionada no existe.'});response.status(500).json({error:'Ocurrió un error inesperado.'});});

const port=Number(process.env.PORT)||3000;
initializeDatabase().then(()=>app.listen(port,()=>console.log(`Maconta Plast con PostgreSQL disponible en http://localhost:${port}`))).catch((error)=>{console.error('No se pudo inicializar PostgreSQL:',error);process.exit(1);});

async function shutdown(){await pool.end();process.exit(0);}process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
