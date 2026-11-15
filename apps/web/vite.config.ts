import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { localSetup } from './scripts/local-setup.ts'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ['AIXAND_', 'INTESSIO_'])
  return {
    plugins: [react(), {
      name: 'local-password-setup',
      configureServer(server) { server.middlewares.use(localSetup) },
      configurePreviewServer(server) { server.middlewares.use(localSetup) },
    }],
    build: { rollupOptions: { input: { main: resolve('index.html'), recovery: resolve('recovery.html') } } },
    server: {
      // Generated browser reports must not reload a running workspace.
      watch: { ignored: ['**/artifacts/**', '**/test-results/**', '**/src-tauri/**'] },
      proxy: {
        '/api': {
          target:
            process.env.AIXAND_SERVER_URL ??
            env.AIXAND_SERVER_URL ??
            process.env.INTESSIO_SERVER_URL ??
            env.INTESSIO_SERVER_URL ??
            'http://127.0.0.1:3000',
          ws: true,
        },
      },
    },
  }
})
