/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          green: '#00c851',
          red: '#ff4444',
          yellow: '#ffbb33',
          blue: '#2196f3',
          dark: '#0d1117',
          card: '#161b22',
          border: '#30363d',
          muted: '#8b949e',
        },
      },
    },
  },
  plugins: [],
};
