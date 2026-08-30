# Despliegue de Maconta Plast con PostgreSQL

## Recomendación: VPS de Hostinger + Dokploy

La aplicación usa dos almacenamientos persistentes:

- `postgres_data`: usuarios, productos, categorías, stock, precios, pedidos, cotizaciones y configuración.
- `maconta_uploads`: imágenes cargadas desde el panel administrativo.

El archivo `docker-compose.yml` crea PostgreSQL y la aplicación Node.js. El `Dockerfile` no sustituye a PostgreSQL: construye el servidor web que se conecta a la base de datos.

## Configuración en Dokploy

1. Sube el proyecto a un repositorio Git privado.
2. En Dokploy crea un proyecto de tipo Docker Compose.
3. Conecta el repositorio y selecciona `docker-compose.yml`.
4. Define estas variables en Dokploy (sin comillas):

   ```env
   POSTGRES_DB=maconta
   POSTGRES_USER=maconta
   POSTGRES_PASSWORD=una-clave-postgres-muy-larga-y-unica
   ADMIN_USER=tu-correo@dominio.com
   ADMIN_PASSWORD=otra-clave-larga-y-unica
   ```

5. Despliega y configura el dominio hacia el servicio `maconta-web`, puerto interno `3000`.
6. Activa copias de seguridad para `postgres_data` y `maconta_uploads`.

No publiques el puerto `5432` de PostgreSQL en Internet. El servicio web lo alcanza por la red privada de Docker.

## Primer inicio

Al arrancar, el servidor crea automáticamente las tablas y carga el catálogo inicial si la base está vacía. Las variables `ADMIN_USER` y `ADMIN_PASSWORD` crean el primer administrador. Después puedes cambiar el usuario, el correo de contacto y la contraseña desde el panel.

Los cambios posteriores en `ADMIN_USER` o `ADMIN_PASSWORD` no sobrescriben automáticamente una cuenta ya creada. Esto evita perder las credenciales configuradas desde el panel.

## Comprobación

1. Abre `/api/health`; debe responder que PostgreSQL está conectado.
2. Comprueba el catálogo en `/api/store`.
3. Entra en `/admin.html` con las credenciales configuradas.
4. Crea un producto, pedido y cotización de prueba.
5. Reinicia ambos servicios y confirma que los datos e imágenes continúan disponibles.

## Copias de seguridad

Además del respaldo del volumen, puedes exportar la base con:

```bash
docker compose exec -T postgres pg_dump -U maconta -d maconta > maconta-backup.sql
```

La contraseña de PostgreSQL debe guardarse en las variables privadas de Dokploy y nunca dentro del repositorio.
