# Despliegue de Maconta Plast

## Recomendación: Dokploy

Esta aplicación escribe datos en dos rutas que deben ser persistentes:

- `/app/data`: base de datos SQLite, credenciales, productos, ventas y cotizaciones.
- `/app/images/uploads`: imágenes cargadas desde el panel.

El archivo `docker-compose.yml` ya crea un volumen independiente para cada ruta.

### Pasos

1. Sube el proyecto completo a un repositorio Git privado.
2. En Dokploy crea un proyecto y un servicio de tipo Docker Compose.
3. Conecta el repositorio y selecciona `docker-compose.yml`.
4. Añade estas variables de entorno con valores seguros:

   ```env
   ADMIN_USER=tu-correo@dominio.com
   ADMIN_PASSWORD=una-contraseña-larga-y-unica
   ```

5. Despliega el servicio y configura el dominio apuntando al puerto interno `3000`.
6. Activa copias de seguridad para los volúmenes `maconta_data` y `maconta_uploads`.
7. Mantén una sola réplica mientras se use SQLite.

No cambies los nombres de los volúmenes después de tener datos reales.

## Hostinger

La opción más segura para esta arquitectura es usar un VPS de Hostinger con Dokploy. También es posible utilizar Web App Hosting si el plan admite Node.js y almacenamiento persistente para SQLite e imágenes.

Configuración de la aplicación Node.js:

- Versión: Node.js 24.
- Archivo de entrada: `server.js`.
- Instalación: `npm ci --omit=dev`.
- Inicio: `npm start`.
- Variable: `NODE_ENV=production`.
- Variables privadas: `ADMIN_USER` y `ADMIN_PASSWORD`.

No subas el proyecto como una página HTML estática: el carrito, panel, pedidos y cotizaciones necesitan que `server.js` permanezca ejecutándose.

## Después de publicar

1. Comprueba `/api/store` y el catálogo público.
2. Entra en `/admin.html` con las credenciales definidas en el hosting.
3. Configura WhatsApp, correo, dirección y horario.
4. Crea un pedido y una cotización de prueba.
5. Comprueba que ambos aparezcan en el panel.
6. Reinicia o redespliega y confirma que los datos continúan disponibles.
