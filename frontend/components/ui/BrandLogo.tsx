import { Image, StyleSheet, Text, View } from 'react-native';
import { Colors, FontSize } from '../../constants/theme';

export default function BrandLogo() {
  return (
    <View style={styles.row}>
      <View style={styles.badge}>
        <Image
          source={require('../../assets/images/favicon.png')}
          style={styles.icon}
        />
      </View>
      <Text style={styles.pamoja}>Pamoja</Text>
      <Text style={styles.hub}>Hub</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  badge: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  icon: {
    width: 30,
    height: 30,
    borderRadius: 15,
  },
  pamoja: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.white,
  },
  hub: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.accent,
  },
});
