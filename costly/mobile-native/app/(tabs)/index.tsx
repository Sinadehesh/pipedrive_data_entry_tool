import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, fonts, radius, spacing } from '@/theme/tokens';

/**
 * Burn (home) — S6 builds the real thing: product-fill graphic, cap bar,
 * per-app chips, status banner. This is the S1 placeholder shell.
 */
export default function BurnScreen() {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.statusBanner}>
        <Text style={styles.statusText}>ARMED</Text>
      </View>

      <View style={styles.meterCard}>
        <Text style={styles.meterPercent}>0.0%</Text>
        <Text style={styles.meterLabel}>of your PlayStation, so far</Text>
        <Text style={styles.meterEuros}>€0.00</Text>
      </View>

      <Text style={styles.villainLine}>
        The meter is set. We're patient. We're always patient.
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing.md,
    gap: spacing.md,
  },
  statusBanner: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  statusText: {
    color: colors.accent,
    fontFamily: fonts.mono,
    fontSize: 14,
    letterSpacing: 4,
  },
  meterCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    padding: spacing.xl,
    alignItems: 'center',
    gap: spacing.sm,
  },
  meterPercent: {
    color: colors.text,
    fontFamily: fonts.mono,
    fontSize: 64,
  },
  meterLabel: {
    color: colors.textSecondary,
    fontFamily: fonts.text,
    fontSize: 14,
  },
  meterEuros: {
    color: colors.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 16,
  },
  villainLine: {
    color: colors.textSecondary,
    fontFamily: fonts.text,
    fontSize: 14,
    textAlign: 'center',
    fontStyle: 'italic',
  },
});
