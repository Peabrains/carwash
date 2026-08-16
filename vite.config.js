import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const base = process.env.GITHUB_ACTIONS === 'true' ? '/carwash/' : '/';

export default defineConfig({
  base,
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Wash Point',
        short_name: 'WashPoint',
        description: 'Book a car wash slot in seconds',
        theme_color: '#1C6E8C',
        background_color: '#F4F7F6',
        display: 'standalone',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      }
    })
  ]
});
