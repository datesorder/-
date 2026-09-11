import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// בסיס הנתיב הזה נדרש כי GitHub Pages מגיש את הריפו datesorder/- תחת
// https://datesorder.github.io/-/ ולא תחת השורש (/).
export default defineConfig({
  base: '/-/',
  plugins: [react()],
});
