import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://fastmail.omarknows.app',
  base: '/',
  output: 'static',
  integrations: [tailwind()],
});
