import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { Colors } from '../../constants/theme';

interface ProgressBarProps {
  raised: number;
  goal: number;
  height?: number;
  showLabels?: boolean;
}

function ProgressBar({ raised, goal, height = 6, showLabels = true }: ProgressBarProps) {
  const percent = goal > 0 ? Math.min(Math.round((raised / goal) * 100), 100) : 0;
  const animatedWidth = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(animatedWidth, {
      toValue: percent,
      duration: 600,
      useNativeDriver: false,
    }).start();
  }, [percent]);

  const barRadius = Math.round(height / 2);

  return (
    <View>
      <View style={[styles.track, { height, borderRadius: barRadius }]}>
        <Animated.View
          style={[
            styles.fill,
            {
              height,
              borderRadius: barRadius,
              width: animatedWidth.interpolate({
                inputRange: [0, 100],
                outputRange: ['0%', '100%'],
              }),
            },
          ]}
        />
      </View>
      {showLabels && (
        <View style={styles.labelRow}>
          <Text style={styles.amountText}>KES {raised.toLocaleString()}</Text>
          <Text style={styles.percentText}>{percent}%</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    backgroundColor: Colors.progressTrack,
    overflow: 'hidden',
  },
  fill: {
    backgroundColor: Colors.accent,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  amountText: {
    fontFamily: 'Poppins-Regular',
    fontSize: 11,
    color: Colors.textSecondary,
  },
  percentText: {
    fontFamily: 'Poppins-Medium',
    fontSize: 11,
    color: Colors.accent,
  },
});

export default React.memo(ProgressBar);
