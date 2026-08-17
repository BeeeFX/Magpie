import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve('src/shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        // La projection de la carte tourne dans un fil séparé : la construction du graphe de
        // voisins d'UMAP est atomique et figeait la fenêtre près de trois secondes. C'est le
        // seul calcul du projet qu'on ne peut pas découper, d'où sa propre entrée.
        input: {
          index: resolve('src/main/index.ts'),
          'projection.worker': resolve('src/main/tagging/projection.worker.ts')
        },
        output: { entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
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
