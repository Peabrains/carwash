import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// The production site uses the custom domain at the origin root. Keep the
// project-page fallback for preview deployments, while allowing the Pages
// workflow to build with the root base path.
const base = process.env.VITE_BASE_PATH || (process.env.GITHUB_ACTIONS === 'true' ? '/carwash/' : '/');

export default defineConfig({
  base,
  plugins: [
    VitePWA({
      selfDestroying: true,
      registerType: 'autoUpdate',
      workbox: {
        navigateFallbackDenylist: []
      },
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
