import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 把前端的 /api/chat 请求转发给本地 FastAPI 后端
    proxy: {
      '/api/chat': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/api/process': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
