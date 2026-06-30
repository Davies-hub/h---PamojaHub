import React from 'react';
import { View } from 'react-native';

interface Props {
  campaignId: string;
  walletBalance: number;
  portalToken: string;
  onSuccess: () => void;
}

export default function DisbursementRequestForm(_props: Props) {
  return <View />;
}
