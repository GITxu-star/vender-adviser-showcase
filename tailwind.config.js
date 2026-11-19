/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 墨绿系（高饱和 + 白字对比度充分）
        mint: {
          50:  '#eaf7ef',
          100: '#cdecd8',
          200: '#9fd9b2',
          300: '#6cbf89',
          400: '#3da468',
          500: '#1f7a44',   // ← 主按钮：高饱和墨绿
          600: '#176338',   // ← hover
          700: '#114d2c',   // ← pressed
        },
        // 鼠尾草灰绿（辅助色）
        sage: {
          50:  '#f4f8f5',
          100: '#e4efea',
          200: '#cbdfd4',
          300: '#a6c9b4',
          400: '#7fb092',
        },
        // 主题主色：深薄荷（按钮强调）
        forest: {
          DEFAULT: '#1c7a47',
          hover:   '#155f38',
          dark:    '#0f3e23',
        },
        // 奶油白（更柔和的背景白）
        cream: {
          50:  '#fdfdfb',
          100: '#f8f7f2',
        },
      },
      borderRadius: {
        '3xl': '1.5rem',
        '4xl': '2rem',
      },
      boxShadow: {
        'soft':   '0 2px 12px -4px rgba(45, 138, 83, 0.08), 0 1px 3px -1px rgba(0,0,0,0.04)',
        'card':   '0 4px 20px -6px rgba(45, 138, 83, 0.10), 0 2px 6px -2px rgba(0,0,0,0.05)',
        'float':  '0 12px 32px -8px rgba(45, 138, 83, 0.18), 0 4px 10px -4px rgba(0,0,0,0.06)',
        'pop':    '0 6px 24px -4px rgba(45, 138, 83, 0.25), 0 2px 6px -1px rgba(0,0,0,0.06)',
        'inner-soft': 'inset 0 2px 4px 0 rgba(45, 138, 83, 0.06)',
      },
      fontFamily: {
        'sans': ['-apple-system', 'BlinkMacSystemFont', '"PingFang SC"', '"Hiragino Sans GB"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        'float-slow': {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%':      { transform: 'translateY(-6px)' },
        },
        'blob': {
          '0%, 100%': { borderRadius: '60% 40% 30% 70% / 60% 30% 70% 40%' },
          '50%':      { borderRadius: '30% 60% 70% 40% / 50% 60% 30% 60%' },
        },
      },
      animation: {
        'float-slow': 'float-slow 4s ease-in-out infinite',
        'blob': 'blob 14s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
