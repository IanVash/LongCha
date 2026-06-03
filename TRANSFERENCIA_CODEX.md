# Transferencia Codex - Long Cha POS

Este archivo sirve para continuar este proyecto en otra PC, por ejemplo `DESKTOP-6UPHL09`.

## Proyecto

Ruta actual:

```text
C:\Users\vashr\Documents\Codex\2026-05-21\openai-developers-plugin-openai-developers-openai
```

App local:

```text
http://localhost:3000
```

Credenciales demo:

```text
admin@demo.com / Admin123!
```

## Estado actual

La plataforma incluye:

- Menu QR Long Cha.
- Carrito y pedidos online.
- Kiosk para pedidos en local.
- Seguimiento de pedidos para cliente.
- Panel admin.
- Panel de pedidos y KDS.
- Productos, categorias, extras, variantes y opcionales.
- Inventario por productos e insumos.
- Contabilidad, compras, merma y cierre de caja.
- Apertura y cierre de caja para permitir/bloquear pedidos.
- Reportes avanzados.
- Auditoria, backups, rate limiting y checklist pre-produccion.
- Servidor/agente local de impresion.
- Configuracion de impresoras por caja, cocina, kiosk y etiquetas Zebra.

## Cambios recientes importantes

- `src/db.js`: metricas avanzadas, permisos finos, sesiones de caja, reportes.
- `src/server.js`: endpoints de salud del sistema, CSV, permisos, impresion.
- `public/admin.js`: dashboard de alertas, checklist, reportes avanzados, configuracion de impresoras.
- `public/styles.css`: estilos de paneles, alertas, checklist y reportes.
- `tools/print-server.js`: servidor local para imprimir y detectar impresoras.

## Para pasar a otra PC

Opcion recomendada: subir o copiar el proyecto completo.

Si copias manualmente, incluye:

```text
src/
public/
tools/
data/
package.json
README.md
TRANSFERENCIA_CODEX.md
```

La carpeta `data/` es importante porque contiene la base SQLite, imagenes subidas, backups y datos reales del negocio.

## Comandos en la otra PC

Instalar Node.js 24 o superior.

Levantar POS:

```bash
npm start
```

Abrir:

```text
http://localhost:3000
```

Levantar servidor local de impresion:

```bash
npm run print-server
```

Abrir panel local de impresion:

```text
http://127.0.0.1:3050
```

## Variables utiles

Para local:

```env
POS_SERVER_URL=http://localhost:3000
PRINT_AGENT_TOKEN=dev-print-agent-token
PRINT_AGENT_ID=longcha-store-pc
```

Para Render/produccion:

```env
POS_SERVER_URL=https://tu-dominio.com
PRINT_AGENT_TOKEN=un-token-largo-y-seguro
PRINT_AGENT_ID=longcha-caja-1
NODE_ENV=production
COOKIE_SECURE=true
ENFORCE_HTTPS=true
TRUST_PROXY=true
```

## Impresoras detectadas en esta PC

En esta PC se detecto:

```text
L4160 Series(Network)
EPSONCE1840 (L4160 Series)
Microsoft Print to PDF
OneNote (Desktop)
```

Configuracion recomendada actual:

- Kiosk: `PC / impresora instalada` con `L4160 Series(Network)`.
- Caja: puede usar `PC / impresora instalada` con `L4160 Series(Network)`.
- Cocina: navegador/manual hasta conectar termica de cocina.
- Etiquetas Zebra: dejar desactivada o navegador hasta instalar Zebra real.

## Como continuar con Codex en la otra PC

En la otra PC, abre el proyecto en Codex y escribe:

```text
Lee TRANSFERENCIA_CODEX.md y continua desde ahi.
```

Si tambien quieres conservar el historial exacto de este chat, abre Codex con la misma cuenta y busca este hilo si tu instalacion sincroniza conversaciones. Si no aparece, este archivo es el resumen para retomar el trabajo sin perder el contexto tecnico.

