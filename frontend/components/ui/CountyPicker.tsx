import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import {
  FlatList,
  Keyboard,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import ResponsiveSheet from './ResponsiveSheet';

// Fixed cap on the results list. ResponsiveSheet has no maxHeight of its own, and
// its narrow-mode keyboard lift is a marginBottom — it shifts the sheet up without
// shrinking it, so an unbounded 47-row list would be pushed off the TOP of the
// screen once the soft keyboard opens. A fixed value is deliberate: it is sized for
// the worst case (keyboard open) and is therefore trivially safe keyboard-closed.
// Do NOT swap this for a viewport percentage or a live height-minus-kbOffset
// calculation — both reintroduce the overflow this constant exists to prevent.
const LIST_MAX_HEIGHT = 340;

export const KENYA_COUNTIES = [
  'Mombasa', 'Kwale', 'Kilifi', 'Tana River', 'Lamu', 'Taita-Taveta',
  'Garissa', 'Wajir', 'Mandera', 'Marsabit', 'Isiolo', 'Meru',
  'Tharaka-Nithi', 'Embu', 'Kitui', 'Machakos', 'Makueni', 'Nyandarua',
  'Nyeri', 'Kirinyaga', "Murang'a", 'Kiambu', 'Turkana', 'West Pokot',
  'Samburu', 'Trans-Nzoia', 'Uasin Gishu', 'Elgeyo-Marakwet', 'Nandi',
  'Baringo', 'Laikipia', 'Nakuru', 'Narok', 'Kajiado', 'Kericho', 'Bomet',
  'Kakamega', 'Vihiga', 'Bungoma', 'Busia', 'Siaya', 'Kisumu', 'Homa Bay',
  'Migori', 'Kisii', 'Nyamira', 'Nairobi',
];

interface Props {
  value: string;
  onChange: (county: string) => void;
  error?: string;
  placeholder?: string;
}

export default function CountyPicker({
  value,
  onChange,
  error,
  placeholder = 'Select county',
}: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [kbOffset, setKbOffset] = useState(0);

  useEffect(() => {
    if (!open) { setKbOffset(0); return; }
    const show = Keyboard.addListener('keyboardDidShow', e => setKbOffset(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKbOffset(0));
    return () => { show.remove(); hide.remove(); };
  }, [open]);

  const filtered = search.trim()
    ? KENYA_COUNTIES.filter(c => c.toLowerCase().includes(search.toLowerCase()))
    : KENYA_COUNTIES;

  function close() {
    setOpen(false);
    setSearch('');
  }

  return (
    <>
      <TouchableOpacity
        style={[styles.trigger, error ? styles.triggerError : null]}
        onPress={() => setOpen(true)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Select county"
      >
        <Text style={value ? styles.value : styles.placeholder}>
          {value || placeholder}
        </Text>
        <Ionicons name="chevron-down" size={18} color={Colors.textMuted} />
      </TouchableOpacity>

      <ResponsiveSheet
        visible={open}
        onRequestClose={close}
        keyboardOffset={kbOffset}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Select County</Text>
          <TouchableOpacity
            onPress={close}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Close county picker"
          >
            <Ionicons name="close" size={24} color={Colors.text} />
          </TouchableOpacity>
        </View>

        <View style={styles.searchRow}>
          <Ionicons name="search-outline" size={16} color={Colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search county…"
            placeholderTextColor={Colors.textMuted}
            value={search}
            onChangeText={setSearch}
            accessibilityLabel="Search county"
          />
        </View>

        <FlatList
          style={styles.list}
          data={filtered}
          keyExtractor={item => item}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.item, item === value && styles.itemSelected]}
              onPress={() => { onChange(item); close(); }}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={item}
            >
              <Text style={[styles.itemText, item === value && styles.itemTextSelected]}>
                {item}
              </Text>
              {item === value
                ? <Ionicons name="checkmark" size={18} color={Colors.primary} />
                : null}
            </TouchableOpacity>
          )}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        />
      </ResponsiveSheet>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    height: 50,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.lg,
    paddingHorizontal: Spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.white,
  },
  triggerError: { borderColor: Colors.danger },
  value: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.base,
    color: Colors.text,
    flex: 1,
  },
  placeholder: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.base,
    color: Colors.textMuted,
    flex: 1,
  },
  // No overlay/sheet styles: ResponsiveSheet owns the scrim, the narrow bottom-sheet
  // and the wide centered max-480 card.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    // No paddingHorizontal/paddingTop — ResponsiveSheet's card already pads md on
    // every side; adding our own here would double-inset the title.
    paddingBottom: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  title: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.text,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    // No margin — ResponsiveSheet's card padding + its gap:sm supply the inset.
    paddingHorizontal: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    height: 44,
    gap: Spacing.sm,
  },
  searchInput: {
    flex: 1,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.base,
    color: Colors.text,
    height: '100%',
  },
  list: { maxHeight: LIST_MAX_HEIGHT },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  itemSelected: { backgroundColor: Colors.primaryLight },
  itemText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.base,
    color: Colors.text,
    flex: 1,
  },
  itemTextSelected: {
    fontFamily: 'Poppins-SemiBold',
    color: Colors.primary,
  },
});
