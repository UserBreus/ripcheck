# RIPcheck

Preflight de archivos PDF para un taller de impresión: sublimación, DTF y gran
formato. Abrís el archivo, te dice si hay algo para corregir antes de mandarlo
al RIP, y te marca en la vista previa dónde está cada cosa.

Todo el análisis corre en la máquina. Ningún archivo sale del equipo.

## Arrancar el proyecto

Necesitás Node 22.13 o superior. Nada más.

```bash
git clone https://github.com/UserBreus/ripcheck.git
cd ripcheck
npm install
npm run dev
```

Queda andando en `http://localhost:3000`. Arrastrás un PDF y listo.

Para verlo como aplicación de escritorio, igual que el programa instalado:

```bash
npm run electron:start
```

## Comandos

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Desarrollo, refresca solo al guardar |
| `npm run build` | Compila la aplicación |
| `npm start` | Sirve lo compilado |
| `npm test` | Compila y corre las pruebas |
| `npm run lint` | Revisa el código |
| `npm run electron:start` | Abre la aplicación de escritorio |
| `npm run make:exe` | Arma el instalador de Windows |

El instalador necesita NSIS, que no viene con npm. La primera vez lo bajás con
`npx electron-builder --win nsis` y queda en la cache de tu usuario. Si falta,
el script te lo avisa y te deja igual la aplicación empaquetada en `dist-app/`.

## Qué revisa

Solo avisa lo que cambia lo que hay que hacer. Si no aparece ninguna alerta, el
archivo no tiene nada raro.

- **Color fuera de CMYK.** El taller imprime todo en CMYK; cualquier RGB que
  quede en el arte lo convierte el RIP por su cuenta y desentona con el resto.
  Detecta RGB en vectores, en imágenes colocadas y en paletas indexadas.
- **Transparencias y sombras.** Las ubica sobre la página y explica que el RIP
  las tiene que aplanar, que es donde suelen aparecer recuadros claros.
- **Imágenes con poca definición.** Calcula los puntos por pulgada reales al
  tamaño en que está colocada cada imagen, no los que dice el archivo.
- **Tintas directas.** Las lista con el espacio al que caen si el RIP no las
  reconoce, y avisa si quedaron atrapadas dentro de un ráster, donde no se
  pueden mapear.
- **Contornos de corte.** Verifica el nombre exacto que espera Flexi y
  PhotoPRINT, y que estén aplicados como trazo y no como relleno.
- **Espejo inconsistente.** Cuando parte del arte viene reflejado y parte no.
- **Archivos que el RIP no va a poder abrir.** Estructura dañada, compresión
  rara, formularios, capas rotas, JPEG 2000.

No avisa por el tamaño de la pieza ni por la cantidad de tinta: el perfil de
impresión de cada máquina ya recorta la carga.

## Qué informa sin alarma

La medida real de la pieza, ya con el factor de escala del documento aplicado.
El perfil ICC que trae y si viaja entero adentro o es apenas una etiqueta.
Páginas, texto, fuentes, capas y versión del PDF.

## Cómo está armado

React sobre Vite para la interfaz, `pdfjs-dist` para interpretar el PDF, y
Electron para empaquetarlo como aplicación de escritorio. El análisis está
separado de la interfaz, así que se puede tocar una cosa sin romper la otra.

| Archivo | Qué hace |
| --- | --- |
| `app/icc.ts` | Lector propio de perfiles ICC v2 y v4, sin librerías |
| `app/pdf-deep.ts` | Intenciones de salida, cajas de página, tintas directas |
| `app/pdf-structure.ts` | Flujos, objetos y colores originales del documento |
| `app/findings.ts` | Las alertas, con la zona de la página donde está cada una |
| `app/preflight-rules.ts` | Los datos del archivo y la lectura del ICC |
| `app/preflight-app.tsx` | La interfaz |
| `electron/main.cjs` | Arranque de la aplicación de escritorio |
| `scripts/` | Empaquetado e instalador de Windows |

Las pruebas están en `tests/` y no necesitan navegador: `npm test` las corre
todas.

## Qué no está en el repositorio

Las carpetas de compilación `dist-app/` y el contenido pesado de `release/`.
Son salida, no código: se regeneran con `npm run make:exe` y superan el límite
de 100 MB por archivo de GitHub. El instalador ya compilado sí está, guardado
con Git LFS.

## Licencia

Sin licencia declarada. Todos los derechos reservados.
