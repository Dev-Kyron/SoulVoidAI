/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        void: {
          900: '#05060f',
          800: '#0a0c1c',
          700: '#11132b',
          600: '#1a1d3d',
          500: '#262a52'
        },
        plasma: {
          cyan: '#22d3ee',
          violet: '#7c3aed',
          magenta: '#d946ef',
          green: '#34d399',
          amber: '#fbbf24',
          rose: '#fb7185'
        }
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace']
      },
      boxShadow: {
        glow: '0 0 24px -2px rgba(124, 58, 237, 0.55)',
        'glow-cyan': '0 0 28px -4px rgba(34, 211, 238, 0.6)',
        panel: '0 24px 60px -12px rgba(0, 0, 0, 0.7)'
      },
      backdropBlur: {
        xs: '2px'
      },
      keyframes: {
        'orb-float': {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-6px)' }
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' }
        },
        // Used by the Nexus rolling-line preview: each sentence rolls up
        // from below and fades in so the teleprompter ticks over cleanly
        // rather than swapping instantaneously.
        'nexus-roll': {
          '0%': { transform: 'translateY(6px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' }
        }
      },
      animation: {
        'orb-float': 'orb-float 4s ease-in-out infinite',
        shimmer: 'shimmer 2.4s linear infinite',
        'nexus-roll': 'nexus-roll 220ms ease-out'
      }
    }
  },
  plugins: []
}
