import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, fonts, radius, spacing } from '@/theme/tokens';

/**
 * Ledger — S7 builds the real thing: week table, settlement flow,
 * thank-you note, defeat states. This is the S1 placeholder shell.
 */
export default function LedgerScreen() {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.title}>The Ledger</Text>
        <Text style={styles.body}>
          Empty. For now. Every second you spend in a vice app ends up here,
          itemized, in writing, forever.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  title: {
    color: colors.text,
    fontFamily: fonts.textBold,
    fontSize: 20,
  },
  body: {
    color: colors.textSecondary,
    fontFamily: fonts.text,
    fontSize: 14,
    lineHeight: 20,
  },
});
