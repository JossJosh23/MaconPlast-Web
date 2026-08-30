# Maconta Plast

Aplicación web responsiva con catálogo, cotizaciones, carrito, pedidos y panel administrativo privado. Los datos se almacenan en PostgreSQL y las imágenes cargadas se conservan en un volumen persistente.

## Estructura

```text
assets/
  css/            Estilos de tienda y administración
  js/             Lógica del navegador
images/
  catalogo/       Fotografías y logo del catálogo
  hero/           Composiciones de portada
  uploads/        Imágenes subidas desde administración
scripts/          Utilidades internas del proyecto
admin.html        Panel administrativo
index.html        Tienda pública
server.js         API y servidor Node.js
seed-products.json Catálogo inicial
```

Las carpetas `images/catalogo` e `images/uploads` mantienen rutas estables porque PostgreSQL guarda esas ubicaciones en los productos.

## Inicio local

Requiere Node.js 22.5 o posterior y PostgreSQL.

1. Copia `.env.example` como `.env` y cambia sus contraseñas.
2. Define `DATABASE_URL` o las variables estándar `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` y `PGPASSWORD`.
3. Ejecuta:

```bash
npm install
npm start
```

Abre `http://localhost:3000`. El panel está en `http://localhost:3000/admin.html`.

## Funciones

- Catálogo dinámico con categorías, precios, filtros, inventario y disponibilidad.
- Carrito persistente, pedidos y cotizaciones especiales.
- Administración de productos, imágenes, categorías, ventas y solicitudes.
- Inventario avanzado con entradas, salidas, stock mínimo, alertas e historial de movimientos.
- Fichas de clientes con RUC/cédula, notas, WhatsApp e historial de pedidos y cotizaciones.
- Reportes diarios, mensuales y anuales, productos más vendidos, poco movimiento y valor de inventario.
- Exportación de reportes en CSV, Excel y PDF.
- Configuración de WhatsApp, correo, dirección, horario, footer y acceso administrativo.
- Interfaz mobile-first con áreas seguras de iOS, navegación táctil, diálogos adaptables y tarjetas administrativas.

Las credenciales `admin1` / `admin1` son únicamente temporales. Cámbialas antes de abrir la web al público.

## Producción

Consulta [DEPLOYMENT.md](DEPLOYMENT.md) para desplegar la aplicación y PostgreSQL en Dokploy. Debes respaldar tanto la base PostgreSQL como el volumen `images/uploads`.
