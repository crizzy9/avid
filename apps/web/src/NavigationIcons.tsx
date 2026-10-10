/** Simple filled navigation shapes, drawn for Avid. */
export function LibraryGlyph({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="2" y="2" width="9" height="9" rx="2" />
      <rect x="13" y="2" width="9" height="9" rx="2" />
      <rect x="2" y="13" width="9" height="9" rx="2" />
      <rect x="13" y="13" width="9" height="9" rx="2" />
    </svg>
  );
}
export function BrowseGlyph({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="2" y="2" width="20" height="4" rx="1" />
      {[2, 9, 16].map((x) => (
        <rect key={x} x={x} y="8" width="6" height="7" rx="1" />
      ))}
      <rect x="2" y="17" width="9" height="5" rx="1" />
      <rect x="13" y="17" width="9" height="5" rx="1" />
    </svg>
  );
}
