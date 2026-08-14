import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'

async function main(): Promise<void> {
  const server = await createServer({
    root: resolve('src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@': resolve('src/renderer/src')
      }
    },
    publicDir: resolve('fixtures'),
    server: { host: '127.0.0.1', port: 5173, strictPort: true }
  })
  await server.listen()
  server.printUrls()
}

void main()
