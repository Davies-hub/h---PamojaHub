import React, { useState } from 'react';
import { Image, ImageProps, ImageStyle, StyleProp } from 'react-native';

interface RemoteImageProps {
  // The remote URL. Undefined/empty (pre-upload rows) → render the fallback.
  uri?: string;
  style?: StyleProp<ImageStyle>;
  resizeMode?: ImageProps['resizeMode'];
  // The synthetic placeholder shown when there is no url, or when the url fails
  // to load (a dead URL renders this, never a broken-image icon).
  fallback: React.ReactNode;
}

// Thin house-style wrapper (RN Image, per register.tsx). Shows a real remote
// image when a url exists and loads; otherwise the caller's existing placeholder.
export default function RemoteImage({ uri, style, resizeMode, fallback }: RemoteImageProps) {
  // error must not latch across URI changes — a once-failed component would ignore
  // every future valid image (caused the phone 'stale logo' symptom 2026-07-17).
  // The failure is keyed to the uri it happened for, so a changed uri is a fresh
  // attempt by construction (synchronous — no fallback flash while an effect resets).
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const errored = uri !== undefined && uri === failedUri;

  if (!uri || errored) {
    return <>{fallback}</>;
  }

  return (
    <Image
      source={{ uri }}
      style={style}
      resizeMode={resizeMode}
      onError={() => setFailedUri(uri)}
    />
  );
}
