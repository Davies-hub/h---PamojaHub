import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';

export interface OTPInputRef {
  focus: () => void;
}

interface OTPInputProps {
  value: string[];
  onChange: (newValue: string[]) => void;
  onComplete?: (code: string) => void;
  disabled?: boolean;
}

const OTPInput = forwardRef<OTPInputRef, OTPInputProps>(
  ({ value, onChange, onComplete, disabled = false }, ref) => {
    const [focusedIdx, setFocusedIdx] = useState<number | null>(null);
    const inputRefs = useRef<(TextInput | null)[]>([null, null, null, null, null, null]);

    useImperativeHandle(ref, () => ({
      focus: () => inputRefs.current[0]?.focus(),
    }));

    function handleChange(idx: number, val: string) {
      const digit = val.replace(/[^0-9]/g, '').slice(-1);
      const next = [...value];
      next[idx] = digit;
      onChange(next);
      if (digit && idx < 5) {
        inputRefs.current[idx + 1]?.focus();
      }
      if (digit && idx === 5 && next.every(d => d !== '')) {
        onComplete?.(next.join(''));
      }
    }

    function handleKeyPress(idx: number, key: string) {
      if (key !== 'Backspace') return;
      if (value[idx]) {
        const next = [...value];
        next[idx] = '';
        onChange(next);
      } else if (idx > 0) {
        const next = [...value];
        next[idx - 1] = '';
        onChange(next);
        inputRefs.current[idx - 1]?.focus();
      }
    }

    return (
      <View style={styles.row}>
        {value.map((digit, idx) => (
          <TextInput
            key={idx}
            ref={el => { inputRefs.current[idx] = el; }}
            style={[
              styles.box,
              digit ? styles.boxFilled : null,
              focusedIdx === idx && styles.boxFocused,
            ]}
            value={digit}
            onChangeText={v => handleChange(idx, v)}
            onKeyPress={({ nativeEvent }) => handleKeyPress(idx, nativeEvent.key)}
            onFocus={() => setFocusedIdx(idx)}
            onBlur={() => setFocusedIdx(null)}
            keyboardType="number-pad"
            maxLength={1}
            textAlign="center"
            selectTextOnFocus
            caretHidden
            editable={!disabled}
            accessibilityLabel={`Digit ${idx + 1} of 6`}
          />
        ))}
      </View>
    );
  },
);

OTPInput.displayName = 'OTPInput';
export default OTPInput;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.sm,
  },
  box: {
    width: 48,
    height: 58,
    borderWidth: 2,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxl,
    color: Colors.text,
    backgroundColor: Colors.white,
    textAlign: 'center',
  },
  boxFilled: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryLight,
    color: Colors.primary,
  },
  boxFocused: {
    borderColor: Colors.primary,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 2,
  },
});
