/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        theme: {
          bg: 'var(--ps-bg)',
          surface: 'var(--ps-surface)',
          'surface-border': 'var(--ps-surface-border)',
          'surface-hover': 'var(--ps-surface-hover)',
          text: 'var(--ps-text)',
          muted: 'var(--ps-text-muted)',
          faint: 'var(--ps-text-faint)',
          primary: 'var(--ps-primary)',
          'primary-hover': 'var(--ps-primary-hover)',
          accent: 'var(--ps-accent)',
          border: 'var(--ps-border)',
          'input-bg': 'var(--ps-input-bg)',
          'input-border': 'var(--ps-input-border)',
          tag: 'var(--ps-tag)',
          'tag-text': 'var(--ps-tag-text)',
          card: 'var(--ps-card-bg)',
          'card-border': 'var(--ps-card-border)',
          'card-hover': 'var(--ps-card-hover)',
          header: 'var(--ps-header-bg)',
          footer: 'var(--ps-footer-bg)',
        },
      },
      fontFamily: {
        heading: 'var(--ps-font-heading)',
        body: 'var(--ps-font-body)',
        mono: 'var(--ps-font-mono)',
      },
      fontSize: {
        'heading-scale': 'calc(1em * var(--ps-heading-scale, 1))',
        'body-scale': 'calc(1em * var(--ps-body-scale, 1))',
      },
    },
  },
  plugins: [],
};
