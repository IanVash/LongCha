# QR Food POS MVP

Plataforma web MVP para restaurantes, cafeterias, bubble tea, comida rapida y negocios similares.

Incluye:

- Menu QR publico responsive.
- Carrito, personalizacion de productos y checkout sin cuenta.
- Envio de pedido con numero automatico, total e historial de estados.
- Confirmacion por WhatsApp con mensaje prellenado.
- Panel interno con login, pedidos, KDS/cocina, cambio de estados e impresion de ticket.
- Administracion de productos, precios, imagenes, categorias, disponibilidad y variantes.
- Usuarios, roles y permisos basicos.
- Reportes de ventas, productos mas vendidos, metodos de pago y entrega.
- Codigo QR local para enlazar el menu.
- Controles pre-produccion: HTTPS opcional, rotacion de sesiones, rate limiting, auditoria, backups y subida validada de imagenes.

## Stack

- Node.js 24.
- Servidor HTTP nativo con API REST.
- SQLite embebido mediante `node:sqlite`.
- Frontend responsive con HTML, CSS y JavaScript modular.
- Sin dependencias externas para que el MVP arranque rapido en local.

El proyecto queda preparado para migrar el servidor a Express/Next.js, la base a PostgreSQL/Supabase, las notificaciones a WebSockets/Supabase Realtime/Pusher y el storage a Cloudinary/Supabase Storage.

## Ejecutar

```bash
npm run start
```

En PowerShell, si `npm` esta bloqueado por politica de scripts, usa:

```powershell
npm.cmd run start
```

Abrir:

- Publico: `http://localhost:3000`
- Menu QR: `http://localhost:3000/menu`
- Panel: `http://localhost:3000/admin/login`

Credenciales demo:

- Administrador: `admin@demo.com` / `Admin123!`
- Caja: `caja@demo.com` / `Caja123!`
- Cocina: `cocina@demo.com` / `Cocina123!`

## Variables de entorno

Copia `.env.example` a `.env` si necesitas cambiar valores:

```env
PORT=3000
APP_URL=http://localhost:3000
DATA_DIR=./data
SESSION_DAYS=7
SESSION_ROTATE_MINUTES=30
NODE_ENV=development
ENFORCE_HTTPS=false
TRUST_PROXY=true
COOKIE_SECURE=false
HTTPS_KEY_PATH=
HTTPS_CERT_PATH=
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=300
LOGIN_RATE_LIMIT_MAX=10
MUTATION_RATE_LIMIT_MAX=120
JSON_BODY_LIMIT_BYTES=524288
IMAGE_UPLOAD_DIR=./data/uploads
MAX_IMAGE_BYTES=2097152
BACKUP_DIR=./data/backups
BACKUP_INTERVAL_HOURS=24
```

La base SQLite se crea automaticamente en `data/restaurant_mvp.sqlite`.

## Modelo de base de datos

Tablas principales:

- `roles`, `users`, `sessions`
- `business`, `settings`
- `categories`, `products`, `product_variants`
- `extras`, `product_extras`
- `payment_methods`, `delivery_methods`, `delivery_zones`
- `customers`, `orders`, `order_items`, `order_status_history`
- `promotions`
- `audit_logs`

Cada pedido guarda:

- Cliente y contacto.
- Metodo de entrega y pago.
- Zona y costo de delivery.
- Productos, variantes, extras y notas.
- Subtotal, delivery y total.
- Estado actual.
- Historial completo de estados.

## Flujo del sistema

1. Cliente escanea QR o entra a `/menu`.
2. Filtra productos, personaliza variantes y extras.
3. Agrega al carrito y confirma en `/checkout`.
4. El backend valida disponibilidad, recalcula precios y crea el pedido.
5. El panel interno muestra el pedido como `Nuevo`.
6. Caja/cocina cambian estado: `Aceptado`, `En preparacion`, `Listo`, `En camino`, `Entregado` o `Cancelado`.
7. Cliente consulta el avance en `/status`.

## Despliegue sugerido

MVP simple:

- Render, Railway, Fly.io o VPS con Node.js 24.
- Persistir el directorio `data`.
- Configurar `APP_URL` con el dominio real.
- Usar HTTPS para cookies seguras en produccion.
- Configurar `ENFORCE_HTTPS=true` si la app corre detras de proxy HTTPS.
- Configurar `COOKIE_SECURE=true` y `NODE_ENV=production`.
- Para TLS directo en Node, definir `HTTPS_KEY_PATH` y `HTTPS_CERT_PATH`.

Evolucion recomendada:

- PostgreSQL administrado.
- Storage externo para imagenes.
- WebSockets o Supabase Realtime.
- Pasarela Stripe, Wompi, PayPal, Pagadito o links de pago.
- Integracion POS mediante adaptadores por proveedor.
- Backups automaticos de base de datos.

## Seguridad incluida en MVP

- Login con cookie HTTP-only.
- Hash de contrasenas con PBKDF2 y salt.
- Roles y permisos.
- Consultas SQL preparadas.
- Validacion de formularios en servidor.
- CSP y headers basicos.
- Redireccion HTTPS configurable y soporte para certificados locales.
- Rotacion automatica de IDs de sesion.
- Rate limiting por IP para login, mutaciones y lectura general.
- Auditoria de login, logout, cambios de pedido, catalogo, usuarios, configuracion, backups y uploads.
- Backups SQLite programados con checkpoint WAL.
- Subida formal de imagenes PNG/JPG/WebP con limite de tamano, validacion MIME/firma y storage controlado.

## Operacion pre-produccion

HTTPS:

- En Render/Railway/Vercel/NGINX, termina TLS en el proxy y usa `ENFORCE_HTTPS=true`, `TRUST_PROXY=true`, `COOKIE_SECURE=true`.
- Si Node servira TLS directamente, define `HTTPS_KEY_PATH` y `HTTPS_CERT_PATH`.

Backups:

- Los backups se guardan en `BACKUP_DIR`.
- `BACKUP_INTERVAL_HOURS=24` crea un backup diario.
- Tambien puedes crear backups manuales desde `Panel > Auditoria`.

Imagenes:

- En `Panel > Productos`, puedes pegar una URL o subir una imagen.
- El servidor acepta PNG, JPG y WebP hasta `MAX_IMAGE_BYTES`.
- Las imagenes quedan en `IMAGE_UPLOAD_DIR` y se sirven desde `/uploads/images/...`.

Auditoria:

- Ver eventos en `Panel > Auditoria`.
- La tabla registra usuario, accion, entidad, IP, navegador y detalles.

Antes de produccion real, agrega backups externos, rotacion de secretos, monitoreo, logs centralizados y pruebas de restauracion.
