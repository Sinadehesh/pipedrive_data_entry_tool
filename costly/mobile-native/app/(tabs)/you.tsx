import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, fonts, radius, spacing } from '@/theme/tokens';

/**
 * You — S9 builds the real thing: rate & cap with asymmetric friction,
 * product anchors, vice list, quiet hours, self-exclusion, the villain's
 * lifetime ledger. This is the S1 placeholder shell.
 */
export default function YouScreen() {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.title}>You</Text>
        <Text style={styles.body}>
          Rate, cap, products, escape hatch. Settings arrive in Session 9.
          Until then, there is nothing to adjust — only consequences.
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
