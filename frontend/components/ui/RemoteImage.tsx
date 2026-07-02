import React, { useEffect, useState } from 'react';
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
  const [errored, setErrored] = useState(false);

  // A new uri is a fresh attempt — clear any prior load failure.
  useEffect(() => {
    setErrored(false);
  }, [uri]);

  if (!uri || errored) {
    return <>{fallback}</>;
  }

  return (
    <Image
      source={{ uri }}
      style={style}
      resizeMode={resizeMode}
      onError={() => setErrored(true)}
    />
  );
}
