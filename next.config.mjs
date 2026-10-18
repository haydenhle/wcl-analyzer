/** @type {import('next').NextConfig} */
const nextConfig = {
  // recharts' ResponsiveContainer measures its container via ResizeObserver
  // on mount; React 18 Strict Mode's dev-only mount->unmount->remount cycle
  // can leave that observer never firing, so charts render blank in `next
  // dev` (production builds are unaffected, since Strict Mode's double-
  // invoke is dev-only). Worth revisiting if recharts ships a fix upstream.
  reactStrictMode: false,
};

export default nextConfig;
