# QR Food POS MVP

Plataforma web MVP para restaurantes, cafeterias, bubble tea, comida rapida y negocios similares.

Incluye:

- Menu QR publico responsive.
- Carrito, personalizacion de productos y checkout sin cuenta.
- Envio de pedido con numero automatico, total e historial de estados.
- Confirmacion por WhatsApp con mensaje prellenado y actualizaciones de estado opcionales por WhatsApp Cloud API.
- Panel interno con login, pedidos, KDS/cocina, cambio de estados e impresion de ticket.
- Actualizacion en tiempo real de pedidos y estado del cliente con Server-Sent Events.
- Administracion de productos, precios, imagenes, categorias, disponibilidad y variantes.
- Configuracion dinamica de categorias, extras/toppings y variantes desde el panel.
- Inventario basico con stock, alertas de bajo inventario y agotado automatico.
- Promociones/cupones con compra minima, descuento fijo o porcentaje.
- Delivery configurable con zonas, costo, pedido minimo y asignacion de repartidor.
- QR por mesa, tiempos estimados por metodo de entrega y estado visible para el cliente.
- Control de estado de pago y referencia de pago por pedido.
- Usuarios, roles y permisos basicos.
- Reportes de ventas, productos mas vendidos, metodos de pago, entrega, categorias, horas y cajeros.
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
- Repartidor: `delivery@demo.com` / `Delivery123!`

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
WHATSAPP_AUTO_STATUS_UPDATES=false
WHATSAPP_NOTIFY_STATUSES=Aceptado,Listo
WHATSAPP_DEFAULT_COUNTRY_CODE=503
WHATSAPP_CLOUD_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_GRAPH_API_VERSION=v23.0
WHATSAPP_GRAPH_BASE_URL=https://graph.facebook.com
PRINT_AGENT_TOKEN=dev-print-agent-token
POS_SERVER_URL=http://localhost:3000
PRINT_AGENT_ID=longcha-store-pc
PRINT_AGENT_INTERVAL_MS=2500
```

La base SQLite se crea automaticamente en `data/restaurant_mvp.sqlite`.

Para enviar cambios de estado por WhatsApp automaticamente, activa `WHATSAPP_AUTO_STATUS_UPDATES=true` y configura `WHATSAPP_CLOUD_TOKEN` y `WHATSAPP_PHONE_NUMBER_ID`. Por defecto solo envia mensajes en `Aceptado` y `Listo`; puedes cambiarlo en `WHATSAPP_NOTIFY_STATUSES`. Si no hay credenciales, el panel mantiene el boton manual `Enviar WhatsApp` con el mensaje prellenado.

## Servidor local de impresion

Para imprimir sin abrir la ventana del navegador cuando el sistema esta en Render/Railway o en otro servidor cloud, ejecuta un servidor local en la PC del negocio. Ese servidor se conecta hacia el backend, toma trabajos pendientes y los envia a impresoras instaladas en Windows/macOS/Linux o a impresoras de red por IP/puerto. Render no necesita entrar a la red del local; la PC del negocio hace la conexion saliente.

1. En el servidor web configura el mismo token:

```env
PRINT_AGENT_TOKEN=un-token-largo-y-seguro
```

2. En la PC del negocio configura:

```env
POS_SERVER_URL=https://tu-dominio.com
PRINT_AGENT_TOKEN=un-token-largo-y-seguro
PRINT_AGENT_ID=longcha-caja-1
PRINT_SERVER_HOST=127.0.0.1
PRINT_SERVER_PORT=3050
```

3. Inicia el servidor local:

```bash
npm run print-server
```

4. Abre el panel local de impresion en la PC del negocio:

```text
http://127.0.0.1:3050
```

Desde ese panel puedes ver conexion con Render, trabajos impresos, fallos recientes y endpoints para detectar impresoras locales. Si el servidor local esta activo, el boton `Detectar impresoras` del panel administrativo intentara leer primero `http://127.0.0.1:3050/printers`, para detectar las impresoras reales de la PC del negocio aunque la plataforma este en Render. En desarrollo local puedes usar `PRINT_AGENT_TOKEN=dev-print-agent-token` y `POS_SERVER_URL=http://localhost:3000`.

