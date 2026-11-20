import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

const base = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"

/** The shipped page runs only its own bundled script. Vite's dev server needs a little more. */
function csp(): Plugin {
  let dev = false
  return {
    name: 'csp',
    configResolved(config) {
      dev = config.command === 'serve'
    },
    transformIndexHtml(html) {
      const policy = dev
        ? `${base}; script-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:*`
        : `${base}; script-src 'self'`
      return html.replace('%CSP%', policy)
    }
  }
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: { plugins: [react(), csp()] }
})
