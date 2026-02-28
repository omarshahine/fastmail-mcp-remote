import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://omarshahine.github.io',
  base: '/fastmail-mcp-remote',
  output: 'static',
  integrations: [tailwind()],
});