Desde el panel de configuracion, en `Impresoras`, elige por cada rol:

- `Navegador`: abre la impresion normal del navegador.
- `PC / impresora instalada`: el agente imprime en una impresora instalada en esa PC.
- `Red / IP directa`: el agente envia el trabajo directo a la IP y puerto de la impresora, normalmente `9100`.

La impresion directa por red es la recomendada para termicas ESC/POS y Zebra ZPL. Para impresoras instaladas en Windows, el agente usa el spooler del sistema.

Tambien se mantiene `npm run print-agent` como modo simple sin panel local. Para produccion se recomienda `npm run print-server`.

## Modelo de base de datos

Tablas principales:

- `roles`, `users`, `sessions`
- `business`, `settings`
- `branches`
- `categories`, `products`, `product_variants`
- `extras`, `product_extras`, `optional_groups`, `optional_options`
- `payment_methods`, `delivery_methods`, `delivery_zones`
- `customers`, `orders`, `order_items`, `order_status_history`
- `promotions`
- `audit_logs`, `notification_logs`, `print_jobs`

Cada pedido guarda:

- Cliente y contacto.
- Metodo de entrega y pago.
- Zona y costo de delivery.
- Productos, variantes, extras y notas.
- Subtotal, delivery y total.
- Descuento, cupon, mesa y estado de pago.
- Estado actual.
- Historial completo de estados.

## Flujo del sistema

1. Cliente escanea QR o entra a `/menu`.
2. Filtra productos, personaliza variantes y extras.
3. Agrega al carrito y confirma en `/checkout`.
4. El backend valida disponibilidad, inventario, cupones, horarios, delivery y recalcula precios.
5. El panel interno muestra el pedido como `Nuevo`.
6. Caja/cocina cambian estado: `Aceptado`, `En preparacion`, `Listo`, `En camino`, `Entregado` o `Cancelado`.
7. Caja puede marcar pago, asignar repartidor e imprimir ticket.
8. El panel interno, KDS y la pagina `/status` reciben el cambio en tiempo real sin refrescar.
9. Si WhatsApp Cloud API esta configurado, el cliente recibe mensaje automatico para los estados definidos.

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

Catalogo:

- `Panel > Productos` permite editar categoria, precio, imagen, disponibilidad, extras asociados y variantes visuales.
- `Panel > Categorias` permite crear, ordenar, activar/desactivar y eliminar categorias.
- `Panel > Extras` permite crear toppings/agregados, cambiar precio, activar/desactivar y eliminarlos.
- `Panel > Opcionales` maneja grupos como Leche, Toppings, Boba o Extras, con reglas de requerido, maximo seleccionable, opciones con precio y vinculos a productos.
- `Panel > Inventario` permite activar stock, ajustar cantidades, definir alerta baja y cambiar disponibilidad.
- `Panel > Promociones` permite crear cupones como `LONGCHA10`, fijar fechas, descuento y compra minima.
- `Panel > Delivery` permite activar metodos, configurar zonas y ver repartidores disponibles.
- `Panel > Usuarios` permite crear/editar usuarios y ajustar permisos por rol.
- `Panel > Configuracion` incluye QR por mesa, horarios, cierres temporales y tiempos estimados.

Auditoria:

- Ver eventos en `Panel > Auditoria`.
- La tabla registra usuario, accion, entidad, IP, navegador y detalles.
- Tambien muestra backups disponibles para descarga y logs de notificaciones.

Antes de produccion real, agrega backups externos, rotacion de secretos, monitoreo, logs centralizados y pruebas de restauracion.
