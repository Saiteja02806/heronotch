import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const includeDemo = process.env.NOTCH_INCLUDE_DEMO === '1' && existsSync(resolve('demo'))
const demoDir = resolve(includeDemo ? 'demo' : 'src/demo-stub')
const demoDefine = {
  __NOTCH_INCLUDE_DEMO__: JSON.stringify(includeDemo)
}

export default defineConfig({
  main: {
    define: demoDefine,
    resolve: {
      alias: {
        '@demo': demoDir,
        '@shared': resolve('src/shared')
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    define: demoDefine,
    resolve: {
      alias: {
        '@demo': demoDir,
        '@shared': resolve('src/shared')
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    define: demoDefine,
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
        '@demo': demoDir
      }
    },
    plugins: [react()]
  }
})
