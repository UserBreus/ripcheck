# RIPcheck

Preflight de archivos PDF para un taller de impresión: sublimación, DTF y gran
formato. Abrís el archivo, te dice si hay algo para corregir antes de mandarlo
al RIP, y te marca en la vista previa dónde está cada cosa.

Todo el análisis corre en la máquina. Ningún archivo sale del equipo.

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

## Qué informa sin alarma

La medida real de la pieza, ya con el factor de escala del documento aplicado.
El perfil ICC que trae y si viaja entero adentro o es apenas una etiqueta.
Páginas, texto, fuentes, capas y versión del PDF.

## Lectura de perfiles ICC

Incluye un lector propio de perfiles ICC v2 y v4 que no depende de ninguna
librería: cabecera de 128 bytes, tabla de etiquetas, descripciones en `desc`
y `mluc`, y detección de perfiles conocidos. Reporta si el perfil trae las
tablas de conversión reales o solo etiquetas.

## Desarrollo

Requiere Node 22.13 o superior.

```bash
npm install
npm run dev
```

Otros comandos:

```bash
npm test          # compila y corre las pruebas
npm run lint      # eslint
npm run build     # compila la aplicación web
npm run make:exe  # arma el instalador de Windows
```

## Cómo está hecho

React sobre Vite para la interfaz, `pdfjs-dist` para interpretar el PDF, y
Electron para empaquetarlo como aplicación de escritorio de Windows. El
análisis está separado de la interfaz:

| Archivo | Qué hace |
| --- | --- |
| `app/icc.ts` | Lector de perfiles ICC |
| `app/pdf-deep.ts` | Lectura profunda del PDF: intenciones de salida, cajas de página, tintas directas |
| `app/pdf-structure.ts` | Flujos, objetos y colores originales del documento |
| `app/findings.ts` | Las alertas, con la zona de la página donde está cada una |
| `app/preflight-rules.ts` | Los datos del archivo y la lectura del ICC |
| `app/preflight-app.tsx` | La interfaz |

## Licencia

Sin licencia declarada. Todos los derechos reservados.
