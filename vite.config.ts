import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { portraitsPlugin } from './scripts/vite-plugin-portraits'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), portraitsPlugin()],
  build: {
    assetsDir: 'assets'
  }
})
