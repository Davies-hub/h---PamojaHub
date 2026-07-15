import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import {
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';

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

      <Modal
        visible={open}
        animationType="slide"
        transparent
        onRequestClose={close}
      >
        <View style={styles.overlay}>
          <View style={styles.sheet}>
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
          </View>
        </View>
      </Modal>
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
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Colors.white,
    borderTopLeftRadius: BorderRadius.xl,
    borderTopRightRadius: BorderRadius.xl,
    maxHeight: '80%',
    paddingBottom: Spacing.xl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
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
    margin: Spacing.md,
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
