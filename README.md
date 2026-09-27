# Invitación de Erika

## Ejecutar localmente

Requiere Node.js 22.9 o posterior. Copia `.env.example` como `.env`, establece una contraseña de administrador de al menos 12 caracteres y genera un secreto de sesión aleatorio de al menos 32 caracteres. En PowerShell puedes generar el secreto con:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Inicia la aplicación con:

```powershell
npm start
```

Abre <http://localhost:3000>. Las respuestas se guardan en `confirmaciones.json`.

## Despliegue

Despliega el proyecto en un servicio que ejecute Node.js 22.9 o posterior. Configura `ADMIN_PASSWORD` y `SESSION_SECRET` como variables secretas del servicio, y `PORT` según lo indique el proveedor. El proceso debe tener permiso de escritura en el directorio de `confirmaciones.json`.

El archivo JSON requiere almacenamiento persistente y una sola instancia de servidor para conservar y serializar las escrituras. Si el proveedor usa discos efímeros o varias instancias, monta un volumen persistente compartido o usa una base de datos administrada antes de publicar.
