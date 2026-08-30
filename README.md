# Maconta Plast

Tienda web responsiva con catálogo, carrito de compra, pedidos y panel administrativo privado.

## Iniciar el proyecto

Requiere Node.js 22.5 o posterior.

```bash
npm install
npm start
```

Abre `http://localhost:3000`. El panel está disponible en `http://localhost:3000/admin.html`.

## Acceso administrativo temporal

- Usuario: `admin1`
- Contraseña: `admin1`

Estas credenciales son temporales. Cámbialas desde Configuración antes de publicar la web.

## Funciones

- Productos: crear, editar, eliminar, ordenar, cambiar precio, descripción, imagen, stock y disponibilidad.
- Categorías: crear, renombrar, ordenar y eliminar categorías sin productos asociados.
- Tienda: catálogo dinámico, filtros, carrito persistente y registro de pedidos.
- Ventas: listado privado, detalle y estados pendiente, confirmado, completado o cancelado.
- Cotizaciones: bandeja privada para solicitudes especiales con estados nueva, en revisión, respondida o descartada.
- Configuración: WhatsApp, correo visible, dirección, horario, texto del footer y credenciales administrativas.
- La sección de cotización puede activarse, desactivarse y editar su título y descripción desde el panel.
- Imágenes nuevas: se almacenan en `images/uploads/`.

## Datos y copias de seguridad

La aplicación crea `data/maconta.db` automáticamente. Para respaldar la tienda, detén el servidor y guarda una copia de ese archivo junto con `images/uploads/`.

Para producción utiliza HTTPS, define `NODE_ENV=production`, conserva copias de seguridad y ejecuta Node detrás de un proxy como Nginx, Cloudflare o el servicio de hosting elegido.

Consulta [DEPLOYMENT.md](DEPLOYMENT.md) para desplegar con Dokploy o Hostinger sin perder la base de datos ni las imágenes.
