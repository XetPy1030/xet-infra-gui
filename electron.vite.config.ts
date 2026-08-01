import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const alias = {
  '@core': resolve('src/core'),
  '@shared': resolve('src/shared')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias }
  },
  preload: {
    // Sandboxed preload обязан быть единым CJS-файлом без внешних require
    // (импортирует только electron + константы из shared, которые бандлятся).
    build: {
      rollupOptions: {
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    },
    resolve: { alias }
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: { ...alias, '@renderer': resolve('src/renderer/src') }
    }
  }
})
