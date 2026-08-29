import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve('src/shared')

export default defineConfig({
  main: {
    /* `umap-js` est embarqué dans le paquet plutôt que laissé en dépendance externe : le fil
       de projection est déballé hors de l'archive asar, et la résolution de modules depuis cet
       emplacement n'atteint aucun `node_modules`. Un fil autonome ne dépend pas d'où il vit. */
    plugins: [externalizeDepsPlugin({ exclude: ['umap-js'] })],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        // La projection de la carte tourne dans un fil séparé : la construction du graphe de
        // voisins d'UMAP est atomique et figeait la fenêtre près de trois secondes. C'est le
        // seul calcul du projet qu'on ne peut pas découper, d'où sa propre entrée.
        //
        // Les modèles, eux, vivent dans un `utilityProcess` : `onnxruntime-node` calcule de
        // façon synchrone, donc tant qu'il tournait ici, chaque encodage retenait la fenêtre.
        // Son point d'entrée reste dans l'archive asar — contrairement au fil de projection —
        // pour qu'il puisse y résoudre `@huggingface/transformers` et sa parenté.
        input: {
          index: resolve('src/main/index.ts'),
          'projection.worker': resolve('src/main/tagging/projection.worker.ts'),
          'inference.worker': resolve('src/main/tagging/inference.worker.ts')
        },
        output: { entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    /* `umap-js` est embarqué dans le paquet plutôt que laissé en dépendance externe : le fil
       de projection est déballé hors de l'archive asar, et la résolution de modules depuis cet
       emplacement n'atteint aucun `node_modules`. Un fil autonome ne dépend pas d'où il vit. */
    plugins: [externalizeDepsPlugin({ exclude: ['umap-js'] })],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    resolve: { alias: { '@shared': shared, '@': resolve('src/renderer/src') } },
    // Sert `fixtures/preview/` au serveur de dev pour l'aperçu navigateur. `copyPublicDir`
    // à false garde ces images de développement hors de la build packagée.
    publicDir: resolve('fixtures'),
    build: {
      copyPublicDir: false,
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
    }
  }
})
