# 16 — Inyector de Indexación

`GoogleApisIndexingPublisher` es la frontera Node/serverless para el cliente oficial `googleapis` de Google Indexing API. El core no acepta access tokens, service-account JSON ni headers OAuth enviados por el usuario: recibe un cliente `google.indexing({ version: "v3", auth })` ya autenticado por `GoogleAuth` y llama a `urlNotifications.publish({ requestBody: { url, type } })`.

Ejemplo de ensamblaje en la función serverless que sí declara `googleapis` como dependencia:

```ts
import { google } from "googleapis";
import { GoogleApisIndexingPublisher } from "@nexus/ontology/.../16-inyector-indexacion";

const auth = new google.auth.GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/indexing"],
});
const client = google.indexing({ version: "v3", auth });
const publisher = new GoogleApisIndexingPublisher("https://example.com", client);
```

Las credenciales deben llegar por ADC/secret manager/configuración del deployment; nunca se versionan en Nexus.

## Elegibilidad

Google Indexing API no es un “push to index” general. #16 solo acepta eventos que #13 clasificó como `JOB_POSTING` o `LIVESTREAM_BROADCAST_EVENT`, exige la URL del origen canónico y conserva el recibo semántico SHA-256. `URL_UPDATED` y `URL_DELETED` son los únicos tipos de mutación permitidos.

`createGoogleIndexingServerlessHandler()` exige un `IndexingRequestAuthenticator` para verificar al consumidor interno/QStash antes de parsear el evento, limita el body y responde `private, no-store`.
