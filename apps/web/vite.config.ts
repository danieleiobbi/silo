import { fileURLToPath } from "node:url"
import { buildMetadata } from "../../scripts/version"
import { defineConfig } from "vite"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"

const metadata = buildMetadata(fileURLToPath(new URL("../../", import.meta.url)))

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(metadata.VITE_APP_VERSION),
    __BUILD_DATE__: JSON.stringify(metadata.VITE_BUILD_DATE)
  },
  plugins: [react(), tailwindcss()],
  server: { proxy: { "/api": "http://127.0.0.1:3000" } }
})
