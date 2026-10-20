// Builds the runtime served to the miniapp iframes (dist/): react, react-dom, jsx-runtime, chart.js, leaflet, @agentui/ui, boot, base.css, fonts.
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = join(here, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const common = { bundle: true, format: 'esm', target: 'es2022', minify: true, legalComments: 'none', outdir: dist, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' };

/** ESM facade with explicit named exports for a CommonJS package (esbuild cannot enumerate them statically). */
const facade = (pkg, req = pkg) => {
  const names = Object.keys(require(req)).filter((k) => k !== 'default' && /^[A-Za-z_$][\w$]*$/.test(k));
  return `import M from '${pkg}'; export default M; ${names.map((n) => `export const ${n} = M.${n};`).join(' ')}`;
};

// CommonJS `require('react')` inside react-dom must stay a bare import resolved by the import map
const reactShim = {
  name: 'react-shim',
  setup(b) {
    b.onResolve({ filter: /^react$/ }, (a) => (a.namespace === 'react-shim' ? { path: 'react', external: true } : { path: 'react', namespace: 'react-shim' }));
    b.onLoad({ filter: /.*/, namespace: 'react-shim' }, () => ({ contents: "export * from 'react'; import * as R from 'react'; export default R;", loader: 'js' }));
  },
};
// react: bundled once, shared through the import map by every other module
await build({ ...common, stdin: { contents: facade('react'), resolveDir: here }, outfile: join(dist, 'react.js'), outdir: undefined });
// (a bare `external: ['react']` would also match 'react/jsx-runtime' and make this facade import itself)
await build({ ...common, plugins: [reactShim], stdin: { contents: facade('react/jsx-runtime'), resolveDir: here }, outfile: join(dist, 'jsx-runtime.js'), outdir: undefined });

await build({
  ...common, plugins: [reactShim], outfile: join(dist, 'react-dom.js'), outdir: undefined,
  stdin: {
    resolveDir: here,
    contents: `import C from 'react-dom/client'; import D from 'react-dom';
      export const createRoot = C.createRoot, hydrateRoot = C.hydrateRoot, createPortal = D.createPortal, flushSync = D.flushSync; export default { ...D, ...C };`,
  },
});

await build({
  ...common, outfile: join(dist, 'chart.js'), outdir: undefined,
  stdin: { resolveDir: here, contents: "import 'chart.js/auto'; export * from 'chart.js'; import { Chart } from 'chart.js'; export default Chart;" },
});

// leaflet: default marker icons inlined (the CSS cannot find them next to itself); its stylesheet is built with the images as data URIs
const leafletImg = (n) => `leaflet/dist/images/${n}.png`;
await build({
  ...common, outfile: join(dist, 'leaflet.js'), outdir: undefined, loader: { '.png': 'dataurl' },
  stdin: {
    resolveDir: here,
    contents: `import * as L from 'leaflet'; export * from 'leaflet'; export default L;
      import icon from '${leafletImg('marker-icon')}'; import icon2x from '${leafletImg('marker-icon-2x')}'; import shadow from '${leafletImg('marker-shadow')}';
      // OSM tiles go through the server (the sandboxed iframe sends no Referer, which OSM refuses): same URL for the app, rewritten here
      const osm = 'https://tile.openstreetmap.org/', proxy = import.meta.url.replace(/_runtime\\/[^/]*$/, 'tiles/');
      const init = L.TileLayer.prototype.initialize;
      L.TileLayer.prototype.initialize = function (url, options) { return init.call(this, typeof url === 'string' && url.startsWith(osm) ? proxy + url.slice(osm.length) : url, options); };
      delete L.Icon.Default.prototype._getIconUrl; L.Icon.Default.mergeOptions({ iconUrl: icon, iconRetinaUrl: icon2x, shadowUrl: shadow });`,
  },
});
await build({ ...common, entryPoints: { leaflet: require.resolve('leaflet/dist/leaflet.css') }, loader: { '.png': 'dataurl' } });

await build({ ...common, entryPoints: { ui: join(here, 'src/ui.tsx'), boot: join(here, 'src/boot.tsx') }, jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'react-dom/client', 'chart.js', 'leaflet', '@agentui/ui'] });

copyFileSync(join(here, 'src/base.css'), join(dist, 'base.css'));
for (const [pkg, f] of [['inter', 'inter-latin-wght-normal.woff2'], ['inter', 'inter-latin-ext-wght-normal.woff2'], ['jetbrains-mono', 'jetbrains-mono-latin-wght-normal.woff2']]) {
  copyFileSync(require.resolve(`@fontsource-variable/${pkg}/files/${f}`), join(dist, f));
}
writeFileSync(join(dist, 'version.json'), JSON.stringify({ built: Date.now() }));
console.log('app-runtime built:', readFileSync(join(dist, 'ui.js')).length, 'bytes ui.js');
