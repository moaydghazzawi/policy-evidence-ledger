import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  ...(process.env.PEL_STATIC_EXPORT === '1'
    ? { output: 'export' as const }
    : {}),
  // Vinext checks multipart forms before API routing. Allow our 25 MB source
  // plus form fields here; the API separately enforces its stricter byte limit.
  experimental: { serverActions: { bodySizeLimit: '26mb' } },
};

export default nextConfig;
