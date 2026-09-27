# Invitación de Erika

La invitación está desplegada como sitio estático de Cloudflare Workers; su API guarda las confirmaciones en Cloudflare D1.

## Requisitos

- Node.js 22 o posterior
- Una cuenta de Cloudflare

## Ejecutar localmente

Instala las dependencias y crea el archivo local de variables:

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
```

Edita `.dev.vars` y asigna valores propios a `ADMIN_PASSWORD` y `SESSION_SECRET`. Usa una contraseña de administrador de al menos 12 caracteres y un secreto aleatorio largo. No publiques `.dev.vars`.

Aplica el esquema a la base local e inicia Wrangler:

```powershell
npm run db:migrate:local
npm run dev
```

Abre la URL local que indique Wrangler.

## Desplegar gratis en Cloudflare

Autoriza Wrangler con `npx wrangler login`. Crea la base remota y copia el `database_id` que muestre el comando:

```powershell
npm run db:create
```

Reemplaza el identificador de ejemplo en `wrangler.jsonc` por ese `database_id`. Después crea las tablas y configura secretos en Cloudflare:

```powershell
npm run db:migrate:remote
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npm run deploy
```

Wrangler te pedirá los valores secretos en la terminal. No los compartas ni los guardes en GitHub. Al finalizar, Wrangler mostrará la URL pública para compartir con los invitados.

El plan gratuito tiene cuotas diarias de Workers y D1. Consulta [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) y [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) para los límites vigentes.
