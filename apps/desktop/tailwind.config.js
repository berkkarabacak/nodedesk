/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        nd: {
          bg: 'var(--nd-bg)',
          surface: 'var(--nd-surface)',
          text: 'var(--nd-text)',
          dim: 'var(--nd-text-dim)',
          divider: 'var(--nd-divider)',
          rule: 'var(--nd-row-rule)',
          accent: 'var(--nd-accent)',
          'accent-strong': 'var(--nd-accent-strong)',
          'on-accent': 'var(--nd-on-accent)',
          danger: 'var(--nd-danger)',
          ok: 'var(--nd-ok)',
        },
      },
      fontFamily: {
        nd: ['Archivo', 'Segoe UI', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        // The design uses square corners.
        nd: '0px',
      },
    },
  },
  plugins: [],
}
