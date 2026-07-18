/**
 * COSTLY design tokens — the only source of visual truth.
 * Dark only. If a color isn't here, it doesn't exist.
 */

export const colors = {
  /** App background */
  bg: '#0B0D0A',
  /** Cards, sheets, tab bar */
  surface: '#151812',
  /** Money-green: primary accent, CTAs, the villain's colors */
  accent: '#2EDB6A',
  /** Red-orange: the burn meter ONLY. Never decorate with this. */
  burn: '#FF3B2F',
  /** Gold: defeat states — user victories over the villain */
  gold: '#F5B940',
  /** Primary text */
  text: '#F2F4EF',
  /** Secondary text */
  textSecondary: '#98A090',
} as const;

export const radius = {
  card: 16,
} as const;

/**
 * ALL numbers render in mono — the meter must feel like a taxi meter /
 * stock ticker. Text is Inter (loaded in app/_layout.tsx).
 */
export const fonts = {
  mono: 'monospace',
  text: 'Inter_400Regular',
  textSemiBold: 'Inter_600SemiBold',
  textBold: 'Inter_700Bold',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;
