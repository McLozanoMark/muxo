# Activación del panel Admin de Muxo

El panel está disponible únicamente mediante la ruta directa:

`https://muxo-karaoke.jmarkson7.chatgpt.site/#admin`

No se muestra ningún botón público para abrirlo.

## 1. Activar el proveedor de acceso

En Firebase Console, dentro de `Authentication > Sign-in method`, activa `Email/Password` y crea el usuario administrativo. Muxo no guarda ni expone la contraseña.

## 2. Dar permiso administrativo

El frontend solo muestra el panel cuando el token de Firebase contiene el claim `admin: true`. Así el permiso no depende de un correo escondido en JavaScript.

Puedes asignarlo una sola vez desde un entorno seguro con Firebase Admin SDK:

```js
const admin = require('firebase-admin');

(async () => {
  admin.initializeApp();
  const email = process.argv[2];
  const user = await admin.auth().getUserByEmail(email);
  await admin.auth().setCustomUserClaims(user.uid, {
    ...(user.customClaims || {}),
    admin: true,
  });
  console.log(`Admin habilitado para ${user.email}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

Después, cierra sesión y vuelve a entrar para que Firebase entregue el token actualizado.

## 3. Reglas de Firestore

La colección `muxoAnalytics` debe permitir crear eventos públicos validados y permitir leerlos únicamente a un usuario cuyo token tenga `admin == true`. Integra este bloque con las reglas existentes de Muxo; no reemplaces las reglas actuales de `sessions`:

```text
match /muxoAnalytics/{eventId} {
  allow create: if request.resource.data.eventType in [
    'visit_start', 'visit_heartbeat', 'visit_end',
    'request_added', 'song_played'
  ]
  && request.resource.data.roomId is string
  && request.resource.data.createdAt is number;

  allow read: if request.auth != null
    && request.auth.token.admin == true;

  allow update, delete: if request.auth != null
    && request.auth.token.admin == true;
}
```

Las métricas empiezan a acumularse desde la publicación de esta versión. Las sesiones anteriores no pueden reconstruirse porque Muxo todavía no tenía registro histórico.
